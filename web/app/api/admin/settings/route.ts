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

async function requireAdmin() {
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

  if (profile.role !== "admin") {
    return {
      error: NextResponse.json(
        { error: "Administrator access required." },
        { status: 403 }
      ),
    };
  }

  return { user };
}

export async function GET() {
  const authorization = await requireAdmin();

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
    .eq("key", "manager_phone")
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    manager_phone: data?.value ?? "",
    updated_at: data?.updated_at ?? null,
  });
}

export async function PATCH(request: NextRequest) {
  const authorization = await requireAdmin();

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

  const managerPhone =
    typeof body === "object" &&
    body !== null &&
    "manager_phone" in body &&
    typeof body.manager_phone === "string"
      ? body.manager_phone.trim()
      : null;

  if (managerPhone === null) {
    return NextResponse.json(
      { error: "manager_phone must be a string." },
      { status: 400 }
    );
  }

  const { data, error } = await admin
    .from("system_settings")
    .upsert(
      {
        key: "manager_phone",
        value: managerPhone,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "key",
      }
    )
    .select("key, value, updated_at")
    .single();

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    manager_phone: data.value,
    updated_at: data.updated_at,
  });
}