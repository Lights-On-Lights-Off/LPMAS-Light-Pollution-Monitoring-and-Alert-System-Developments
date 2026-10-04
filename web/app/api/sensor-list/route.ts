import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { buildSensorList, parseQuery } from "@/lib/sensor-list";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * GET /api/sensor-list
 *
 * Returns the sensors the cloud currently knows about, optionally filtered
 * by greenhouse and status.
 *
 * This is the same public device context used by /monitor. Read through
 * anonymous RLS so a public request never bypasses database permissions.
 */
export async function GET(request: NextRequest) {
  if (!supabaseUrl || !publishableKey) {
    return NextResponse.json(
      { error: "Supabase service configuration is missing." },
      { status: 500 }
    );
  }

  const query = parseQuery(request.nextUrl.searchParams);

  const publicClient = createClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await publicClient
    .from("sensor_list")
    .select("sensor_id,lux,status,last_reading_at,greenhouse_id,created_at,updated_at");

  if (error) {
    return NextResponse.json({ error: "Sensor list unavailable." }, { status: 503 });
  }

  return NextResponse.json(buildSensorList(data, query));
}
