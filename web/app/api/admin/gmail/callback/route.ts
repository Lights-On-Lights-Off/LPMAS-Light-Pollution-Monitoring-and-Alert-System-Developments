import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { backendClient, verifiedAdministrator } from "@/lib/server-auth";
import { configuredWebOrigin, sameNonce } from "@/lib/google-oauth";

export async function GET(request: NextRequest) {
  const origin = configuredWebOrigin();
  if (!origin) return NextResponse.json({error: "Gmail connection is not configured."}, {status: 503});
  const jar = await cookies();
  const stored = jar.get("lpmas_gmail_oauth")?.value;
  jar.set("lpmas_gmail_oauth", "", {httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax", path: "/api/admin/gmail", maxAge: 0});
  let ok = false;
  try {
    const user = await verifiedAdministrator(), admin = backendClient();
    const state = request.nextUrl.searchParams.get("state") ?? "", code = request.nextUrl.searchParams.get("code");
    const saved = stored ? JSON.parse(stored) : null;
    if (!user || !admin || !saved || saved.userId !== user.id || !state || !sameNonce(state, saved.state) || !code || request.nextUrl.searchParams.has("error")) throw new Error();
    const clientId = process.env.GOOGLE_GMAIL_CLIENT_ID, clientSecret = process.env.GOOGLE_GMAIL_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error();
    const tokens = await fetch("https://oauth2.googleapis.com/token", {method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({code, client_id: clientId, client_secret: clientSecret, code_verifier: saved.verifier,
        redirect_uri: `${origin}/api/admin/gmail/callback`, grant_type: "authorization_code"})});
    if (!tokens.ok) throw new Error();
    const token = await tokens.json();
    if (typeof token.refresh_token !== "string" || typeof token.access_token !== "string" || !String(token.scope).split(" ").includes("https://www.googleapis.com/auth/gmail.send")) throw new Error();
    const identity = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {Authorization: `Bearer ${token.access_token}`}, redirect: "error", signal: AbortSignal.timeout(10_000), cache: "no-store",
    });
    if (!identity.ok) throw new Error();
    const google = await identity.json();
    if (google.email_verified !== true || typeof google.email !== "string" || google.email.toLowerCase() !== user.email!.toLowerCase()) throw new Error();
    const {error} = await admin.rpc("set_gmail_authorization", {p_admin_user_id: user.id,
      p_sender_email: google.email.toLowerCase(), p_refresh_token: token.refresh_token});
    if (error) throw new Error();
    ok = true;
  } catch { /* Never send tokens or upstream details to the browser or logs. */ }
  const response = NextResponse.redirect(`${origin}/dashboard?section=system-settings&gmail=${ok ? "connected" : "failed"}`);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
