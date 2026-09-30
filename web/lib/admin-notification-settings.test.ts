/**
 * Tests for the admin notification settings validation.
 *
 * The offline threshold is the safety-relevant one: a value below the 5s
 * floor would mark a healthy sensor offline between 10-second ESP32
 * samples, which is the failure mode that erodes trust in the dashboard.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  DARK_PHASE_DAYS_DEFAULT,
  OFFLINE_THRESHOLD_DEFAULT,
  PH_COUNTRY_CODE,
  PH_LOCAL_DIGITS,
  maskApiKey,
  parseDarkPhaseDays,
  parseIlluminationRange,
  parseOfflineThreshold,
  sanitizeLocalDigits,
  toInternationalNumber,
  toLocalDigits,
  validateLocalDigits,
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
// The Philippine mobile number field: a fixed +63 country code plus 10 digits
// ---------------------------------------------------------------------------

Deno.test("the number field is a fixed +63 prefix followed by exactly 10 digits", () => {
  assertEquals(PH_COUNTRY_CODE, "+63");
  assertEquals(PH_LOCAL_DIGITS, 10);
});

Deno.test("the displayed number is the +63 prefix plus the typed digits", () => {
  assertEquals(toInternationalNumber("9171234567"), "+639171234567");
});

Deno.test("ten digits are accepted and a short number explains itself", () => {
  assertEquals(validateLocalDigits("9171234567"), null);

  for (const short of ["", "  ", "917123456", "12345"]) {
    const error = validateLocalDigits(short);
    assert(error !== null, `expected "${short}" to be rejected`);
    assert(/10/.test(error), `expected the error to state the 10 digit rule, got: ${error}`);
  }
});

Deno.test("digits pasted with separators or the +63 prefix are reduced to 10 digits", () => {
  assertEquals(sanitizeLocalDigits("917 123 4567"), "9171234567");
  assertEquals(sanitizeLocalDigits("+63 917-123-4567"), "9171234567");
  assertEquals(sanitizeLocalDigits("0917abc1234567"), "9171234567");
});

Deno.test("typing is capped at 10 digits so the prefix can never be pushed along", () => {
  // A pasted 0917… number plus an accidental extra digit must not silently
  // become an 11 digit number prefixed with +63.
  assertEquals(sanitizeLocalDigits("091712345678999").length, PH_LOCAL_DIGITS);
});

Deno.test("letters and symbols are dropped rather than stored", () => {
  assertEquals(sanitizeLocalDigits("917abc123-4567"), "9171234567");
});

Deno.test("a stored number is split back into the 10 digits for editing", () => {
  assertEquals(toLocalDigits("+639171234567"), "9171234567");
  assertEquals(toLocalDigits("63 917 123 4567"), "9171234567");
  assertEquals(toLocalDigits("09171234567"), "9171234567");
  assertEquals(toLocalDigits("9171234567"), "9171234567");
  assertEquals(toLocalDigits(""), "");
});

// ---------------------------------------------------------------------------
// Dark phase duration
// ---------------------------------------------------------------------------

Deno.test("a whole positive number of days is accepted", () => {
  assertEquals(parseDarkPhaseDays("60"), { ok: true, value: 60, error: null });
  assertEquals(parseDarkPhaseDays(" 1 ").value, 1);
});

Deno.test("the dark phase default is 60 days", () => {
  assertEquals(DARK_PHASE_DAYS_DEFAULT, 60);
  assertEquals(parseDarkPhaseDays("").value, DARK_PHASE_DAYS_DEFAULT);
});

Deno.test("a zero, negative or fractional dark phase is rejected", () => {
  for (const value of ["0", "-5", "7.5", "sixty", ""]) {
    assertEquals(parseDarkPhaseDays(value).ok, false, `expected ${value} to be rejected`);
  }
  assert(parseDarkPhaseDays("0").error !== null);
});

// ---------------------------------------------------------------------------
// Illumination phase dates
// ---------------------------------------------------------------------------

Deno.test("an illumination window that ends before it starts is rejected", () => {
  const result = parseIlluminationRange("2026-10-10", "2026-10-01");
  assertEquals(result.ok, false);
  assert(result.error !== null && result.error.length > 0);
});

Deno.test("a same-day or correctly ordered window is accepted", () => {
  assertEquals(parseIlluminationRange("2026-10-01", "2026-10-01").ok, true);
  assertEquals(parseIlluminationRange("2026-10-01", "2026-10-10").ok, true);
});

Deno.test("a half-filled window is accepted, so an operator can set one side first", () => {
  assertEquals(parseIlluminationRange("2026-10-01", "").ok, true);
  assertEquals(parseIlluminationRange("", "2026-10-10").ok, true);
  assertEquals(parseIlluminationRange("", "").ok, true);
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
