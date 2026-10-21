import { parseAlertRecipients } from "@/lib/alert-recipients";
import { testEmailMessage } from "../../../../../../supabase/functions/_shared/notification-content";
import { NextRequest, NextResponse } from "next/server";
import { backendClient, verifiedAdministrator } from "@/lib/server-auth";
import { configuredWebOrigin } from "@/lib/google-oauth";
import { gmailAuthorization } from "@/lib/gmail-authorization";
import { sendGmailDetailed, validEmail } from "../../../../../../supabase/functions/_shared/gmail-delivery";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("Origin");
  if (request.headers.get("Sec-Fetch-Site") === "cross-site" ||
      (origin && origin !== (configuredWebOrigin() ?? request.nextUrl.origin))) {
    return NextResponse.json({ error: "Request origin not permitted." }, { status: 403 });
  }
  if (!await verifiedAdministrator()) {
    return NextResponse.json({ error: "Verified administrator required." }, { status: 403 });
  }
  const admin = backendClient();
  if (!admin) {
    return NextResponse.json({ error: "Gmail sending is not configured." }, { status: 503 });
  }
  const settings = await admin.from("system_settings").select("value").eq("key", "notification_recipients").maybeSingle();
  if (settings.error) return NextResponse.json({ error: "Unable to read saved recipients." }, { status: 503 });
  let assignments;
  try { assignments = parseAlertRecipients(JSON.parse(settings.data?.value ?? "[]")).filter(row => row.email_enabled); }
  catch { return NextResponse.json({ error: "Review and save the alert recipient list first." }, { status: 400 }); }
  if (!assignments.length) return NextResponse.json({ error: "Save at least one verified email recipient first." }, { status: 400 });
  const recipients: string[] = [];
  for (const assignment of assignments) {
    const [profile, account] = await Promise.all([
      admin.from("profiles").select("role").eq("id", assignment.user_id).maybeSingle(),
      admin.auth.admin.getUserById(assignment.user_id),
    ]);
    const user = account.data.user;
    if (profile.error || account.error || !["admin", "manager"].includes(profile.data?.role ?? "") || !user?.email_confirmed_at || !validEmail(user.email)) {
      return NextResponse.json({ error: "A saved email recipient is unavailable or unverified. Update the recipient list first." }, { status: 400 });
    }
    if (!recipients.includes(user.email.toLowerCase())) recipients.push(user.email.toLowerCase());
  }
  const authorization = await gmailAuthorization(admin);
  if (authorization.error || !authorization.credentials) {
    return NextResponse.json({ error: authorization.error ?? "Authorize Gmail before sending a test email." }, { status: 400 });
  }
  const credentials = authorization.credentials;
  const results = await Promise.all(recipients.map(async email => ({ email, ...await sendGmailDetailed(credentials,
    credentials.client_id ?? "", credentials.client_secret ?? "", email, testEmailMessage(),
    (url, init) => fetch(url, init), "LPMAS test email") })));
  const accepted = results.filter(result => result.outcome === "accepted").length;
  return NextResponse.json({
    failed: accepted !== results.length,
    message: `${accepted} of ${results.length} test emails accepted by Gmail. Check each inbox and spam folder; delivery is unconfirmed. ` +
      results.filter(result => result.outcome !== "accepted").map(result => `${result.email}: ${result.detail}`).join(" "),
    results,
  });
}
