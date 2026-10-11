import { NextRequest, NextResponse } from "next/server";
import {
  createServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { validAccountEmail } from "@/lib/account-email";
import {
  parseOfflineThreshold,
  validateManagerPhone,
} from "@/lib/admin-notification-settings";

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
  "manager_user_id",
  "default_illumination_start",
  "default_illumination_end",
  "dark_phase_duration_days",
  "sensor_offline_threshold_seconds",
  "sms_provider",
  "sms_dispatch_mode",
  "textbee_api_key",
  "smsgate_username",
  "smsgate_password",
] as const;

type SettingsKey = (typeof SETTINGS_KEYS)[number];

/**
 * Keys a manager may READ. SMS gateway credentials is deliberately absent:
 * a manager configures greenhouses, not credentials, and the key only ever
 * needs to reach an admin and the Edge Function. Managers already read
 * manager_phone because the Greenhouses form pre-fills from the defaults.
 */
const MANAGER_READABLE_KEYS: readonly string[] = [
  "manager_phone",
  "default_illumination_start",
  "default_illumination_end",
  "dark_phase_duration_days",
];

/**
 * SMS gateway credentials are secret. They are never returned by GET in full —
 * only a boolean saying whether one is set, plus a masked preview — so the
 * browser never receives a value it could leak into a screenshot, a
 * support ticket, or a React DevTools dump. Writing a new one replaces it.
 */
const SECRET_KEYS: readonly string[] = ["textbee_api_key", "smsgate_username", "smsgate_password"];

function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "••••";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function buildSettingsResponse(
  byKey: Map<string, { value: string; updated_at?: string }>,
  updatedAt: string | null
) {
  return {
    manager_phone: byKey.get("manager_phone")?.value ?? "",
    manager_user_id: byKey.get("manager_user_id")?.value ?? "",
    default_illumination_start: byKey.get("default_illumination_start")?.value ?? "",
    default_illumination_end: byKey.get("default_illumination_end")?.value ?? "",
    dark_phase_duration_days: byKey.get("dark_phase_duration_days")?.value ?? "",
    sensor_offline_threshold_seconds:
      byKey.get("sensor_offline_threshold_seconds")?.value ?? "",
    sms_dispatch_mode: byKey.get("sms_dispatch_mode")?.value ?? "cloud",
    sms_provider: byKey.get("sms_provider")?.value ?? "",
    // Never the real value.
    textbee_api_key_set: Boolean(byKey.get("textbee_api_key")?.value?.trim()),
    textbee_api_key_preview: maskSecret(byKey.get("textbee_api_key")?.value ?? ""),
    smsgate_username_set: Boolean(byKey.get("smsgate_username")?.value?.trim()),
    smsgate_password_set: Boolean(byKey.get("smsgate_password")?.value?.trim()),
    updated_at: updatedAt,
  };
}

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
  // Returns the resolved role alongside the user so the caller can decide
  // which keys that role may see.
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

  return { user, role: profile.role as string };
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

  // A manager gets only the keys they legitimately need; the SMS gateway
  // credentials and the offline threshold are admin configuration.
  const visibleKeys =
    authorization.role === "admin" ? SETTINGS_KEYS : MANAGER_READABLE_KEYS;

  const { data, error } = await admin
    .from("system_settings")
    .select("key, value, updated_at")
    .in("key", visibleKeys);

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  const byKey = new Map((data ?? []).map(row => [row.key, row]));

  const response = buildSettingsResponse(byKey, data?.[0]?.updated_at ?? null);

  // Belt and braces: even for an admin, the real key is never in the
  // payload. buildSettingsResponse already omits it; this makes the intent
  // explicit at the call site so a future refactor cannot reintroduce it.
  if (SECRET_KEYS.some(key => key in response)) {
    return NextResponse.json(
      { error: "Refusing to return secret settings." },
      { status: 500 }
    );
  }

  return NextResponse.json(response);
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

  const dispatchMode = updates.find(u => u.key === "sms_dispatch_mode")?.value;
  if (dispatchMode !== undefined && !["cloud", "local"].includes(dispatchMode)) {
    return NextResponse.json({error: "Choose cloud or local SMS dispatch."}, {status: 400});
  }
  if (dispatchMode === "cloud") {
    const current = await admin.from("system_settings").select("value").eq("key", "sms_dispatch_mode").maybeSingle();
    if (current.error) return NextResponse.json({error:"Unable to verify SMS ownership."}, {status:503});
    if (current.data?.value === "local") return NextResponse.json({error:"Stop the Pi SMS worker and follow the local SMS rollback guide before returning to cloud dispatch."}, {status:409});
  }
  const provider = updates.find(u => u.key === "sms_provider")?.value;
  if (provider && !["textbee", "smsgate"].includes(provider)) {
    return NextResponse.json({ error: "Choose SMSGate or TextBee." }, { status: 400 });
  }
  if (updates.find(u => u.key === "smsgate_username")?.value.includes(":")) {
    return NextResponse.json({ error: "SMSGate username cannot contain a colon." }, { status: 400 });
  }

  const managerId = updates.find(u => u.key === "manager_user_id")?.value;
  if (managerId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(managerId)) {
      return NextResponse.json({error: "Choose a verified manager account."}, {status: 400});
    }
    const [{data: account, error: accountError}, profile] = await Promise.all([
      admin.auth.admin.getUserById(managerId), admin.from("profiles").select("role").eq("id", managerId).maybeSingle(),
    ]);
    if (accountError || profile.error || profile.data?.role !== "manager" || !account.user?.email || !validAccountEmail(account.user.email) || !account.user.email_confirmed_at) {
      return NextResponse.json({error: "Choose a verified manager account."}, {status: 400});
    }
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

  // The offline threshold is validated server-side as well as in the form:
  // this is the number the pg_cron job uses to mark sensors offline, and a
  // value below the floor would have every healthy sensor flagged dead
  // between its 10-second samples.
  if (updates.some(u => u.key === "sensor_offline_threshold_seconds")) {
    const raw = updates.find(u => u.key === "sensor_offline_threshold_seconds")!.value;
    const threshold = parseOfflineThreshold(raw);
    if (!threshold.ok) {
      return NextResponse.json({ error: threshold.error }, { status: 400 });
    }
  }

  if (updates.some(u => u.key === "manager_phone")) {
    const phoneError = validateManagerPhone(
      updates.find(u => u.key === "manager_phone")!.value
    );
    if (phoneError) {
      return NextResponse.json({ error: phoneError }, { status: 400 });
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

  return NextResponse.json(
    buildSettingsResponse(byKey, data?.[0]?.updated_at ?? null)
  );
}
