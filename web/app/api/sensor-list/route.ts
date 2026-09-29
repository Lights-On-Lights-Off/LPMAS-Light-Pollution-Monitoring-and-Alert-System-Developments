import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { buildSensorList, parseQuery } from "@/lib/sensor-list";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * GET /api/sensor-list
 *
 * Returns the sensors the cloud currently knows about, optionally filtered
 * by greenhouse and status.
 *
 * Read with the service role rather than the anon key: sensor_list is only
 * writable by the Edge Function, and this route filters server-side so the
 * filtering logic stays in one tested place (lib/sensor-list.ts) instead of
 * being duplicated in a PostgREST query chain. Rows are not secret — they are
 * device ids, lux and liveness — but they are also not public, so this stays
 * behind authentication rather than being open like /monitor.
 */
export async function GET(request: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { error: "Supabase service configuration is missing." },
      { status: 500 }
    );
  }

  const query = parseQuery(request.nextUrl.searchParams);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin
    .from("sensor_list")
    .select("sensor_id,lux,status,last_reading_at,greenhouse_id,created_at,updated_at");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(buildSensorList(data, query));
}
