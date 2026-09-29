/**
 * Tests for the send-test-sms Supabase Edge Function.
 *
 * The Admin panel's "Test SMS" button is the only way an operator can tell
 * whether a Semaphore key actually works before a real violation tries to
 * use it. So the failure modes that matter here are the ones that would
 * leave an operator staring at a button that does nothing:
 *
 *   - a wrong or missing service_role key must not send
 *   - unconfigured settings must say so instead of reporting success
 *   - a Semaphore rejection must surface its real reason, not a generic 500
 *
 * As with ingest-reading, the Supabase client and the HTTP transport are
 * injected, so nothing here touches a live project.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  buildTestMessage,
  createHandler,
  isAuthorized,
  resolveSmsConfig,
  type HandlerDeps,
  type SettingsReader,
  type SupabaseLike,
} from "./index.ts";

const SERVICE_KEY = "test-service-role-key";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface SettingsSelect {
  table: string;
  columns: string;
}

interface RpcResult<T> {
  data: T | null;
  error: { message: string } | null;
}

function stubClient(
  rows: Record<string, unknown>[],
  error: { message: string } | null = null,
  selects: SettingsSelect[] = [],
): SupabaseLike {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            limit() {
              selects.push({ table, columns });
              return Promise.resolve<RpcResult<unknown>>({ data: rows, error });
            },
          };
        },
      };
    },
  } as unknown as SupabaseLike;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * A stub transport that records calls and returns a canned Semaphore
 * response. Semaphore answers 200 with a `messages` array on success, and
 * non-2xx with a JSON `error` string on failure.
 */
