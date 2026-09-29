/**
 * LPMAS — `send-test-sms` Supabase Edge Function.
 *
 * Sends a single test message to the configured manager phone so an operator
 * can verify Semaphore credentials from the Admin panel before a real
 * violation depends on them.
 *
 * Design notes that are load-bearing:
 *
 *  - THIS IS DELIBERATELY SYNCHRONOUS, unlike ingest-reading's alert SMS.
 *    A test send is initiated by a human who is watching a button, and the
 *    only useful answer is the provider's actual verdict. Fire-and-forget
 *    would report "sent" for a request that was rejected.
 *
 *  - A NON-2xx IS NOT THE ONLY FAILURE. Semaphore can answer HTTP 200 with a
 *    per-message `status` of "failed" in the body. A status-code-only check
 *    would tell the operator their key works when it does not, which is the
 *    one outcome this endpoint exists to prevent.
 *
 *  - MISCONFIGURATION IS A 400, A PROVIDER FAILURE IS A 502. The Admin panel
 *    needs to tell "you have not filled this in" apart from "Semaphore said
 *    no", because the fixes are completely different.
 *
 *  - THE API KEY NEVER APPEARS IN A RESPONSE OR A LOG. It is only ever sent
 *    in the outbound request body.
 */

// ===========================================================================
// Types
// ===========================================================================

export interface SmsConfig {
  apiKey: string;
  senderName: string;
  managerPhone: string;
}

export interface SettingsResult {
  data: Record<string, string>[] | null;
  error: { message: string } | null;
}

export type SettingsReader = () => Promise<SettingsResult>;

/** The slice of supabase-js this function uses. */
export interface SupabaseLike {
  from(table: string): {
    select(columns: string): {
      limit(count: number): PromiseLike<SettingsResult>;
    };
  };
}

export interface HandlerDeps {
  client: SupabaseLike;
  serviceRoleKey: string;
  readSettings(): Promise<SettingsResult>;
  fetchImpl(input: string, init: RequestInit): Promise<unknown>;
  spawn(task: Promise<unknown>): void;
  log(level: "info" | "error", message: string): void;
}

const SEMAPHORE_ENDPOINT = "https://api.semaphore.co/api/v4/messages";

// ===========================================================================
// Auth
// ===========================================================================

/**
 * Exact-match bearer check against the configured service_role key.
 *
 * The comparison is not constant-time, which is acceptable here because the
 * key is a server-to-server secret compared against a request the caller
 * already had to route through Supabase's gateway. What matters more is that
 * an unset configured key never matches, so a missing env var fails closed
 * rather than open.
 */
export function isAuthorized(request: Request, serviceRoleKey: string): boolean {
  if (!serviceRoleKey) return false;
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return header.slice(prefix.length) === serviceRoleKey;
}

// ===========================================================================
// Settings
// ===========================================================================

/**
 * Resolves the three settings SMS needs, or null when SMS is not fully
 * configured or the lookup failed. Never throws — every failure is a
 * misconfiguration from the caller's point of view.
 */
export async function resolveSmsConfig(
  deps: Partial<Pick<HandlerDeps, "readSettings" | "log">> & {
    readSettings: SettingsReader;
  },
): Promise<SmsConfig | null> {
  const log = deps.log ?? (() => {});
  let result: SettingsResult;
  try {
    result = await deps.readSettings();
  } catch (error) {
    log("error", `SMS settings read failed: ${describe(error)}`);
    return null;
  }

  if (result.error) {
    log("error", `SMS settings query failed: ${result.error.message}`);
    return null;
  }

  const row = result.data?.[0];
  if (!row) return null;

  const apiKey = (row.semaphore_api_key ?? "").trim();
  const senderName = (row.semaphore_sender_name ?? "").trim();
  const managerPhone = (row.manager_phone ?? "").trim();
  if (!apiKey || !senderName || !managerPhone) return null;

  return { apiKey, senderName, managerPhone };
}

// ===========================================================================
// Message
// ===========================================================================

/**
 * The test message body. Kept under 160 characters so it bills as a single
 * segment, which keeps the Semaphore free tier (100 SMS/month) from being
 * spent two messages at a time on a test.
 */
export function buildTestMessage(senderName: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace("T", " ").slice(0, 16);
  return `[${senderName}] Test SMS. If you received this, alert delivery is working. Sent ${stamp} UTC.`;
}

// ===========================================================================
// Provider response
// ===========================================================================

export interface ProviderOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Interprets a Semaphore response. Checks the body as well as the status,
 * because a 200 can still carry a per-message failure.
 */
