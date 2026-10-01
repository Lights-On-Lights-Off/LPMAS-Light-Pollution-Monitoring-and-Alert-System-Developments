/**
 * Tests for the SMS provider layer.
 *
 * This module exists because the project outgrew a hard-coded provider.
 * Semaphore requires a credit balance and a registered sender name, which
 * put the free tier out of reach, so alerts now go through textbee — which
 * relays through the project's own prepaid SIM and therefore costs nothing
 * per message.
 *
 * What is being protected here:
 *
 *   - the recipient is validated BEFORE any network call, so a malformed
 *     number can never be billed or silently dropped by a carrier
 *   - the API key is never echoed in a response or a log
 *   - a provider that returns 200 with a failure inside the body is a
 *     failure, not a success
 *   - a blank API key disables sending rather than sending something broken
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  TEXTBEE_ENDPOINT,
  buildSendRequest,
  interpretTextbeeResponse,
  resolveProvider,
  type SmsSettings,
} from "./sms-provider.ts";

const KEY = "tb_test_key_value";

function settings(overrides: Partial<SmsSettings> = {}): SmsSettings {
  return {
    sms_provider: "textbee",
    textbee_api_key: KEY,
    manager_phone: "+639171234567",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveProvider
// ---------------------------------------------------------------------------

Deno.test("textbee is chosen when it is configured with a key", () => {
  const config = resolveProvider(settings());
  assertEquals(config?.provider, "textbee");
  assertEquals(config?.apiKey, KEY);
  assertEquals(config?.recipient, "+639171234567");
});

Deno.test("a blank API key disables sending instead of calling out with nothing", () => {
  // The failure this prevents: a request with an empty credential, which
  // a provider rejects with a message that looks like a network problem.
  for (const value of ["", "   ", undefined]) {
    assertEquals(resolveProvider(settings({ textbee_api_key: value })), null);
  }
});

Deno.test("a blank recipient leaves the key usable, and the caller decides", () => {
  // resolveProvider answers "is SMS configured at all", not "is there
  // someone to text". A test supplies its own number, so refusing the whole
  // configuration here made the test button report "not configured" while a
  // working key sat in the settings.
  const config = resolveProvider(settings({ manager_phone: "" }));
  assertEquals(config?.apiKey, KEY, "the key must still be usable");
  assertEquals(config?.recipient, "");
});

Deno.test("a request with no number from either source is refused", () => {
  // With no saved phone and no override there is genuinely nowhere to send.
  const withoutPhone = resolveProvider(settings({ manager_phone: "" }))!;
  const result = buildSendRequest(withoutPhone, "hi");
  assert(!result.ok, "expected a request with no number anywhere to be refused");
});

Deno.test("a saved phone is used when the test names nobody", () => {
  const config = resolveProvider(settings())!;
  const result = buildSendRequest(config, "hi");
  assert(result.ok, "the saved manager phone should be the fallback");
  if (result.ok) {
    const body = JSON.parse(String(result.init.body));
    assertEquals(body.recipients, ["+639171234567"]);
  }
});

Deno.test("a test that names its own number succeeds with no saved phone", () => {
  const config = resolveProvider(settings({ manager_phone: "" }))!;
  const result = buildSendRequest(config, "hi", "9171234567");
  assert(result.ok);
});

Deno.test("an unknown provider is refused rather than guessed at", () => {
  // Guessing would send a credential to a URL nobody reviewed.
  assertEquals(resolveProvider(settings({ sms_provider: "twilio" })), null);
  assertEquals(resolveProvider(settings({ sms_provider: "" })), null);
});

Deno.test("values are trimmed, so a pasted key with a newline still works", () => {
  const config = resolveProvider(settings({ textbee_api_key: `  ${KEY}\n` }));
  assertEquals(config?.apiKey, KEY);
});

// ---------------------------------------------------------------------------
// buildSendRequest
// ---------------------------------------------------------------------------

Deno.test("a send request carries the key in the header, not the body", () => {
  const config = resolveProvider(settings())!;
  const result = buildSendRequest(config, "Test message");
  assert(result.ok, "expected a request");
  const request = result;

  assertEquals(request.url, TEXTBEE_ENDPOINT);
  const body = JSON.parse(String(request.init.body));
  assertEquals(body.recipients, ["+639171234567"]);
  assertEquals(body.message, "Test message");

  const headers = request.init.headers as Record<string, string>;
  assertEquals(headers["x-api-key"], KEY);
  assert(!String(request.init.body).includes(KEY), "the key must not appear in the body");
});

Deno.test("a recipient that is not a Philippine mobile number is refused before sending", () => {
  // A number the carrier cannot deliver is billed anyway, so validation
  // before the call is the only way to know the alert will arrive.
  const config = resolveProvider(settings())!;
  for (
    const bad of [
      "+1234567890",     // another country, ten digits long
      "+14155552671",    // a US number
      "917123456",       // nine digits — one short
      "not-a-number",
      "+63917123456789012", // too long
      "0917123456",      // a landline shape, not a 9-prefixed mobile
    ]
  ) {
    const result = buildSendRequest(config, "hi", bad);
    assert(!result.ok, `expected ${bad} to be refused`);
    if (!result.ok) assert(result.error !== null, `expected a reason for ${bad}`);
  }
});

Deno.test("the ways a person actually writes a PH mobile number are all accepted", () => {
  // Refusing a correctly written number is the more annoying of the two
  // failures, so every ordinary spelling has to work.
  const config = resolveProvider(settings())!;
  for (const good of ["+639171234567", "63 917 123 4567", "09171234567", "9171234567", " 9171234567 "]) {
    const result = buildSendRequest(config, "hi", good);
    assert(result.ok, `expected ${good} to be accepted`);
    if (result.ok) {
      const body = JSON.parse(String(result.init.body));
      assertEquals(body.recipients, ["+639171234567"], `${good} should normalize to E.164`);
    }
  }
});

Deno.test("a valid recipient produces a request with no error", () => {
  const config = resolveProvider(settings())!;
  const result = buildSendRequest(config, "hi", "+639171234567");
  assertEquals(result.ok, true);
});

Deno.test("an over-long message is refused rather than split into billable segments", () => {
  // 160 chars is one segment; a longer one is billed as several. Silently
  // sending three messages for one alert is worse than saying no.
  const config = resolveProvider(settings())!;
  const result = buildSendRequest(config, "x".repeat(400));
  assert(!result.ok, "expected an over-long message to be refused");
  if (!result.ok) {
    assert(/segment|characters|long/i.test(result.error), `unhelpful error: ${result.error}`);
  }
});

// ---------------------------------------------------------------------------
// interpretTextbeeResponse
// ---------------------------------------------------------------------------

Deno.test("an accepted send is reported as success", () => {
  const outcome = interpretTextbeeResponse(200, JSON.stringify({ smsBatchId: "abc" }));
  assertEquals(outcome.ok, true);
});

Deno.test("a 200 carrying a per-message failure is still a failure", () => {
  // A status-code-only check would report "sent" for a message the
  // provider rejected, which is the one outcome this endpoint must not give.
  const body = JSON.stringify({ messages: [{ status: "failed", error: "carrier rejected" }] });
  const outcome = interpretTextbeeResponse(200, body);
  assertEquals(outcome.ok, false);
  assert((outcome.detail ?? "").includes("carrier rejected"), `got: ${outcome.detail}`);
});

Deno.test("an API error is surfaced with the provider's own reason", () => {
  const body = JSON.stringify({ error: "Unauthorized API key" });
  const outcome = interpretTextbeeResponse(401, body);
  assertEquals(outcome.ok, false);
  assertEquals(outcome.detail, "Unauthorized API key");
});

Deno.test("a non-JSON error body does not crash the reader", () => {
  const outcome = interpretTextbeeResponse(502, "<html>bad gateway</html>");
  assertEquals(outcome.ok, false);
  assert(outcome.detail !== null && outcome.detail.length > 0);
});

Deno.test("a non-2xx with no body still produces a usable reason", () => {
  const outcome = interpretTextbeeResponse(500, "");
  assertEquals(outcome.ok, false);
  assert((outcome.detail ?? "").includes("500"), `got: ${outcome.detail}`);
});

Deno.test("the API key never appears in a failure message", () => {
  // Operators paste these into tickets; a key must not ride along. The key
  // is passed in at every call site — a default of "" would silently skip
  // the scrub, which is exactly the bug this test caught.
  const body = JSON.stringify({ error: `bad key ${KEY}` });
  const outcome = interpretTextbeeResponse(401, body, KEY);
  assert(!JSON.stringify(outcome).includes(KEY), "the key leaked into the outcome");
  assert((outcome.detail ?? "").includes("[redacted]"), "expected the key to be marked redacted");
});

Deno.test("an unconfirmed 2xx response is not acceptance",() => {
  for(const body of ["", "<html>ok</html>", "{}", '{"data":{"success":false,"smsBatchId":"x"}}']) assertEquals(interpretTextbeeResponse(200,body).ok,false);
});
