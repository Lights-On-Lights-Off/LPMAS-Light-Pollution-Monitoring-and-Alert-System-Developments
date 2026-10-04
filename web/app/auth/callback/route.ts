import { NextRequest, NextResponse } from "next/server";
import { serverAuth } from "@/lib/server-auth";
import { configuredWebOrigin } from "@/lib/google-oauth";

export async function GET(request: NextRequest) {
  const origin = configuredWebOrigin();
  if (!origin) return NextResponse.json({error: "Sign-in callback is not configured."}, {status: 503});
  const auth = await serverAuth();
  const code = request.nextUrl.searchParams.get("code");
  if (auth && code && !request.nextUrl.searchParams.has("error")) {
    const result = await auth.auth.exchangeCodeForSession(code);
    if (!result.error) {
      const {data, error} = await auth.auth.getUser();
      if (!error && data.user?.email_confirmed_at) {
        const profile = await auth.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
        if (!profile.error && ["admin", "manager"].includes(profile.data?.role ?? "")) {
          return NextResponse.redirect(`${origin}/dashboard`);
        }
      }
      await auth.auth.signOut();
    }
  }
  return NextResponse.redirect(`${origin}/login?google=failed`);
}
