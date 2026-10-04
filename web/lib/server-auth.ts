import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export async function serverAuth() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const jar = await cookies();
  return createServerClient(url, key, {cookies: {
    getAll: () => jar.getAll(),
    setAll: (values: {name: string; value: string; options: CookieOptions}[]) => { for (const {name, value, options} of values) jar.set(name, value, options); },
  }});
}
export function backendClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false}}) : null;
}
export async function verifiedAdministrator() {
  const auth = await serverAuth();
  if (!auth) return null;
  const {data, error} = await auth.auth.getUser();
  if (error || !data.user?.email || !data.user.email_confirmed_at) return null;
  const profile = await auth.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  return !profile.error && profile.data?.role === "admin" ? data.user : null;
}
