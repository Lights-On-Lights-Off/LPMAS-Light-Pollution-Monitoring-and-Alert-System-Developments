/**
 * Tests for the send-test-sms Supabase Edge Function.
 *
 * The Admin panel's "Test SMS" button is the only way an operator can tell
 * whether a textbee key actually works before a real violation tries to
 * use it. So the failure modes that matter here are the ones that would
 * leave an operator staring at a button that does nothing:
 *
 *   - a wrong or missing service_role key must not send
 *   - unconfigured settings must say so instead of reporting success
 *   - a textbee rejection must surface its real reason, not a generic 500
 *
 * As with ingest-reading, the Supabase client and the HTTP transport are
 * injected, so nothing here touches a live project.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  buildTestMessage,
  createHandler,
  parseTestRecipient,
  readRecipientField,
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
 * A stub transport that records calls and returns a canned textbee
 * response. textbee answers 200 with a `messages` array on success, and
 * non-2xx with a JSON `error` string on failure.
 */
function stubFetch(
  response: { status?: number; body?: unknown; rawBody?: string } = {},
  calls: FetchCall[] = [],
): (input: string, init: RequestInit) => Promise<unknown> {
  const status = response.status ?? 200;
  const body = response.body ?? {data:{success:true,smsBatchId:"batch-1"}};
  return (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(response.rawBody ?? JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

function fullSettings(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    sms_provider: "textbee",
    textbee_api_key: "tb_key_value",
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
  fetchResponse?: { status?: number; body?: unknown; rawBody?: string };
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
      return Promise.reject(new Error("gateway unreachable"));
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

function post(authHeader: string | null = `Bearer ${SERVICE_KEY}`, body: string = "{}"): Request {
  return new Request("http://localhost:54321/functions/v1/send-test-sms", {
    method: "POST",
    headers: authHeader ? { Authorization: authHeader } : {},
    body,
  });
}

Deno.test("a missing backend key fails closed",async () => {
  const h=harness({serviceRoleKey:""});assertEquals((await h.handler(post())).status,401);assertEquals(h.calls.length,0);
});
Deno.test("anonymous and user JWT callers cannot send test SMS",async () => {
  for(const header of [null,"Bearer user-token","Bearer wrong-key"]) {
    const h=harness();assertEquals((await h.handler(post(header))).status,401);assertEquals(h.calls.length,0);
  }
});

// ---------------------------------------------------------------------------
// resolveSmsConfig
// ---------------------------------------------------------------------------

Deno.test("resolveSmsConfig reads the provider, key and recipient", async () => {
  const h = harness();
  const config = await resolveSmsConfig({
    readSettings: async () => ({ data: [fullSettings()], error: null }),
  });
  assertEquals(config, {
    provider: "textbee",
    apiKey: "tb_key_value",
    recipient: "+639171234567",
  });
  assertEquals(h.reads, 0);
});

Deno.test("resolveSmsConfig trims whitespace around every value", async () => {
  const config = await resolveSmsConfig({
    readSettings: async () => ({
      data: [fullSettings({
        textbee_api_key: "  tb_key_value  ",
        manager_phone: "  +639171234567 ",
      })],
      error: null,
    }),
  });
  assertEquals(config?.apiKey, "tb_key_value");
  assertEquals(config?.recipient, "+639171234567");
});

Deno.test("resolveSmsConfig returns null when the API key is missing", async () => {
  const missing = fullSettings();
  delete missing["textbee_api_key"];
  const config = await resolveSmsConfig({
    readSettings: async () => ({ data: [missing], error: null }),
  });
  assertEquals(config, null, "expected null when textbee_api_key is missing");
});

Deno.test("an unrecognised provider is refused rather than defaulted to one", async () => {
  // Defaulting would send a credential to a URL nobody chose.
  for (const provider of ["", "twilio", "semaphore", "TEXTBEE "]) {
    const config = await resolveSmsConfig({
      readSettings: async () => ({ data: [fullSettings({ sms_provider: provider })], error: null }),
    });
    assertEquals(config, null, `expected provider ${JSON.stringify(provider)} to be refused`);
  }
});

Deno.test("a blank sender name is not part of the configuration at all", async () => {
  // The gateway relays through the project's own prepaid SIM, so there is no
  // alphanumeric sender name to register or pay for. The earlier textbee
  // requirement for one is gone, along with the field.
  const config = await resolveSmsConfig({
    readSettings: async () => ({
      data: [fullSettings({ semaphore_sender_name: "LPMAS" })],
      error: null,
    }),
  });
  assertEquals(config?.apiKey, "tb_key_value", "a leftover sender name must not affect the config");
});

Deno.test("an unset manager phone still yields a usable config here", async () => {
  // The test path supplies its own recipient, so a blank saved phone must
  // not refuse the configuration outright.
  const config = await resolveSmsConfig({
    readSettings: async () => ({ data: [fullSettings({ manager_phone: "" })], error: null }),
  });
  assertEquals(config?.apiKey, "tb_key_value");
  assertEquals(config?.recipient, "");
});

Deno.test("resolveSmsConfig returns null when a setting is present but blank", async () => {
  const config = await resolveSmsConfig({
    readSettings: async () => ({
      data: [fullSettings({ textbee_api_key: "   " })],
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
  const message = buildTestMessage(new Date("2026-09-29T10:30:00.000Z"));
  assert(message.includes("LPMAS"));
  assert(/test/i.test(message), `expected the word "test" in: ${message}`);
  assert(message.length <= 160, `test SMS should fit one segment, got ${message.length}`);
});

// ---------------------------------------------------------------------------
// parseTestRecipient
// ---------------------------------------------------------------------------

Deno.test("a recipient typed with the Philippine prefix is accepted in its written forms", () => {
  assertEquals(parseTestRecipient("+639171234567"), { ok: true, number: "+639171234567", error: null });
  assertEquals(parseTestRecipient("+63 917 123 4567").number, "+639171234567");
  assertEquals(parseTestRecipient("  09171234567 ").number, "+639171234567");
  assertEquals(parseTestRecipient("9171234567").number, "+639171234567");
});

Deno.test("a recipient that is not ten digits after the country code is rejected with a reason", () => {
  // 0917 is the trunk prefix and the mobile number is 10 digits, so nine
  // digits is a typo that textbee would bill and silently drop.
  for (const value of ["+63917123456", "917123456", "", "   ", "+6391712345678"]) {
    const result = parseTestRecipient(value);
    assertEquals(result.ok, false, `expected "${value}" to be rejected`);
    assert(result.error !== null, `expected a reason for "${value}"`);
  }
});

Deno.test("a recipient from another country code is rejected rather than silently rewritten", () => {
  const result = parseTestRecipient("+14155552671");
  assertEquals(result.ok, false);
  assert(result.error !== null);
});

Deno.test("a missing recipient field is a reason to say so, not a crash", () => {
  assertEquals(parseTestRecipient(undefined), {
    ok: false,
    number: null,
    error: "No recipient supplied.",
  });
});

Deno.test("a body that is not a JSON object is reported as malformed, not ignored", () => {
  // Silently ignoring it would send to the stored manager phone instead,
  // which looks to the operator exactly like a dead SIM.
  for (const body of ["not json at all", "[1,2,3]", '"a string"', "42"]) {
    assertEquals(readRecipientField(body).malformed, true, `expected "${body}" to be malformed`);
  }

  // No body at all is a legitimate request: the stored phone is used.
  assertEquals(readRecipientField(""), { present: false, malformed: false, value: undefined });
  assertEquals(readRecipientField("{}"), { present: true, malformed: false, value: undefined });
  assertEquals(readRecipientField('{"to":"9171234567"}').value, "9171234567");
});

// ---------------------------------------------------------------------------
// Handler: authentication and method
// ---------------------------------------------------------------------------

Deno.test("a non-POST request is rejected with 405 and never reaches textbee", async () => {
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

Deno.test("the method check runs before any settings read, so a wrong verb is cheap", async () => {
  const h = harness();
  await h.handler(
    new Request("http://localhost:54321/functions/v1/send-test-sms", { method: "GET" }),
  );
  assertEquals(h.reads, 0, "must not read settings for a request it will refuse anyway");
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
  assertEquals(call.url, "https://api.textbee.dev/api/v1/gateway/send-sms");
  assertEquals(call.init.method, "POST");

  const sent = JSON.parse(String(call.init.body));
  assertEquals(sent.recipients, ["+639171234567"]);
  assert(typeof sent.message === "string" && sent.message.length > 0);
  assert(sent.message.length <= 160, "the test message must stay one billable segment");

  const headers = call.init.headers as Record<string, string>;
  assertEquals(headers["x-api-key"], "tb_key_value");
});

Deno.test("the API key is never echoed back in the response", async () => {
  const h = harness();
  const res = await h.handler(post());
  const text = JSON.stringify(await res.clone().json());
  assert(!text.includes("tb_key_value"), "the gateway key must not appear in the response");
});

Deno.test("the API key is never written to the log", async () => {
  const h = harness();
  await h.handler(post());
  const logged = h.logs.map((l) => l.message).join("\n");
  assert(!logged.includes("tb_key_value"), `API key leaked into logs: ${logged}`);
});

// ---------------------------------------------------------------------------
// Handler: misconfiguration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Handler: the recipient
// ---------------------------------------------------------------------------

Deno.test("a typed recipient overrides the stored manager phone", async () => {
  // This is the point of the change: an operator types their own number to
  // prove the line works, without waiting on a violation.
  const h = harness();
  const res = await h.handler(post(`Bearer ${SERVICE_KEY}`, JSON.stringify({ to: "9171234567" })));

  assertEquals(res.status, 200);
  const sent = JSON.parse(String(h.calls[0].init.body));
  assertEquals(sent.recipients, ["+639171234567"], "the typed number must win over the stored one");
});

Deno.test("with no typed recipient the stored manager phone is still used", async () => {
  const h = harness();
  const res = await h.handler(post());

  assertEquals(res.status, 200);
  const sent = JSON.parse(String(h.calls[0].init.body));
  assertEquals(sent.recipients, ["+639171234567"]);
});

Deno.test("an invalid typed recipient is rejected with 400 and sends nothing", async () => {
  const h = harness();
  const res = await h.handler(post(`Bearer ${SERVICE_KEY}`, JSON.stringify({ to: "12345" })));

  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.ok, false);
  assert(typeof body.error === "string" && body.error.length > 0);
  assertEquals(h.calls.length, 0, "must not send to a number known to be wrong");
});

Deno.test("a typed recipient works with no saved manager phone", async () => {
  // A manager phone is required for real violation alerts, but not for a
  // test: the whole point of the test button is to prove the line works
  // before anything is saved. Requiring a stored phone first meant the
  // button reported "not configured" while a perfectly good key sat in the
  // settings, which is the message that started all this.
  const h = harness({ settings: fullSettings({ manager_phone: "" }) });
  const res = await h.handler(post(`Bearer ${SERVICE_KEY}`, JSON.stringify({ to: "9171234567" })));

  assertEquals(res.status, 200, "a typed recipient must be enough");
  const sent = JSON.parse(String(h.calls[0].init.body));
  assertEquals(sent.recipients, ["+639171234567"]);
});

Deno.test("with no stored phone and no typed recipient, it says what is missing", async () => {
  const h = harness({ settings: fullSettings({ manager_phone: "" }) });
  const res = await h.handler(post());

  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.ok, false);
  assertEquals(h.calls.length, 0, "must not send anywhere");
  assert(
    /phone|recipient|manager/i.test(String(body.error)),
    `expected a message about the missing phone, got: ${body.error}`,
  );
});

Deno.test("a malformed body is a 400, not a 500", async () => {
  const h = harness();
  const res = await h.handler(post(`Bearer ${SERVICE_KEY}`, "not json at all"));

  assertEquals(res.status, 400);
  assertEquals(h.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Handler: misconfiguration
// ---------------------------------------------------------------------------

Deno.test("unconfigured SMS settings return 400 and skip the send entirely", async () => {
  const h = harness({ settings: fullSettings({ textbee_api_key: "", manager_phone: "" }) });
  const res = await h.handler(post());

  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.ok, false);
  assertEquals(h.calls.length, 0, "must not call textbee with a blank key");
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
// Handler: textbee failures
// ---------------------------------------------------------------------------

Deno.test("a textbee rejection returns 502 with the provider's own reason", async () => {
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

Deno.test("a textbee 429 rate limit is surfaced as 502 with the rate-limit text", async () => {
  const h = harness({
    fetchResponse: { status: 429, body: { error: "Rate limit exceeded" } },
  });
  const res = await h.handler(post());
  assertEquals(res.status, 502);
  const body = await res.json();
  assert(String(body.error).includes("Rate limit"));
});

Deno.test("a 200 response with an error field is still treated as a failure", async () => {
  // textbee can answer 200 with per-message status entries rather than an
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

Deno.test("a non-JSON error body is a 502 rather than a false success",async () => {
  const h=harness({fetchResponse:{status:500,rawBody:"<html>bad gateway</html>"}});
  assertEquals((await h.handler(post())).status,502);
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
