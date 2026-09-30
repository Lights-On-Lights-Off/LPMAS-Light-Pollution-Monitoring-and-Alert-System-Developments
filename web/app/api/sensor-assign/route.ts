import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

import { assignmentRpcArgs, planAssignment } from "@/lib/sensor-assignment";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * POST /api/sensor-assign
 *
 * Body: { sensor_id, greenhouse_id, is_assigned_now }
 *
 * Assigns or unassigns one sensor, calling update_sensor_list via the
 * service role.
 *
 * Why the service role rather than the caller's session: the RPC is
 * SECURITY DEFINER and performs its own admin/manager check against
 * profiles, but a direct PostgREST call from the browser would be subject
 * to RLS on the profiles lookup in a way that is easy to get subtly wrong.
 * This route authenticates the user, checks the role explicitly, and then
 * calls with a key that bypasses RLS. The check here is not decorative: the
 * RPC only performs its own role check when auth.uid() is not null, and a
 * service_role call has a null uid, so without this gate any signed-in
 * account could reassign sensors.
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
          // Read-only server context; the session itself stays valid.
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

  if (!profile || (profile.role !== "admin" && profile.role !== "manager")) {
    return NextResponse.json(
      { error: "You do not have access to this resource." },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Request body must be an object." }, { status: 400 });
  }

  const { sensor_id, greenhouse_id, is_assigned_now } = body as Record<string, unknown>;

  if (typeof is_assigned_now !== "boolean") {
    return NextResponse.json(
      { error: "is_assigned_now must be a boolean." },
      { status: 400 }
    );
  }

  const action = planAssignment({
    sensorId: typeof sensor_id === "string" ? sensor_id : "",
    greenhouseId: typeof greenhouse_id === "string" ? greenhouse_id : "",
    isAssignedNow: is_assigned_now,
  });

  if (action.kind === "noop") {
    return NextResponse.json({ error: action.reason }, { status: 400 });
  }

  const args = assignmentRpcArgs(action)!;

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.rpc("update_sensor_list", args);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // The RPC returns the updated sensor_list row (or a one-element array,
  // depending on the PostgREST shape for a composite return).
  const row = Array.isArray(data) ? data[0] : data;

  return NextResponse.json({
    ok: true,
    action: action.kind,
    sensor: row ?? null,
  });
}
