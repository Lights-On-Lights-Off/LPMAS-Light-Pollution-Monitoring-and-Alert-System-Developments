import { NextRequest, NextResponse } from "next/server";
import {
  createServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Keys this route reads/writes in system_settings, and which roles may do
// which. manager_phone/default_* are readable by managers too, since the
// Greenhouses page pre-fills its form from the defaults; only admins may
// write any of them.
const SETTINGS_KEYS = [
  "manager_phone",
  "default_illumination_start",
  "default_illumination_end",
  "dark_phase_duration_days",
] as const;

type SettingsKey = (typeof SETTINGS_KEYS)[number];

async function getServerSupabase() {
  if (!supabaseUrl || !publishableKey) {
    return null;
  }

  const cookieStore = await cookies();

  return createServerClient(
    supabaseUrl,
    publishableKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },

        setAll(
          cookiesToSet: {
            name: string;
            value: string;
            options: CookieOptions;
          }[]
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            /*
             * Cookie writes may fail in some read-only server
             * contexts. Authentication itself remains valid.
             */
          }
        },
      },
    }
  );
}

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

async function requireRole(allowedRoles: readonly string[]) {
  const supabase = await getServerSupabase();

  if (!supabase) {
    return {
      error: NextResponse.json(
        { error: "Supabase is not configured." },
        { status: 500 }
      ),
    };
  }

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      error: NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      ),
    };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return {
      error: NextResponse.json(
        { error: "User profile not found." },
        { status: 403 }
      ),
    };
  }

  if (!allowedRoles.includes(profile.role)) {
    return {
      error: NextResponse.json(
        { error: "You do not have access to this resource." },
        { status: 403 }
      ),
    };
  }

  return { user };
}

export async function GET() {
  const authorization = await requireRole(["admin", "manager"]);

  if (authorization.error) {
    return authorization.error;
  }

  const admin = getAdminClient();

  if (!admin) {
    return NextResponse.json(
      { error: "Supabase service configuration is missing." },
      { status: 500 }
    );
  }

  const { data, error } = await admin
    .from("system_settings")
    .select("key, value, updated_at")
    .in("key", SETTINGS_KEYS);

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  const byKey = new Map((data ?? []).map(row => [row.key, row]));

  return NextResponse.json({
    manager_phone: byKey.get("manager_phone")?.value ?? "",
    default_illumination_start: byKey.get("default_illumination_start")?.value ?? "",
    default_illumination_end: byKey.get("default_illumination_end")?.value ?? "",
    dark_phase_duration_days: byKey.get("dark_phase_duration_days")?.value ?? "",
    updated_at: data?.[0]?.updated_at ?? null,
  });
}

export async function PATCH(request: NextRequest) {
  const authorization = await requireRole(["admin"]);

  if (authorization.error) {
    return authorization.error;
  }

  const admin = getAdminClient();

  if (!admin) {
    return NextResponse.json(
      { error: "Supabase service configuration is missing." },
      { status: 500 }
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { error: "Request body must be an object." },
      { status: 400 }
    );
  }

  const updates: { key: SettingsKey; value: string }[] = [];

  for (const key of SETTINGS_KEYS) {
    if (key in body) {
      const raw = (body as Record<string, unknown>)[key];
      if (typeof raw !== "string") {
        return NextResponse.json(
          { error: `${key} must be a string.` },
          { status: 400 }
        );
      }
      updates.push({ key, value: raw.trim() });
    }
  }

  if (!updates.length) {
    return NextResponse.json(
      { error: "No recognized settings provided." },
      { status: 400 }
    );
  }

  if (updates.some(u => u.key === "dark_phase_duration_days")) {
    const days = updates.find(u => u.key === "dark_phase_duration_days")!.value;
    const parsed = Number(days);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return NextResponse.json(
        { error: "dark_phase_duration_days must be a whole number of at least 1." },
        { status: 400 }
      );
    }
  }

  const { error } = await admin
    .from("system_settings")
    .upsert(
      updates.map(u => ({ key: u.key, value: u.value, updated_at: new Date().toISOString() })),
      { onConflict: "key" }
    );

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  const { data, error: readError } = await admin
    .from("system_settings")
    .select("key, value, updated_at")
    .in("key", SETTINGS_KEYS);

  if (readError) {
    return NextResponse.json(
      { error: readError.message },
      { status: 500 }
    );
  }

  const byKey = new Map((data ?? []).map(row => [row.key, row]));

  return NextResponse.json({
    manager_phone: byKey.get("manager_phone")?.value ?? "",
    default_illumination_start: byKey.get("default_illumination_start")?.value ?? "",
    default_illumination_end: byKey.get("default_illumination_end")?.value ?? "",
    dark_phase_duration_days: byKey.get("dark_phase_duration_days")?.value ?? "",
    updated_at: data?.[0]?.updated_at ?? null,
  });
}
