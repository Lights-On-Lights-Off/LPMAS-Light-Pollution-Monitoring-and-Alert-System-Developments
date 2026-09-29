/**
 * Tests for the admin notification settings validation.
 *
 * The offline threshold is the safety-relevant one: a value below the 5s
 * floor would mark a healthy sensor offline between 10-second ESP32
 * samples, which is the failure mode that erodes trust in the dashboard.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  OFFLINE_THRESHOLD_DEFAULT,
  canSendTestSms,
  maskApiKey,
  parseOfflineThreshold,
  validateManagerPhone,
} from "./admin-notification-settings.ts";

// ---------------------------------------------------------------------------
// parseOfflineThreshold
// ---------------------------------------------------------------------------

Deno.test("a sensible threshold is accepted and parsed", () => {
  assertEquals(parseOfflineThreshold("15"), { ok: true, value: 15, error: null });
  assertEquals(parseOfflineThreshold("30").value, 30);
  assertEquals(parseOfflineThreshold("  60  ").value, 60);
});

Deno.test("the documented minimum of 5 seconds is accepted", () => {
  assertEquals(parseOfflineThreshold("5").ok, true);
});

Deno.test("a threshold below the floor is rejected with a reason", () => {
  const result = parseOfflineThreshold("4");
  assertEquals(result.ok, false);
  assert(result.error?.includes("at least 5"), `unexpected error: ${result.error}`);
});

Deno.test("a negative threshold is rejected rather than clamped", () => {
  const result = parseOfflineThreshold("-10");
  assertEquals(result.ok, false);
  assertEquals(result.value, -10, "the entered value is echoed back so the field can show it");
});

Deno.test("a fractional threshold is rejected, not rounded", () => {
  // 15.5 is not a meaningful threshold; rounding would put a value in force
  // that the operator did not type.
  const result = parseOfflineThreshold("15.5");
  assertEquals(result.ok, false);
  assert(result.error?.includes("whole number"));
});

Deno.test("a non-numeric threshold is rejected", () => {
  for (const value of ["abc", "15s", "1e3", "--5", " "]) {
    assertEquals(parseOfflineThreshold(value).ok, false, `expected ${value} to be rejected`);
  }
});

Deno.test("an empty threshold falls back to the documented default", () => {
  const result = parseOfflineThreshold("");
  assertEquals(result.ok, false);
  assertEquals(result.value, OFFLINE_THRESHOLD_DEFAULT);
});

Deno.test("an absurdly large threshold is rejected", () => {
  assertEquals(parseOfflineThreshold("999999").ok, false);
});

// ---------------------------------------------------------------------------
// validateManagerPhone
// ---------------------------------------------------------------------------

Deno.test("an empty phone is allowed, meaning SMS is simply off", () => {
  assertEquals(validateManagerPhone(""), null);
  assertEquals(validateManagerPhone("   "), null);
});

Deno.test("common international formats are accepted", () => {
  for (const value of ["+639171234567", "09171234567", "+63 917 123 4567", "(02) 8123-4567"]) {
    assertEquals(validateManagerPhone(value), null, `expected ${value} to be accepted`);
  }
});

Deno.test("a number with letters or symbols is rejected", () => {
  assert(validateManagerPhone("+63-CALL-NOW") !== null);
  assert(validateManagerPhone("0917abc4567") !== null);
});

Deno.test("a number that is too short is rejected", () => {
  assert(validateManagerPhone("12345") !== null);
});

Deno.test("a number that is too long is rejected", () => {
  assert(validateManagerPhone("1234567890123456") !== null);
});

Deno.test("a number full of separators with too few digits is rejected", () => {
  assert(validateManagerPhone("++++") !== null);
});

// ---------------------------------------------------------------------------
// canSendTestSms
// ---------------------------------------------------------------------------

const ready = { semaphoreApiKey: "key", semaphoreSenderName: "LPMAS", managerPhone: "+639171234567" };

Deno.test("a fully configured panel may send a test SMS", () => {
  assertEquals(canSendTestSms(ready), { enabled: true, reason: null });
});

Deno.test("each missing field disables the button and says which one", () => {
  const cases: [Partial<typeof ready>, string][] = [
    [{ semaphoreApiKey: "" }, "API key"],
    [{ semaphoreSenderName: "  " }, "sender name"],
    [{ managerPhone: "" }, "phone number"],
  ];
  for (const [override, expected] of cases) {
    const result = canSendTestSms({ ...ready, ...override });
    assertEquals(result.enabled, false);
    assert(
      result.reason?.toLowerCase().includes(expected.toLowerCase()),
      `expected the reason to mention the ${expected}, got: ${result.reason}`,
    );
  }
});

Deno.test("the button is disabled when everything is blank", () => {
  const result = canSendTestSms({ semaphoreApiKey: "", semaphoreSenderName: "", managerPhone: "" });
  assertEquals(result.enabled, false);
  assert(result.reason !== null);
});

// ---------------------------------------------------------------------------
// maskApiKey
// ---------------------------------------------------------------------------

Deno.test("a long key is shown only as its ends", () => {
  const masked = maskApiKey("abcd1234efgh5678");
  assertEquals(masked, "abcd…5678");
  assert(!masked.includes("1234efgh"), "the middle of the key must not be shown");
});

Deno.test("a short key is fully hidden", () => {
  assertEquals(maskApiKey("short"), "••••");
  assertEquals(maskApiKey(""), "••••");
});

Deno.test("masking never returns more than the ends of the key", () => {
  const key = "k".repeat(64);
  const masked = maskApiKey(key);
  assert(masked.length < key.length);
});