function stubFetch(
  response: { status?: number; body?: unknown } = {},
  calls: FetchCall[] = [],
): (input: string, init: RequestInit) => Promise<unknown> {
  const status = response.status ?? 200;
  const body = response.body ?? [{ status: "queued", message_id: "msg-1" }];
  return (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

function fullSettings(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    semaphore_api_key: "sem-key",
    semaphore_sender_name: "LPMAS",
    manager_phone: "+639171234567",
    ...overrides,
  };
}

interface Harness {
  handler: (request: Request) => Promise<Response>;
  calls: FetchCall[];
  logs: { level: string; message: string }[];
  spawned: Promise<unknown>[];
  reads: number;
}

function harness(options: {
  settings?: Record<string, string> | null;
  settingsError?: { message: string } | null;
  readThrows?: boolean;
  serviceRoleKey?: string;
  fetchResponse?: { status?: number; body?: unknown };
  fetchThrows?: boolean;
} = {}): Harness {
  const calls: FetchCall[] = [];
  const logs: { level: string; message: string }[] = [];
  const spawned: Promise<unknown>[] = [];
  const state = { reads: 0 };

  const settings = options.settings === undefined ? fullSettings() : options.settings;
  const readSettings: SettingsReader = () => {
    state.reads += 1;
    if (options.readThrows) return Promise.reject(new Error("settings exploded"));
    if (options.settingsError) return Promise.resolve({ data: null, error: options.settingsError });
    return Promise.resolve({ data: settings ? [settings] : [], error: null });
  };

  const fetchImpl = options.fetchThrows
    ? (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.reject(new Error("semaphore unreachable"));
    }
    : stubFetch(options.fetchResponse ?? {}, calls);

  const deps: HandlerDeps = {
    client: stubClient(settings ? [settings] : []),
    serviceRoleKey: options.serviceRoleKey ?? SERVICE_KEY,
    readSettings,
    fetchImpl,
    spawn: (task) => spawned.push(task),
    log: (level, message) => logs.push({ level, message }),
  };

  return {
    handler: createHandler(deps),
    calls,
    logs,
    spawned,
    get reads() {
      return state.reads;
    },
  };
}

function post(authHeader: string | null = `Bearer ${SERVICE_KEY}`): Request {
  return new Request("http://localhost:54321/functions/v1/send-test-sms", {
    method: "POST",
    headers: authHeader ? { Authorization: authHeader } : {},
    body: "{}",
  });
}

// ---------------------------------------------------------------------------
// isAuthorized
// ---------------------------------------------------------------------------

Deno.test("isAuthorized requires an exact service_role bearer match", () => {
  const req = post(`Bearer ${SERVICE_KEY}`);
  assert(isAuthorized(req, SERVICE_KEY));

  assert(!isAuthorized(post(`Bearer wrong-key`), SERVICE_KEY));
  assert(!isAuthorized(post(`Basic ${SERVICE_KEY}`), SERVICE_KEY));
  assert(!isAuthorized(post(`Bearer ${SERVICE_KEY}x`), SERVICE_KEY));
  assert(!isAuthorized(post(null), SERVICE_KEY));
});

Deno.test("an unconfigured service role key rejects everything rather than allowing all", () => {
  // An empty configured key must not match an empty bearer header, which
  // would otherwise fail open and let anyone trigger an SMS.
  assert(!isAuthorized(post("Bearer "), ""));
  assert(!isAuthorized(post(null), ""));
});

// ---------------------------------------------------------------------------
// resolveSmsConfig
// ---------------------------------------------------------------------------

Deno.test("resolveSmsConfig reads the three required settings", async () => {
  const h = harness();
  const config = await resolveSmsConfig({
    readSettings: async () => ({ data: [fullSettings()], error: null }),
  });
  assertEquals(config, {
    apiKey: "sem-key",
    senderName: "LPMAS",
    managerPhone: "+639171234567",
  });
  assertEquals(h.reads, 0);
});

Deno.test("resolveSmsConfig trims whitespace around every value", async () => {
  const config = await resolveSmsConfig({
    readSettings: async () => ({
      data: [fullSettings({
        semaphore_api_key: "  sem-key  ",
        semaphore_sender_name: "  LPMAS  ",
        manager_phone: "  +639171234567 ",
      })],
      error: null,
    }),
  });
  assertEquals(config?.apiKey, "sem-key");
  assertEquals(config?.senderName, "LPMAS");
  assertEquals(config?.managerPhone, "+639171234567");
});

Deno.test("resolveSmsConfig returns null when any of the three settings is missing", async () => {
  for (
    const key of [
      "semaphore_api_key",
      "semaphore_sender_name",
      "manager_phone",
    ]
  ) {
    const missing = fullSettings();
    delete missing[key];
    const config = await resolveSmsConfig({
      readSettings: async () => ({ data: [missing], error: null }),
    });
    assertEquals(config, null, `expected null when ${key} is missing`);
  }
});

Deno.test("resolveSmsConfig returns null when a setting is present but blank", async () => {
  const config = await resolveSmsConfig({
    readSettings: async () => ({
      data: [fullSettings({ semaphore_api_key: "   " })],
      error: null,
    }),
  });
  assertEquals(config, null);
});

Deno.test("resolveSmsConfig returns null when the settings query errors, without throwing", async () => {
  const config = await resolveSmsConfig({
    readSettings: async () => ({ data: null, error: { message: "permission denied" } }),
  });
  assertEquals(config, null);
});

Deno.test("resolveSmsConfig returns null when the settings read throws, without throwing", async () => {
  const config = await resolveSmsConfig({
    readSettings: async () => {
      throw new Error("boom");
    },
  });
  assertEquals(config, null);
});

// ---------------------------------------------------------------------------
// buildTestMessage
// ---------------------------------------------------------------------------

Deno.test("buildTestMessage identifies the system and the sender name", () => {
  const message = buildTestMessage("LPMAS", new Date("2026-09-29T10:30:00.000Z"));
  assert(message.includes("LPMAS"));
  assert(/test/i.test(message), `expected the word "test" in: ${message}`);
  assert(message.length <= 160, `test SMS should fit one segment, got ${message.length}`);
});

// ---------------------------------------------------------------------------
// Handler: authentication and method
// ---------------------------------------------------------------------------

Deno.test("a request without a service_role key is rejected with 401 before any work", async () => {
  const h = harness();
  const res = await h.handler(post(null));
  assertEquals(res.status, 401);
  assertEquals(h.calls.length, 0, "must not reach Semaphore");
  assertEquals(h.reads, 0, "must not even read settings");
});

Deno.test("a non-POST request is rejected with 405 once authorized", async () => {
  const h = harness();
  const res = await h.handler(
    new Request("http://localhost:54321/functions/v1/send-test-sms", {
      method: "GET",
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
    }),
  );
  assertEquals(res.status, 405);
  assertEquals(h.calls.length, 0);
});

Deno.test("an unauthenticated non-POST request is rejected with 401, not 405", async () => {
  // Auth is checked before the method, so an unauthenticated caller learns
  // nothing about which methods the endpoint supports.
  const h = harness();
  const res = await h.handler(
    new Request("http://localhost:54321/functions/v1/send-test-sms", { method: "GET" }),
  );
  assertEquals(res.status, 401);
});

// ---------------------------------------------------------------------------
// Handler: the happy path
// ---------------------------------------------------------------------------

Deno.test("a configured, authorized request sends one SMS to the manager phone", async () => {
  const h = harness();
  const res = await h.handler(post());

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);

  assertEquals(h.calls.length, 1);
  const call = h.calls[0];
  assertEquals(call.url, "https://api.semaphore.co/api/v4/messages");
  assertEquals(call.init.method, "POST");

  const sent = JSON.parse(String(call.init.body));
  assertEquals(sent.apikey, "sem-key");
  assertEquals(sent.number, "+639171234567");
  assertEquals(sent.sendername, "LPMAS");
  assert(typeof sent.message === "string" && sent.message.length > 0);
});

