import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

// These privileged operations (listing every auth user's email, creating an
// account, deleting one) require Supabase's SERVICE ROLE key — the anon key
// used everywhere else in the app can't do them, by design (RLS only ever
// exposes what a signed-in user is allowed to see about themselves).
//
// Add SUPABASE_SERVICE_ROLE_KEY to your server environment (Vercel project
// settings, or a non-committed .env.local) — it must NOT be prefixed with
// NEXT_PUBLIC_, or it would ship to the browser. Find it in
// Supabase dashboard → Project settings → API → service_role.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function adminClient() {
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

const NOT_CONFIGURED = NextResponse.json(
  { error: "SUPABASE_SERVICE_ROLE_KEY is not set on the server. Add it to your environment to manage accounts." },
  { status: 501 }
);

export async function GET() {
  const admin = adminClient();
  if (!admin) return NOT_CONFIGURED;

  const [{ data: authUsers, error: authError }, { data: profiles, error: profileError }] = await Promise.all([
    admin.auth.admin.listUsers(),
    admin.from("profiles").select("id, full_name, role")
  ]);

  if (authError) return NextResponse.json({ error: authError.message }, { status: 500 });
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 });

  const profileById = new Map(profiles?.map(p => [p.id, p]) ?? []);
  const users = authUsers.users.map(u => ({
    id: u.id,
    email: u.email ?? "",
    full_name: profileById.get(u.id)?.full_name ?? null,
    role: profileById.get(u.id)?.role ?? "technician"
  }));

  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  const admin = adminClient();
  if (!admin) return NOT_CONFIGURED;

  const { email, role, full_name } = await req.json();
  if (!email || !role) return NextResponse.json({ error: "email and role are required" }, { status: 400 });

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const { error: profileError } = await admin
    .from("profiles")
    .upsert({ id: data.user.id, role, full_name: full_name ?? null });
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 });

  return NextResponse.json({ id: data.user.id, email, role, full_name: full_name ?? null });
}

export async function DELETE(req: NextRequest) {
  const admin = adminClient();
  if (!admin) return NOT_CONFIGURED;

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from("profiles").delete().eq("id", id);
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const admin = adminClient();
  if (!admin) return NOT_CONFIGURED;

  const { id, role } = await req.json();
  if (!id || !role) return NextResponse.json({ error: "id and role are required" }, { status: 400 });

  // Routed through the service-role client (rather than the browser's anon
  // client) so this works regardless of whether RLS lets admins edit other
  // users' rows — the same reasoning as create/delete above.
  const { error } = await admin.from("profiles").update({ role }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
