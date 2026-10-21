/** Explain Auth delivery failures without treating account creation as inbox delivery. */
export function describeInvitationError(message: string, code?: string): string {
  const text = `${code ?? ""} ${message}`.toLowerCase();
  if (text.includes("email address not authorized") || text.includes("email_address_not_authorized") || text.includes("not authorized to send")) {
    return "Supabase cannot email this recipient with its default sender. Configure Custom SMTP in Supabase Authentication, then retry the invitation.";
  }
  if (text.includes("rate limit") || text.includes("over_email_send_rate_limit")) {
    return "The invitation email limit has been reached. Wait before retrying, or check your Supabase Custom SMTP limits.";
  }
  if (text.includes("already been registered") || text.includes("already registered")) {
    return "An account already exists for this email. If the user has no password, they can choose Forgot password on the sign-in page.";
  }
  if (text.includes("error sending") || text.includes("smtp")) {
    return "The invitation email could not be sent. Check the Supabase Auth logs and Custom SMTP settings before retrying.";
  }
  return message;
}
