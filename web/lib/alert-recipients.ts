export const MAX_ALERT_RECIPIENTS = 20;
export type AlertRecipient = { user_id: string; phone: string; email_enabled: boolean; sms_enabled: boolean };

export function parseAlertRecipients(value: unknown): AlertRecipient[] {
  if (!Array.isArray(value) || value.length > MAX_ALERT_RECIPIENTS) {
    throw new Error(`Choose up to ${MAX_ALERT_RECIPIENTS} alert recipients.`);
  }
  const seen = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== "object" || typeof row.user_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.user_id) ||
        typeof row.phone !== "string" || typeof row.email_enabled !== "boolean" || typeof row.sms_enabled !== "boolean") {
      throw new Error("Each recipient needs an account and valid email/SMS options.");
    }
    const user_id = row.user_id.toLowerCase();
    if (seen.has(user_id)) throw new Error("Select each account only once.");
    seen.add(user_id);
    if (!row.email_enabled && !row.sms_enabled) throw new Error("Choose email, SMS, or both for each recipient.");
    const phone = row.phone.trim();
    if (row.sms_enabled && !/^\+639[0-9]{9}$/.test(phone)) throw new Error("SMS recipients need a Philippine mobile number (+639XXXXXXXXX).");
    return { user_id, phone: row.sms_enabled ? phone : "", email_enabled: row.email_enabled, sms_enabled: row.sms_enabled };
  });
}
