"use client";
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

export type Role = "admin" | "manager" | "technician";
export type Profile = { id: string; full_name: string | null; role: Role; email: string | null };

export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function load() {
      if (!supabase) { setLoading(false); return; }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setLoading(false); return; }

      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, role")
        .eq("id", session.user.id)
        .single();

      if (active && !error && data) {
        setProfile({ ...data, email: session.user.email ?? null });
      }
      if (active) setLoading(false);
    }

    load();

    const { data: sub } = supabase?.auth.onAuthStateChange(() => load()) ?? { data: { subscription: null } };
    return () => { active = false; sub.subscription?.unsubscribe(); };
  }, []);

  return { profile, loading };
}

// Which sidebar sections each role can see, in order. These are the single
// source of truth for role navigation — sections render directly in the main
// panel, there's no separate top-tab layer inside each role's view.
//
// "technician" has no authenticated nav at all — that role is now served by
// the public, no-login /monitor page instead of a dashboard section (see
// app/dashboard/page.tsx, which redirects technician accounts there).
export const NAV_BY_ROLE: Record<Role, string[]> = {
  technician: [],
  manager: ["Overview", "Greenhouses", "Recycle bin"],
  admin: ["Overview", "Team", "System settings", "Activity Logs"],
};