import { NextResponse } from "next/server";
import { backendClient, verifiedAdministrator } from "@/lib/server-auth";
import { configuredWebOrigin } from "@/lib/google-oauth";

export async function GET() {
  if (!await verifiedAdministrator()) return NextResponse.json({error: "Verified administrator required."}, {status: 403});
  const configured = Boolean(configuredWebOrigin() && process.env.GOOGLE_GMAIL_CLIENT_ID && process.env.GOOGLE_GMAIL_CLIENT_SECRET);
  const admin = backendClient();
  if (!admin) return NextResponse.json({error: "Email sending is not configured."}, {status: 503});
  const {data, error} = await admin.rpc("get_gmail_authorization_status", {});
  if (error) return NextResponse.json({error: "Email sending is not configured."}, {status: 503});
  return NextResponse.json({configured, authorized: Boolean(data?.sender_email), sender_email: data?.sender_email ?? null,
    authorized_at: data?.authorized_at ?? null}, {headers: {"Cache-Control": "no-store"}});
}
