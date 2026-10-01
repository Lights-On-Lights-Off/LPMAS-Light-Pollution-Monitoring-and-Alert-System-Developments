import { backendAuthorized } from "../_shared/backend-auth.ts";
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

import {
  buildSendRequest,
  interpretTextbeeResponse,
  resolveProvider,
  type SmsConfig,
} from "./sms-provider.ts";

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

// ===========================================================================
// Settings
// ===========================================================================

/**
 * Resolves the SMS configuration, or null when SMS is not configured or the
 * lookup failed. Never throws — every failure is a misconfiguration from the
 * caller's point of view.
 *
 * Provider selection lives in ./sms-provider.ts so this function only has to
 * read settings and hand them over.
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

  // A saved manager phone is what violation alerts use, but a test may name
  // its own recipient, so an empty phone is resolved here rather than being
  // treated as "SMS is not configured". buildSendRequest then applies the
  // override, and falls back to this value when the test names nobody.
  const config = resolveProvider(row);
  if (!config) return null;

  const savedPhone = (row.manager_phone ?? "").trim();
  return savedPhone ? { ...config, recipient: savedPhone } : { ...config, recipient: "" };
}

// ===========================================================================
// Recipient
// ===========================================================================

/** The country code and length every number this project sends to shares. */
const PH_COUNTRY_DIGITS = "63";
const PH_MOBILE_DIGITS = 10;

export interface RecipientResult {
  ok: boolean;
  number: string | null;
  error: string | null;
}

/**
 * Reads the optional recipient the Admin panel typed into the test field.
 *
 * The stored manager_phone is a fallback, not a requirement: the point of
 * the test is to prove the line works *now*, without saving anything first.
 * A number is accepted in the forms an operator actually writes — "+63 917
 * 123 4567", "0917…" or the bare 10 digits — and normalized to the +63 form
 * Semaphore expects.
 *
 * Nine or eleven digits are refused rather than sent. Semaphore accepts
 * such a request, bills it, and the message goes nowhere, so the operator
 * would conclude the line is broken when it is the number that is.
 */
export function parseTestRecipient(raw: unknown): RecipientResult {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, number: null, error: "No recipient supplied." };
  }

  const digits = raw.replace(/\D/g, "");

  let local = digits.startsWith(PH_COUNTRY_DIGITS) ? digits.slice(PH_COUNTRY_DIGITS.length) : digits;
  local = local.replace(/^0/, "");

  if (local.length !== PH_MOBILE_DIGITS) {
    return {
      ok: false,
      number: null,
      error: `Enter a ${PH_MOBILE_DIGITS} digit Philippine mobile number after +${PH_COUNTRY_DIGITS} (${local.length} digits given).`,
    };
  }

  return { ok: true, number: `+${PH_COUNTRY_DIGITS}${local}`, error: null };
}

export interface RecipientField {
  /** True when the caller sent any body at all. */
  present: boolean;
  /** True when a body was sent but could not be read as a JSON object. */
  malformed: boolean;
  value: unknown;
}

/**
 * Reads the `to` field out of a request body.
 *
 * A body that is present but unreadable is reported as malformed rather than
 * ignored, because ignoring it would quietly send the message to the stored
 * manager phone instead — a test to the wrong number looks exactly like a
 * broken SIM.
 */
export function readRecipientField(body: string | null | undefined): RecipientField {
  if (!body || !body.trim()) return { present: false, malformed: false, value: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { present: true, malformed: true, value: undefined };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { present: true, malformed: true, value: undefined };
  }

  return { present: true, malformed: false, value: (parsed as { to?: unknown }).to };
}

// ===========================================================================
// Message
// ===========================================================================

/**
 * The test message body. Kept under 160 characters so it bills as a single
 * segment.
 */
export function buildTestMessage(now: Date = new Date()): string {
  const stamp = now.toISOString().replace("T", " ").slice(0, 16);
  return `[LPMAS] Test SMS. If you received this, alert delivery is working. Sent ${stamp} UTC.`;
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
    if (!backendAuthorized(request.headers.get("Authorization"),deps.serviceRoleKey)) {
      return json(401,{ok:false,error:"Backend authorization required"});
    }

    if (request.method !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    // 2. Resolve settings. A null here means either "not configured" or
    //    "could not read", and both are a 400 from the operator's view: the
    //    action to take is in the Admin settings form, not at the gateway.
    const config = await resolveSmsConfig(deps);
    if (!config) {
      return json(400, {
        ok: false,
        error: "SMS is not configured. Set the SMS gateway API key and a manager phone in Admin > Configure system.",
      });
    }

    // 3. Resolve the recipient. A number typed into the Admin panel wins
    //    over the stored one, so an operator can verify the line without
    //    saving anything first.
    const field = readRecipientField(await safeRequestText(request));
    if (field.malformed) {
      return json(400, { ok: false, error: "The request body could not be read." });
    }

    const recipient = field.value === undefined
      ? { ok: true, number: null, error: null }
      : parseTestRecipient(field.value);

    if (!recipient.ok) {
      return json(400, { ok: false, error: recipient.error });
    }

    // 4. Build the request. The recipient is validated here, before any
    //    network call: a number the carrier cannot deliver is still billed.
    const message = buildTestMessage();
    const outbound = buildSendRequest(config, message, recipient.number ?? undefined);
    if (!outbound.ok) {
      return json(400, { ok: false, error: outbound.error });
    }

    const number = String(
      (JSON.parse(String(outbound.init.body)) as { recipients: string[] }).recipients[0],
    );

    // 5. Send, and report the gateway's real verdict.
    let status: number;
    let rawBody: string;
    try {
      const response = await deps.fetchImpl(outbound.url, outbound.init);
      status = responseStatus(response);
      rawBody = await responseText(response);
    } catch (error) {
      const detail = describe(error);
      deps.log("error", `Test SMS transport failed: ${detail}`);
      return json(502, {
        ok: false,
        error: `Could not reach the SMS gateway: ${detail}`,
      });
    }

    const outcome = interpretTextbeeResponse(status, rawBody, config.apiKey);
    if (!outcome.ok) {
      // The phone number is masked and the key is scrubbed: operators paste
      // these messages into tickets, and neither belongs in a ticket.
      deps.log("error", `Test SMS rejected (HTTP ${status}): ${outcome.detail}`);
      return json(502, { ok: false, error: outcome.detail });
    }

    deps.log("info", `Test SMS accepted by the gateway for ${maskPhone(number)}`);
    return json(200, {
      ok: true,
      message: `Test SMS accepted by the provider for ${maskPhone(number)}. Handset delivery is unconfirmed.`,
    });
  };
}

/**
 * Reads a request body without letting a transport hiccup become a 500.
 *
 * Only the small JSON this endpoint needs is buffered, and a body that
 * cannot be read is treated as "not supplied" so the stored manager phone
 * remains usable.
 */
async function safeRequestText(request: Request): Promise<string | null> {
  try {
    return await request.text();
  } catch {
    return null;
  }
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
    serviceRoleKey: Deno.env.get("LPMAS_BACKEND_JWT") ?? serviceRoleKey,
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
