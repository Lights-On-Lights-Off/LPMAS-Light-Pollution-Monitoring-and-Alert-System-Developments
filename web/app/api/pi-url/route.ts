import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Intentionally not gated behind requireAdmin(): the public, unauthenticated
// Monitor page also needs to resolve the current Pi tunnel URL, and the URL
// itself is not a secret (it's the same address that was previously baked
// directly into the client bundle).
export async function GET() {
  const admin = getAdminClient();

  if (!admin) {
    return NextResponse.json(
      { error: "Supabase service configuration is missing." },
      { status: 500 }
    );
  }

  const { data, error } = await admin
    .from("system_settings")
    .select("value, updated_at")
    .eq("key", "pi_api_url")
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  if (!data?.value) {
    return NextResponse.json(
      { error: "Pi API URL is not configured yet." },
      { status: 503 }
    );
  }

  return NextResponse.json({
    url: data.value,
    updated_at: data.updated_at,
  });
}