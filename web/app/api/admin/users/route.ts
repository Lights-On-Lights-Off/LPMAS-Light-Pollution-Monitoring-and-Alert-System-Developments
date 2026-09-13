import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  createServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Role = "admin" | "manager";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const publishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_ROLES: Role[] = ["admin", "manager"];


/* ============================================================
   SERVER AUTH CLIENT
   ============================================================ */

async function getServerSupabase(): Promise<SupabaseClient | null> {
  const cookieStore = await cookies();

  if (!supabaseUrl || !publishableKey) {
    return null;
  }

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
            cookiesToSet.forEach(
              ({ name, value, options }) => {
                cookieStore.set(name, value, options);
              }
            );
          } catch {
            /*
             * Cookie writes may fail in some read-only server
             * contexts. Authentication itself is still handled
             * through Supabase.
             */
          }
        },
      },
    }
  );
}

/* ============================================================
   PRIVILEGED ADMIN CLIENT
   ============================================================ */

function getAdminClient(): SupabaseClient | null {
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createClient(
    supabaseUrl,
    serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}


/* ============================================================
   COMMON RESPONSES
   ============================================================ */

const NOT_CONFIGURED = NextResponse.json(
  {
    error:
      "Supabase server configuration is incomplete. " +
      "Make sure NEXT_PUBLIC_SUPABASE_URL and " +
      "SUPABASE_SERVICE_ROLE_KEY are configured.",
  },
  { status: 501 }
);


/* ============================================================
   AUTHORIZATION
   ============================================================ */

async function requireAdmin() {
  const authClient = await getServerSupabase();

  if (!authClient) {
    return {
      ok: false as const,
      response: NOT_CONFIGURED,
    };
  }

  const {
    data: { user },
    error: userError,
  } = await authClient.auth.getUser();

  if (userError || !user) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      ),
    };
  }

  /*
   * Read the current user's profile through the authenticated
   * Supabase session.
   *
   * The RLS policy created in the auth migration allows users
   * to read their own profile.
   */
  const { data: profile, error: profileError } =
    await authClient
      .from("profiles")
      .select("id, role")
      .eq("id", user.id)
      .maybeSingle();

  if (profileError) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: profileError.message },
        { status: 500 }
      ),
    };
  }

  if (!profile || profile.role !== "admin") {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Administrator access required." },
        { status: 403 }
      ),
    };
  }

  return {
    ok: true as const,
    user,
    profile,
  };
}


/* ============================================================
   ROLE VALIDATION
   ============================================================ */

function isValidRole(value: unknown): value is Role {
  return (
    typeof value === "string" &&
    VALID_ROLES.includes(value as Role)
  );
}


/* ============================================================
   GET
   List authenticated users.
   Admin only.
   ============================================================ */

export async function GET() {
  const authorization = await requireAdmin();

  if (!authorization.ok) {
    return authorization.response;
  }

  const admin = getAdminClient();

  if (!admin) {
    return NOT_CONFIGURED;
  }

  const [
    { data: authUsers, error: authError },
    { data: profiles, error: profileError },
  ] = await Promise.all([
    admin.auth.admin.listUsers(),
    admin
      .from("profiles")
      .select("id, full_name, role"),
  ]);

  if (authError) {
    return NextResponse.json(
      { error: authError.message },
      { status: 500 }
    );
  }

  if (profileError) {
    return NextResponse.json(
      { error: profileError.message },
      { status: 500 }
    );
  }

  const profileById = new Map(
    (profiles ?? []).map((profile) => [
      profile.id,
      profile,
    ])
  );

  const users = (authUsers?.users ?? []).map((user) => {
    const profile = profileById.get(user.id);

    return {
      id: user.id,
      email: user.email ?? "",
      full_name: profile?.full_name ?? null,

      /*
       * There is no technician role anymore.
       *
       * A missing profile is represented as null rather than
       * inventing a role that no longer exists.
       */
      role: isValidRole(profile?.role)
        ? profile.role
        : null,
    };
  });

  return NextResponse.json({ users });
}


/* ============================================================
   POST
   Invite a new Admin or Manager.
   Admin only.
   ============================================================ */

export async function POST(req: NextRequest) {
  const authorization = await requireAdmin();

  if (!authorization.ok) {
    return authorization.response;
  }

  const admin = getAdminClient();

  if (!admin) {
    return NOT_CONFIGURED;
  }

  let body: {
    email?: unknown;
    role?: unknown;
    full_name?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body." },
      { status: 400 }
    );
  }

  const email =
    typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";

  const fullName =
    typeof body.full_name === "string"
      ? body.full_name.trim()
      : "";

  const role = body.role;

  if (!email || !role) {
    return NextResponse.json(
      {
        error:
          "email and role are required.",
      },
      { status: 400 }
    );
  }

  if (!isValidRole(role)) {
    return NextResponse.json(
      {
        error:
          "Invalid role. Allowed roles are admin and manager.",
      },
      { status: 400 }
    );
  }

  /*
   * Basic email validation.
   *
   * This is intentionally simple because Supabase also performs
   * its own email validation.
   */
  if (!email.includes("@")) {
    return NextResponse.json(
      { error: "A valid email address is required." },
      { status: 400 }
    );
  }

  /*
   * The database trigger creates the initial profile as manager.
   * We then explicitly set the requested role below.
   */
  const {
    data,
    error: inviteError,
  } =
    await admin.auth.admin.inviteUserByEmail(
      email,
      {
        data: {
          full_name: fullName || null,
        },
      }
    );

  if (inviteError) {
    return NextResponse.json(
      { error: inviteError.message },
      { status: 400 }
    );
  }

  if (!data.user) {
    return NextResponse.json(
      { error: "Supabase did not return the invited user." },
      { status: 500 }
    );
  }

  const { error: profileError } =
    await admin
      .from("profiles")
      .upsert(
        {
          id: data.user.id,
          role,
          full_name: fullName || null,
        },
        {
          onConflict: "id",
        }
      );

  if (profileError) {
    /*
     * The Auth invitation may already have been created.
     * We attempt cleanup so an unsuccessful profile creation
     * does not leave an orphaned invited account.
     */
    await admin.auth.admin.deleteUser(data.user.id);

    return NextResponse.json(
      { error: profileError.message },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      id: data.user.id,
      email: data.user.email ?? email,
      role,
      full_name: fullName || null,
    },
    { status: 201 }
  );
}