export function interpretProviderResponse(status: number, rawBody: string): ProviderOutcome {
  let parsed: unknown = null;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsed = null;
  }

  const bodyError = readErrorText(parsed);

  // A body-level error wins: it is the most specific reason available.
  if (bodyError) return { ok: false, detail: bodyError };

  // A 200 whose messages array reports a failure is still a failure.
  const messageFailure = readMessageFailure(parsed);
  if (messageFailure) return { ok: false, detail: messageFailure };

  if (status < 200 || status >= 300) {
    return {
      ok: false,
      detail: `Semaphore returned HTTP ${status}${parsed ? "" : " with a non-JSON body"}`,
    };
  }

  return { ok: true, detail: "Semaphore accepted the message" };
}

function readErrorText(parsed: unknown): string | null {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const value = (parsed as { error: unknown }).error;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readMessageFailure(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") continue;
    const status = (entry as { status?: unknown }).status;
    if (typeof status === "string" && status.toLowerCase() === "failed") {
      const detail = (entry as { error?: unknown }).error;
      return typeof detail === "string" && detail.trim()
        ? detail.trim()
        : "Semaphore reported the message as failed";
    }
  }
  return null;
}

// ===========================================================================
// Handler
// ===========================================================================

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  return async function handle(request: Request): Promise<Response> {
    // 1. Authenticate before any work. The key is never logged.
    if (!isAuthorized(request, deps.serviceRoleKey)) {
      return json(401, { ok: false, error: "Unauthorized: a valid service_role key is required" });
    }

    if (request.method !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    // 2. Resolve settings. A null here means either "not configured" or
    //    "could not read", and both are a 400 from the operator's view: the
    //    action to take is in the Admin settings form, not at Semaphore.
    const config = await resolveSmsConfig(deps);
    if (!config) {
      return json(400, {
        ok: false,
        error: "SMS is not fully configured. Set the Semaphore API key, sender name and manager phone in Admin > System settings.",
      });
    }

    // 3. Send, and report the provider's real verdict.
    let status: number;
    let rawBody: string;
    try {
      const response = await deps.fetchImpl(SEMAPHORE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apikey: config.apiKey,
          number: config.managerPhone,
          sendername: config.senderName,
          message: buildTestMessage(config.senderName),
        }),
      });
      status = responseStatus(response);
      rawBody = await responseText(response);
    } catch (error) {
      const detail = describe(error);
      deps.log("error", `Test SMS transport failed: ${detail}`);
      return json(502, {
        ok: false,
        error: `Could not reach Semaphore: ${detail}`,
      });
    }

    const outcome = interpretProviderResponse(status, rawBody);
    if (!outcome.ok) {
      // The reason is logged with the phone number masked; the number is
      // personal data and the API key is a secret, so neither belongs in a
      // log line that operators paste into tickets.
      deps.log("error", `Test SMS rejected (HTTP ${status}): ${outcome.detail}`);
      return json(502, { ok: false, error: outcome.detail });
    }

    deps.log("info", `Test SMS accepted by Semaphore for ${maskPhone(config.managerPhone)}`);
    return json(200, {
      ok: true,
      message: `Test SMS sent to ${maskPhone(config.managerPhone)}. It should arrive within a minute.`,
    });
  };
}

/**
 * Reads a status off an arbitrary Response-like value. Deno's fetch returns a
 * real Response, but the stub transport in the tests may return anything, so
 * this degrades to 0 rather than throwing.
 */
function responseStatus(response: unknown): number {
  if (response && typeof response === "object" && "status" in response) {
    const status = (response as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return 0;
}

async function responseText(response: unknown): Promise<string> {
  if (response && typeof response === "object" && "text" in response) {
    const text = (response as { text: unknown }).text;
    if (typeof text === "function") {
      try {
        return await (text as () => Promise<string>).call(response);
      } catch {
        return "";
      }
    }
  }
  return "";
}

/** Masks the middle of a phone number so logs and responses stay non-identifying. */
export function maskPhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.length <= 6) return trimmed;
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-3)}`;
}

// ===========================================================================
// Production wiring
// ===========================================================================

/** Only imported by the runtime entrypoint; tests inject their own deps. */
export async function serve(): Promise<void> {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const deps: HandlerDeps = {
    client: client as unknown as SupabaseLike,
    serviceRoleKey,
    async readSettings() {
      const { data, error } = await client
        .from("system_settings")
        .select("key,value")
        .limit(500);
      if (error) return { data: null, error: { message: error.message } };
      // system_settings is a key/value table; pivot it into the flat shape
      // resolveSmsConfig expects.
      const flat: Record<string, string> = {};
      for (const row of (data ?? []) as { key: string; value: string }[]) {
        flat[row.key] = row.value;
      }
      return { data: [flat], error: null };
    },
    fetchImpl: (input, init) => fetch(input, init),
    spawn: (task) => {
      globalThis.addEventListener?.("unload", () => void task);
    },
    log: (level, message) => {
      if (level === "error") console.error(message);
      else console.log(message);
    },
  };

  Deno.serve(createHandler(deps));
}

if (import.meta.main) {
  await serve();
}
