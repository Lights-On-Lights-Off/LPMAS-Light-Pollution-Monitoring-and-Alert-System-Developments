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

/**
 * Whether a Test SMS can be attempted.
 *
 * Requires all three of the Semaphore key, the sender name and the phone,
 * because the Edge Function returns 400 without any one of them. Checking
 * here lets the button be disabled with a reason instead of letting the
 * operator click through to a 400.
 */
export function canSendTestSms(settings: {
  semaphoreApiKey: string;
  semaphoreSenderName: string;
  managerPhone: string;
}): { enabled: boolean; reason: string | null } {
  if (!settings.semaphoreApiKey.trim()) {
    return { enabled: false, reason: "Enter the Semaphore API key first." };
  }
  if (!settings.semaphoreSenderName.trim()) {
    return { enabled: false, reason: "Enter the Semaphore sender name first." };
  }
  if (!settings.managerPhone.trim()) {
    return { enabled: false, reason: "Enter the manager phone number first." };
  }
  return { enabled: true, reason: null };
}

/** Masks an API key for display: "abcd…wxyz". Never returns the full key. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "••••";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