/* ============================================================
   PATCH
   Change a user's role.
   Admin only.
   ============================================================ */

export async function PATCH(req: NextRequest) {
  const authorization = await requireAdmin();

  if (!authorization.ok) {
    return authorization.response;
  }

  const admin = getAdminClient();

  if (!admin) {
    return NOT_CONFIGURED;
  }

  let body: {
    id?: unknown;
    role?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body." },
      { status: 400 }
    );
  }

  const id =
    typeof body.id === "string"
      ? body.id.trim()
      : "";

  const role = body.role;

  if (!id || !role) {
    return NextResponse.json(
      {
        error:
          "id and role are required.",
      },
      { status: 400 }
    );
  }

  if (!isValidRole(role)) {
    return NextResponse.json(
      {
        error:
          "Invalid role. Allowed roles are admin and manager.",
      },
      { status: 400 }
    );
  }

  /*
   * Prevent an administrator from changing their own role.
   *
   * This prevents an accidental self-demotion from locking
   * the administrator out of the Admin area.
   */
  if (id === authorization.user.id) {
    return NextResponse.json(
      {
        error:
          "You cannot change your own administrator role.",
      },
      { status: 400 }
    );
  }

  /*
   * Confirm the target profile exists.
   */
  const {
    data: targetProfile,
    error: targetError,
  } =
    await admin
      .from("profiles")
      .select("id, role")
      .eq("id", id)
      .maybeSingle();

  if (targetError) {
    return NextResponse.json(
      { error: targetError.message },
      { status: 500 }
    );
  }

  if (!targetProfile) {
    return NextResponse.json(
      { error: "User profile not found." },
      { status: 404 }
    );
  }

  /*
   * Prevent the last administrator from being demoted.
   */
  if (
    targetProfile.role === "admin" &&
    role === "manager"
  ) {
    const {
      count,
      error: countError,
    } =
      await admin
        .from("profiles")
        .select("id", {
          count: "exact",
          head: true,
        })
        .eq("role", "admin");

    if (countError) {
      return NextResponse.json(
        { error: countError.message },
        { status: 500 }
      );
    }

    if ((count ?? 0) <= 1) {
      return NextResponse.json(
        {
          error:
            "The last administrator cannot be demoted. Add another administrator first.",
        },
        { status: 409 }
      );
    }
  }

  const { error } =
    await admin
      .from("profiles")
      .update({ role })
      .eq("id", id);

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    id,
    role,
  });
}


/* ============================================================
   DELETE
   Delete an authenticated user and their profile.
   Admin only.
   ============================================================ */

export async function DELETE(req: NextRequest) {
  const authorization = await requireAdmin();

  if (!authorization.ok) {
    return authorization.response;
  }

  const admin = getAdminClient();

  if (!admin) {
    return NOT_CONFIGURED;
  }

  let body: {
    id?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body." },
      { status: 400 }
    );
  }

  const id =
    typeof body.id === "string"
      ? body.id.trim()
      : "";

  if (!id) {
    return NextResponse.json(
      { error: "id is required." },
      { status: 400 }
    );
  }

  /*
   * Never allow an administrator to delete their own account
   * from this endpoint.
   */
  if (id === authorization.user.id) {
    return NextResponse.json(
      {
        error:
          "You cannot delete your own administrator account.",
      },
      { status: 400 }
    );
  }

  /*
   * Prevent deleting the final administrator.
   */
  const {
    data: targetProfile,
    error: targetError,
  } =
    await admin
      .from("profiles")
      .select("id, role")
      .eq("id", id)
      .maybeSingle();

  if (targetError) {
    return NextResponse.json(
      { error: targetError.message },
      { status: 500 }
    );
  }

  if (!targetProfile) {
    return NextResponse.json(
      { error: "User profile not found." },
      { status: 404 }
    );
  }

  if (targetProfile.role === "admin") {
    const {
      count,
      error: countError,
    } =
      await admin
        .from("profiles")
        .select("id", {
          count: "exact",
          head: true,
        })
        .eq("role", "admin");

    if (countError) {
      return NextResponse.json(
        { error: countError.message },
        { status: 500 }
      );
    }

    if ((count ?? 0) <= 1) {
      return NextResponse.json(
        {
          error:
            "The last administrator cannot be deleted.",
        },
        { status: 409 }
      );
    }
  }

  /*
   * Delete the Auth account first.
   *
   * If the database later gains an ON DELETE CASCADE from
   * profiles → auth.users, the explicit profile delete below
   * can remain harmlessly conditional.
   */
  const { error: authError } =
    await admin.auth.admin.deleteUser(id);

  if (authError) {
    return NextResponse.json(
      { error: authError.message },
      { status: 500 }
    );
  }

  const { error: profileError } =
    await admin
      .from("profiles")
      .delete()
      .eq("id", id);

  if (profileError) {
    /*
     * The Auth user is already deleted at this point.
     * Return the database error so it is visible rather than
     * pretending the entire operation was perfectly clean.
     */
    return NextResponse.json(
      {
        error:
          `Auth account deleted, but profile cleanup failed: ${profileError.message}`,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
  });
}