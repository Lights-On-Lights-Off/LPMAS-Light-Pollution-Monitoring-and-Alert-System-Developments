import { NextRequest, NextResponse } from "next/server";
import { backendClient, verifiedAdministrator } from "@/lib/server-auth";
import { configuredWebOrigin } from "@/lib/google-oauth";
import { sendTestEmail, validEmail } from "@/lib/gmail-test";

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
  const clientId = process.env.GOOGLE_GMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_GMAIL_CLIENT_SECRET;
  if (!admin || !clientId || !clientSecret) {
    return NextResponse.json({ error: "Gmail sending is not configured." }, { status: 503 });
  }
  const settings = await admin.from("system_settings").select("value").eq("key", "manager_user_id").maybeSingle();
  const managerId = settings.data?.value;
  if (settings.error || !managerId) {
    return NextResponse.json({ error: "Select and save a verified manager recipient first." }, { status: 400 });
  }
  const [profile, account, authorization] = await Promise.all([
    admin.from("profiles").select("role").eq("id", managerId).maybeSingle(),
    admin.auth.admin.getUserById(managerId),
    admin.rpc("get_gmail_authorization", {}),
  ]);
  const recipient = account.data.user;
  if (profile.error || profile.data?.role !== "manager" || account.error ||
      !recipient?.email_confirmed_at || !validEmail(recipient.email)) {
    return NextResponse.json({ error: "The saved recipient must be a verified manager with a valid email." }, { status: 400 });
  }
  if (authorization.error || !authorization.data) {
    return NextResponse.json({ error: "Authorize Gmail before sending a test email." }, { status: 400 });
  }
  const outcome = await sendTestEmail(authorization.data, clientId, clientSecret, recipient.email,
    `LPMAS test email. If you received this, email alert delivery is working. Sent ${new Date().toISOString()}.`,
    (url, init) => fetch(url, init));
  if (outcome === "unknown") {
    return NextResponse.json({ error: "Gmail acceptance could not be confirmed. Check the recipient inbox before sending another test." }, { status: 504 });
  }
  if (outcome !== "accepted") {
    return NextResponse.json({ error: "The test email could not be sent. Check Gmail authorization and sending configuration." }, { status: 502 });
  }
  return NextResponse.json({ message: "Test email accepted by Gmail. Check the manager's inbox and spam folder; delivery is unconfirmed." });
}
