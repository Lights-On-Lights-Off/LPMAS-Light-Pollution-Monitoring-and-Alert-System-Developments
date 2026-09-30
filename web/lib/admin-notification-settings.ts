/**
 * Validation for the admin notification settings.
 *
 * The offline threshold is the one number here that can quietly break
 * monitoring: too low and healthy sensors flip offline between readings, too
 * high and a dead sensor keeps reporting safe. The ESP32 samples every 10
 * seconds, so the floor is 5s and the ceiling is generous enough to survive
 * a slow mobile uplink.
 */

export const OFFLINE_THRESHOLD_MIN = 5;
export const OFFLINE_THRESHOLD_MAX = 3600;
export const OFFLINE_THRESHOLD_DEFAULT = 15;

export interface ThresholdResult {
  ok: boolean;
  value: number;
  error: string | null;
}

/**
 * Parses the offline threshold.
 *
 * A non-integer is rejected rather than rounded: 15.5 seconds is not a
 * meaningful threshold, and silently rounding it would leave the operator
 * believing a value they did not type is in force.
 */
export function parseOfflineThreshold(raw: string): ThresholdResult {
  const trimmed = raw.trim();

  if (!trimmed) {
    return {
      ok: false,
      value: OFFLINE_THRESHOLD_DEFAULT,
      error: "Offline threshold is required.",
    };
  }

  // A signed integer is parsed so the operator's own number is echoed back
  // in the result and can be redisplayed; anything else is not a number at
  // all and falls back to the default.
  if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    return {
      ok: false,
      value: OFFLINE_THRESHOLD_DEFAULT,
      error: "Offline threshold must be a whole number of seconds.",
    };
  }

  const value = Number(trimmed);

  if (!Number.isInteger(value)) {
    return {
      ok: false,
      value,
      error: "Offline threshold must be a whole number of seconds.",
    };
  }

  if (value < OFFLINE_THRESHOLD_MIN) {
    return {
      ok: false,
      value,
      error: `Offline threshold must be at least ${OFFLINE_THRESHOLD_MIN} seconds. The ESP32 reports every 10 seconds, so a lower value would mark live sensors offline.`,
    };
  }

  if (value > OFFLINE_THRESHOLD_MAX) {
    return {
      ok: false,
      value,
      error: `Offline threshold must be at most ${OFFLINE_THRESHOLD_MAX} seconds.`,
    };
  }

  return { ok: true, value, error: null };
}

// ---------------------------------------------------------------------------
// The Philippine mobile number field
// ---------------------------------------------------------------------------

/**
 * Every number this system sends to is a Philippine SIM, so the country code
 * is shown as a fixed prefix instead of being typed. Typing "+63" eleven
 * times is how "639171234567" (12 digits) and "+63917123456" (9) get stored,
 * and Semaphore silently bills a message it cannot deliver.
 */
export const PH_COUNTRY_CODE = "+63";

/** A Philippine mobile number is 10 digits: 9XXXXXXXXX. */
export const PH_LOCAL_DIGITS = 10;

/**
 * Reduces whatever was typed or pasted to the 10 digits the field holds.
 *
 * Everything that is not a digit is dropped, including a pasted "+63 " or
 * "0917 " prefix, because the field already shows the country code. The
 * result is capped at 10 so an over-long paste cannot push the number out of
 * range.
 */
export function sanitizeLocalDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^63/, "").replace(/^0/, "");
  return digits.slice(0, PH_LOCAL_DIGITS);
}

/** The stored form: the fixed country code plus the 10 typed digits. */
export function toInternationalNumber(localDigits: string): string {
  return `${PH_COUNTRY_CODE}${sanitizeLocalDigits(localDigits)}`;
}

/**
 * Splits a stored number back into the 10 digits, so editing shows what the
 * operator originally typed.
 *
 * The leading "0" is dropped as well as the country code: "0917…" and
 * "+63917…" are the same number written two ways, and both must come back
 * as 10 digits or the field would show a number the field cannot hold.
 */
export function toLocalDigits(stored: string): string {
  const digits = stored.replace(/\D/g, "");
  const withoutCountryCode = digits.startsWith(PH_COUNTRY_CODE.slice(1))
    ? digits.slice(PH_COUNTRY_CODE.slice(1).length)
    : digits;
  return withoutCountryCode.replace(/^0/, "").slice(0, PH_LOCAL_DIGITS);
}

/** Why the field is not yet a sendable number, or null when it is. */
export function validateLocalDigits(raw: string): string | null {
  const length = sanitizeLocalDigits(raw).length;
  if (length === PH_LOCAL_DIGITS) return null;
  return `Enter exactly ${PH_LOCAL_DIGITS} digits after ${PH_COUNTRY_CODE} (${length}/${PH_LOCAL_DIGITS} entered).`;
}

// ---------------------------------------------------------------------------
// Phase configuration
// ---------------------------------------------------------------------------

/** The dark phase a new greenhouse starts with. */
export const DARK_PHASE_DAYS_DEFAULT = 60;

export interface PhaseResult {
  ok: boolean;
  value: number;
  error: string | null;
}

/**
 * Parses the dark phase duration in days.
 *
 * A whole positive number, for the same reason the threshold is not rounded:
 * a 0 or a fractional length of time is not a phase, and silently correcting
 * it would put a schedule in force that nobody entered.
 */
export function parseDarkPhaseDays(raw: string): PhaseResult {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { ok: false, value: DARK_PHASE_DAYS_DEFAULT, error: "Dark phase duration is required." };
  }

  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      value: DARK_PHASE_DAYS_DEFAULT,
      error: "Dark phase duration must be a whole number of days.",
    };
  }

  const value = Number(trimmed);

  if (value < 1) {
    return { ok: false, value, error: "Dark phase duration must be at least 1 day." };
  }

  return { ok: true, value, error: null };
}

export interface RangeResult {
  ok: boolean;
  error: string | null;
}

/**
 * Checks the illumination window.
 *
 * Both ends are optional so an operator can fill one in first, but a window
 * that ends before it starts would leave the greenhouse unmonitored, and it
 * is the one mistake here that disables monitoring without looking broken.
 */
export function parseIlluminationRange(start: string, end: string): RangeResult {
  if (!start || !end) return { ok: true, error: null };

  if (end < start) {
    return { ok: false, error: "The illumination phase must not end before it starts." };
  }

  return { ok: true, error: null };
}

/**
 * Validates the phone number.
 *
 * Deliberately permissive: Semaphore accepts international formats and the
 * operator's carrier conventions are not knowable here. Only clearly
 * unusable input is rejected, because a rejection here silently disables
 * alerting.
 */
export function validateManagerPhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null; // Unset is valid; it just means SMS is off.
  // Internal spaces and the usual separators are allowed — operators type
  // "+63 917 123 4567" — so this normalizes them away rather than
  // rejecting a correctly written number. Letters and other symbols are not
  // accepted, because they mean the field was filled in with something that
  // is not a number.
  if (!/^\+?[0-9\s()+-]+$/.test(trimmed)) {
    return "Phone number may only contain digits, an optional leading +, spaces and the usual separators.";
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return "Phone number looks too short.";
  if (digits.length > 15) return "Phone number looks too long (max 15 digits).";
  return null;
}

/** Masks an API key for display: "abcd…wxyz". Never returns the full key. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "••••";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
