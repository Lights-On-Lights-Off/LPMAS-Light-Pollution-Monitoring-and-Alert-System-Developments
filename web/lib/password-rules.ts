/**
 * Password rules for the reset flow.
 *
 * Kept pure and shared so the forgot-password and reset-password pages cannot
 * disagree about what a valid password is. Supabase enforces its own minimum
 * (6 by default), so anything stricter here is a product decision — but a
 * minimum that low is not a meaningful credential for an account that can
 * see a monitoring dashboard.
 */

export const PASSWORD_MIN_LENGTH = 8;

export interface PasswordCheck {
  ok: boolean;
  error: string | null;
}

/**
 * Validates a new password.
 *
 * Note this does NOT check against the current password or a breach list;
 * it only enforces shape, which is all the client can know.
 */
export function validateNewPassword(password: string, confirm: string): PasswordCheck {
  if (!password) return { ok: false, error: "Enter a new password." };

  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    };
  }

  if (password !== confirm) {
    // Checked before any other rule so the common typo is reported as the
    // mismatch it is, rather than as a length or complexity problem.
    return { ok: false, error: "Passwords do not match." };
  }

  return { ok: true, error: null };
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Where a password-reset link should land.
 *
 * Deliberately /reset-password, NOT /login. A link that returns to the
 * sign-in form leaves the user with a valid recovery session and no way to
 * set a password, which is the failure this whole flow exists to fix.
 */
export function resetRedirectTo(origin: string): string {
  return `${origin.replace(/\/$/, "")}/reset-password`;
}

/**
 * Turns a Supabase error into something worth showing.
 *
 * The recovery link is single-use and time-limited, so "expired" and
 * "already used" are ordinary outcomes rather than bugs; the user needs to
 * be told to request a new link rather than left staring at a raw code.
 */
export function describeResetError(message: string | undefined): string {
  const text = (message ?? "").toLowerCase();

  if (!text) return "The reset link is no longer valid. Request a new one.";

  if (
    text.includes("expired") ||
    text.includes("invalid") ||
    text.includes("token") ||
    text.includes("session")
  ) {
    return "This reset link has expired or has already been used. Request a new one.";
  }

  if (text.includes("new password should be different")) {
    return "The new password must be different from the old one.";
  }

  if (text.includes("rate limit") || text.includes("too many")) {
    return "Too many attempts. Wait a few minutes and try again.";
  }

  if (text.includes("email not confirmed")) {
    return "This account's email address is not confirmed yet.";
  }

  return message ?? "Something went wrong. Request a new reset link and try again.";
}
