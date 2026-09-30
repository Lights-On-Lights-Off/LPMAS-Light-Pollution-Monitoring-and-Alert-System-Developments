/**
 * Tests for the password reset rules and error translation.
 *
 * describeResetError is the one that matters most to a user: recovery links
 * are single-use and time-limited, so "expired" is an ordinary outcome and
 * the message has to tell the person to request a new link rather than
 * showing a raw Supabase code.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  PASSWORD_MIN_LENGTH,
  describeResetError,
  isValidEmail,
  resetRedirectTo,
  validateNewPassword,
} from "./password-rules.ts";

// ---------------------------------------------------------------------------
// validateNewPassword
// ---------------------------------------------------------------------------

Deno.test("a long enough matching password is accepted", () => {
  assertEquals(validateNewPassword("correct-horse", "correct-horse"), { ok: true, error: null });
});

Deno.test("an empty password is rejected", () => {
  assertEquals(validateNewPassword("", "").ok, false);
  assertEquals(validateNewPassword("", "x").error, "Enter a new password.");
});

Deno.test("a password below the minimum is rejected", () => {
  const short = "a".repeat(PASSWORD_MIN_LENGTH - 1);
  const result = validateNewPassword(short, short);
  assertEquals(result.ok, false);
  assert(result.error?.includes(String(PASSWORD_MIN_LENGTH)));
});

Deno.test("a password at exactly the minimum is accepted", () => {
  const exact = "a".repeat(PASSWORD_MIN_LENGTH);
  assertEquals(validateNewPassword(exact, exact).ok, true);
});

Deno.test("a mismatch is reported as a mismatch, not a length problem", () => {
  // The common case is a typo in the confirmation field, so it should say so.
  const result = validateNewPassword("correct-horse", "correct-horsf");
  assertEquals(result.error, "Passwords do not match.");
});

Deno.test("a mismatch is reported even when both are long enough", () => {
  assertEquals(validateNewPassword("aaaaaaaaaa", "bbbbbbbbbb").error, "Passwords do not match.");
});

Deno.test("a short password that also mismatches reports the length first", () => {
  // Length is the thing to fix first; a mismatch message here would send the
  // user off to retype a password that is too short anyway.
  const result = validateNewPassword("abc", "xyz");
  assert(result.error !== "Passwords do not match.");
});

// ---------------------------------------------------------------------------
// isValidEmail
// ---------------------------------------------------------------------------

Deno.test("a normal email address is valid", () => {
  assert(isValidEmail("manager@example.com"));
  assert(isValidEmail("  spaced@example.com  "));
});

Deno.test("an obviously invalid address is rejected", () => {
  for (const value of ["", "no-at-sign", "@example.com", "a@b", "a b@example.com", "a@ex ample.com"]) {
    assert(!isValidEmail(value), `expected ${value} to be rejected`);
  }
});

// ---------------------------------------------------------------------------
// resetRedirectTo
// ---------------------------------------------------------------------------

Deno.test("the reset link lands on /reset-password, not /login", () => {
  // Returning to the sign-in form leaves the user authenticated by the
  // recovery link with no way to choose a new password.
  assertEquals(resetRedirectTo("https://lpmas.example.com"), "https://lpmas.example.com/reset-password");
});

Deno.test("a trailing slash does not produce a double slash", () => {
  assertEquals(resetRedirectTo("https://lpmas.example.com/"), "https://lpmas.example.com/reset-password");
});

Deno.test("the local development origin is handled", () => {
  assertEquals(resetRedirectTo("http://localhost:3000"), "http://localhost:3000/reset-password");
});

// ---------------------------------------------------------------------------
// describeResetError
// ---------------------------------------------------------------------------

Deno.test("an expired or used link tells the user to request a new one", () => {
  for (const message of [
    "Email link is invalid or has expired",
    "Token has expired or is invalid",
    "Auth session missing",
  ]) {
    const described = describeResetError(message);
    assert(described.includes("Request a new one"), `unexpected: ${described}`);
  }
});

Deno.test("a missing error still produces actionable guidance", () => {
  assert(describeResetError(undefined).includes("Request a new one"));
  assert(describeResetError("").includes("Request a new one"));
});

Deno.test("reusing the old password is called out specifically", () => {
  const described = describeResetError("New password should be different from the old password.");
  assert(described.includes("different from the old one"));
});

Deno.test("a rate limit tells the user to wait rather than to retry", () => {
  const described = describeResetError("Too many requests. Rate limit exceeded");
  assert(described.includes("Wait"));
});

Deno.test("an unconfirmed email is named as the cause", () => {
  const described = describeResetError("Email not confirmed");
  assert(described.includes("not confirmed"));
});

Deno.test("an unrecognized error falls back to the original message", () => {
  assertEquals(describeResetError("Database connection refused"), "Database connection refused");
});

Deno.test("an error with no text never renders as an empty message", () => {
  const described = describeResetError(undefined);
  assert(described.length > 0, "the user must always see something");
});