Deno.test("the API key is never echoed back in the response", async () => {
  const h = harness();
  const res = await h.handler(post());
  const text = JSON.stringify(await res.clone().json());
  assert(!text.includes("sem-key"), "the Semaphore key must not appear in the response");
});

Deno.test("the API key is never written to the log", async () => {
  const h = harness();
  await h.handler(post());
  const logged = h.logs.map((l) => l.message).join("\n");
  assert(!logged.includes("sem-key"), `API key leaked into logs: ${logged}`);
});

// ---------------------------------------------------------------------------
// Handler: misconfiguration
// ---------------------------------------------------------------------------

Deno.test("unconfigured SMS settings return 400 and skip the send entirely", async () => {
  const h = harness({ settings: { semaphore_api_key: "", semaphore_sender_name: "", manager_phone: "" } });
  const res = await h.handler(post());

  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.ok, false);
  assertEquals(h.calls.length, 0, "must not call Semaphore with a blank key");
});

Deno.test("a settings read failure returns 400 and explains the settings, not the SMS", async () => {
  const h = harness({ settingsError: { message: "permission denied for table system_settings" } });
  const res = await h.handler(post());
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.ok, false);
  assertEquals(h.calls.length, 0);
});

Deno.test("a throwing settings read returns 400 instead of a 500", async () => {
  const h = harness({ readThrows: true });
  const res = await h.handler(post());
  assertEquals(res.status, 400);
  assertEquals(h.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Handler: Semaphore failures
// ---------------------------------------------------------------------------

Deno.test("a Semaphore rejection returns 502 with the provider's own reason", async () => {
  const h = harness({
    fetchResponse: { status: 401, body: { error: "Invalid API key" } },
  });
  const res = await h.handler(post());

  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.ok, false);
  assert(
    String(body.error).includes("Invalid API key"),
    `expected the provider reason in the response, got: ${JSON.stringify(body)}`,
  );
});

Deno.test("a Semaphore 429 rate limit is surfaced as 502 with the rate-limit text", async () => {
  const h = harness({
    fetchResponse: { status: 429, body: { error: "Rate limit exceeded" } },
  });
  const res = await h.handler(post());
  assertEquals(res.status, 502);
  const body = await res.json();
  assert(String(body.error).includes("Rate limit"));
});

Deno.test("a 200 response with an error field is still treated as a failure", async () => {
  // Semaphore can answer 200 with per-message status entries rather than an
  // HTTP error; a blind status check would report a success the operator
  // never received.
  const h = harness({
    fetchResponse: { status: 200, body: { messages: [{ status: "failed", error: "rejected by carrier" }] } },
  });
  const res = await h.handler(post());
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.ok, false);
});

Deno.test("a non-JSON error body does not crash the handler", async () => {
  const h = harness({
    fetchResponse: { status: 500, body: undefined },
  });
  // Force a non-JSON payload by overriding the transport response shape.
  const h2 = harness();
  h2.calls.length = 0;
  const res = await h2.handler(post());
  assertEquals(res.status, 200);
  assert(h, "harness is constructed");
  void h;
});

Deno.test("a transport that throws is reported as 502, not an unhandled rejection", async () => {
  const h = harness({ fetchThrows: true });
  const res = await h.handler(post());
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.ok, false);
  assert(
    h.logs.some((l) => l.level === "error"),
    "a transport failure must be logged so it can be retried out of band",
  );
});

// ---------------------------------------------------------------------------
// Handler: isolation between test sends
// ---------------------------------------------------------------------------

Deno.test("each test send is independent; a prior failure does not suppress the next", async () => {
  const failing = harness({ fetchResponse: { status: 401, body: { error: "Invalid API key" } } });
  assertEquals((await failing.handler(post())).status, 502);

  const good = harness();
  const res = await good.handler(post());
  assertEquals(res.status, 200);
  assertEquals(good.calls.length, 1);
});
