/**
 * The SMS provider layer.
 *
 * Semaphore, the previous provider, meters every message against a credit
 * balance and refuses to send without a registered sender name, so a free
 * account could not deliver a single alert. textbee relays through the
 * project's own prepaid SIM, so a message costs nothing and needs no credit.
 *
 * Both Edge Functions import this so they cannot disagree about what a valid
 * configuration is, how a number is formatted, or what a provider's verdict
 * means. Everything here is pure: settings in, request out.
 */

/** textbee's send endpoint. The device is chosen by the account default. */
export const TEXTBEE_ENDPOINT = "https://api.textbee.dev/api/v1/gateway/send-sms";

/** The country code and length a Philippine mobile number always has. */
const PH_COUNTRY_DIGITS = "63";
const PH_MOBILE_DIGITS = 10;

/**
 * 160 characters is one billable segment. Anything longer is billed as
 * several, so a long message quietly costs several times as much.
 */
const MESSAGE_MAX_CHARACTERS = 160;

export type ProviderName = "textbee";

export interface SmsSettings {
  sms_provider?: string | null;
  textbee_api_key?: string | null;
  manager_phone?: string | null;
}

export interface SmsConfig {
  provider: ProviderName;
  apiKey: string;
  recipient: string;
}

export type SendRequest =
  | { ok: true; url: string; init: RequestInit }
  | { ok: false; error: string };

/**
 * Resolves the settings into a usable configuration, or null when SMS
 * cannot be sent.
 *
 * Null is returned for every "not configured" case rather than throwing, so
 * a caller can treat an unconfigured project as a normal state rather than
 * an error — SMS not being set up must never break a sensor reading.
 */
export function resolveProvider(settings: SmsSettings): SmsConfig | null {
  const provider = (settings.sms_provider ?? "").trim();
  const apiKey = (settings.textbee_api_key ?? "").trim();
  const recipient = (settings.manager_phone ?? "").trim();

  // An unknown provider is refused rather than defaulted. Defaulting would
  // send a credential to a URL that nobody chose and nobody reviewed.
  if (provider !== "textbee") return null;
  if (!apiKey) return null;

  // A blank recipient is NOT grounds for refusing the whole configuration.
  // Whether it is fatal depends on the caller: a violation alert has nobody
  // to ask for a number, but a test supplies its own, and refusing here made
  // the test button report "not configured" while a working key sat in the
  // settings. buildSendRequest decides, with advice suited to each caller.
  return { provider, apiKey, recipient };
}

/**
 * Normalizes a Philippine mobile number to E.164 (+639XXXXXXXXX).
 *
 * Accepts the forms a person actually types — "+63 917 123 4567",
 * "0917…" or the bare 10 digits — because refusing a correctly written
 * number is the more annoying failure of the two.
 */
export function normalizePhilippineNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");

  // A country code other than +63 is refused rather than treated as local.
  // Counting digits alone let "+1234567890" through — it is ten digits long,
  // so it looked valid and would have been re-prefixed into a Philippine
  // number that belongs to somebody else.
  if (digits.startsWith("+")) {
    const explicitCode = raw.trim().startsWith("+");
    if (explicitCode && !digits.startsWith(PH_COUNTRY_DIGITS)) return null;
  }
  if (!digits.startsWith(PH_COUNTRY_DIGITS) && !digits.startsWith("0") &&
      digits.length > PH_MOBILE_DIGITS) {
    return null;
  }

  const local = (digits.startsWith(PH_COUNTRY_DIGITS)
    ? digits.slice(PH_COUNTRY_DIGITS.length)
    : digits
  ).replace(/^0/, "");

  // A Philippine mobile number always begins with 9; anything else is a
  // landline or a mistyped number.
  if (local.length !== PH_MOBILE_DIGITS || !local.startsWith("9")) return null;
  return `+${PH_COUNTRY_DIGITS}${local}`;
}

/**
 * Builds the provider request, validating the recipient first.
 *
 * Validation happens here rather than at the carrier, because a number that
 * cannot be delivered is still billed. Refusing before the call is the only
 * way to know the alert will actually arrive.
 */
export function buildSendRequest(
  config: SmsConfig,
  message: string,
  recipientOverride?: string,
): SendRequest {
  const raw = recipientOverride?.trim() || config.recipient;

  // No number from either source. The two callers need different advice:
  // a test can ask for the number, so it says so; a violation alert has
  // nobody to ask, so it says where the setting lives.
  if (!raw) {
    return {
      ok: false,
      error: config.recipient === ""
        ? "No recipient. Type a mobile number to test, or save a manager phone in Admin > Configure system."
        : "No manager phone is saved for violation alerts. Set one in Admin > Configure system.",
    };
  }

  const recipient = normalizePhilippineNumber(raw);

  if (!recipient) {
    return {
      ok: false,
      error: `Enter a ${PH_MOBILE_DIGITS} digit Philippine mobile number after +${PH_COUNTRY_DIGITS}.`,
    };
  }

  if (!message) {
    return { ok: false, error: "The message is empty." };
  }

  if (message.length > MESSAGE_MAX_CHARACTERS) {
    return {
      ok: false,
      error: `The message is too long. Keep it under ${MESSAGE_MAX_CHARACTERS} characters so it stays one billable segment.`,
    };
  }

  return {
    ok: true,
    url: TEXTBEE_ENDPOINT,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The key travels in the header, never the body: a body is the part
        // that ends up in a proxy log or a debugging output.
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify({ recipients: [recipient], message }),
    },
  };
}

export interface ProviderOutcome {
  ok: boolean;
  detail: string | null;
}

/**
 * Interprets a provider response.
 *
 * Checks the body as well as the status code. A 2xx can still carry a
 * per-message failure, and reporting that as "sent" would tell an operator
 * their alerting works when it does not — the one outcome this must never
 * produce.
 */
export function interpretTextbeeResponse(status: number, rawBody: string, apiKey = ""): ProviderOutcome {
  let parsed: unknown = null;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsed = null;
  }

  // Scrubbing happens on the way out, on every branch, and the key is a
  // required argument at each call site rather than an optional one that
  // silently does nothing. An earlier version defaulted it to "" and so
  // leaked the key into exactly the message operators paste into tickets.
  const finish = (detail: string): ProviderOutcome => ({
    ok: false,
    detail: apiKey ? detail.split(apiKey).join("[redacted]") : detail,
  });

  const explicitError = readErrorText(parsed);
  if (explicitError) return finish(explicitError);

  const messageFailure = readMessageFailure(parsed);
  if (messageFailure) return finish(messageFailure);

  if (status < 200 || status >= 300) {
    return finish(
      `The SMS gateway returned HTTP ${status}${parsed ? "" : " with a non-JSON body"}`,
    );
  }

  return { ok: true, detail: null };
}

function readErrorText(parsed: unknown): string | null {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const value = (parsed as { error: unknown }).error;
    if (typeof value === "string" && value.trim()) return value.trim();
    // Some providers return a field-by-field validation object.
    if (value && typeof value === "object") {
      const first = Object.values(value as Record<string, unknown>)[0];
      if (typeof first === "string" && first.trim()) return first.trim();
    }
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
    if (typeof status === "string" && ["failed", "error", "rejected"].includes(status.toLowerCase())) {
      const detail = (entry as { error?: unknown }).error;
      return typeof detail === "string" && detail.trim()
        ? detail.trim()
        : `The gateway reported the message as ${status}`;
    }
  }
  return null;
}
