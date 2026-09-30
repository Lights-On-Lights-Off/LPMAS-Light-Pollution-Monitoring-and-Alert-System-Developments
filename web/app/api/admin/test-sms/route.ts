import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * POST /api/admin/test-sms
 *
 * Proxies the Admin panel's "Test SMS" button to the send-test-sms Edge
 * Function.
 *
 * Why a proxy: the Edge Function requires a service_role bearer, and the
 * browser must never hold that key — anything in client JavaScript is
 * readable by the user and by anyone who opens DevTools. This route holds
 * the key server-side, so the browser only ever learns whether the test
 * succeeded and why it did not.
 *
 * Admin only, matching the System settings section the button lives in.
 */
export async function POST(request: NextRequest) {
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    return NextResponse.json(
      { error: "Supabase service configuration is missing." },
      { status: 500 }
    );
  }

  const cookieStore = await cookies();

  const userClient = createServerClient(supabaseUrl, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Read-only server context; the session stays valid.
        }
      },
    },
  });

  const {
    data: { user },
  } = await userClient.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { data: profile } = await userClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || profile.role !== "admin") {
    return NextResponse.json(
      { error: "Only an admin can send a test SMS." },
      { status: 403 }
    );
  }

  // The recipient the admin typed into the test field, if any. It is passed
  // through as given rather than filled in from the stored manager phone, so
  // an unusable value is refused by the Edge Function instead of quietly
  // texting somebody else.
  const requested = await request.json().catch(() => ({})) as { to?: unknown };
  const payload = requested.to === undefined ? {} : { to: requested.to };

  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/send-test-sms`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `Could not reach the SMS function: ${reason}` },
      { status: 502 }
    );
  }

  const body = await response.json().catch(() => ({}) as Record<string, unknown>);

  if (!response.ok) {
    // The Edge Function's own reason is the useful part — "Invalid API key"
    // tells the operator what to fix, a bare 502 would not.
    return NextResponse.json(
      { error: String(body.error ?? `The SMS function returned HTTP ${response.status}`) },
      { status: response.status }
    );
  }

  return NextResponse.json(body);
}
