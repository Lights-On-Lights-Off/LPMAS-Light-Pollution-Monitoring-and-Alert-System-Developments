import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { gmailAuthorization } from "@/lib/gmail-authorization";
import { backendClient, verifiedAdministrator } from "@/lib/server-auth";
import { configuredWebOrigin, oauthNonce, oauthChallenge } from "@/lib/google-oauth";

export async function POST() {
  const user = await verifiedAdministrator();
  if (!user) return NextResponse.json({error: "Verified administrator required."}, {status: 403});
  const admin=backendClient();
  const saved=admin ? await gmailAuthorization(admin) : null;
  const origin = configuredWebOrigin(), clientId = saved?.credentials?.client_id || process.env.GOOGLE_GMAIL_CLIENT_ID;
  const clientSecret=saved?.credentials?.client_secret || process.env.GOOGLE_GMAIL_CLIENT_SECRET;
  if (saved?.error || !origin || !clientId || !clientSecret) return NextResponse.json({error: "Gmail connection is not configured."}, {status: 503});
  const state = oauthNonce(), verifier = oauthNonce();
  const jar = await cookies();
  jar.set("lpmas_gmail_oauth", JSON.stringify({state, verifier, userId: user.id}), {
    httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax", path: "/api/admin/gmail", maxAge: 600,
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({client_id: clientId, redirect_uri: `${origin}/api/admin/gmail/callback`,
    response_type: "code", scope: "openid email https://www.googleapis.com/auth/gmail.send",
    state, code_challenge: oauthChallenge(verifier), code_challenge_method: "S256",
    access_type: "offline", prompt: "consent", login_hint: user.email!}).toString();
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
