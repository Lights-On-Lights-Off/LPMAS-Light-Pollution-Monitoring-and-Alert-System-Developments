"use client";
import { Activity, BellRing, Gauge, LogOut, Settings, ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { logActivity } from "@/lib/activityLog";
import { useProfile, NAV_BY_ROLE } from "@/lib/profile";
import { useRouter } from "next/navigation";

type DashboardSection = "Overview" | "Greenhouses" | "Activity Logs" | "Recycle bin" | "Team" | "System settings" | "Appearance";

const ALL_NAV = [
  [Gauge, "Overview"], [Activity, "Greenhouses"], [Activity, "Activity Logs"], [BellRing, "Recycle bin"]
] as const;

const ADMIN_NAV = [
  [Gauge, "Overview"], [ShieldCheck, "Team"], [Settings, "System settings"], [Activity, "Activity Logs"]
] as const;

export function Sidebar({ active = "Overview", onNavigate }: { active?: DashboardSection; onNavigate: (page: DashboardSection) => void }) {
  const router = useRouter();
  const { profile } = useProfile();

  async function navigate(page: DashboardSection) {
    if (page !== active) await logActivity("NAVIGATE", page.toLowerCase().replace(/\s+/g, "_"), undefined, { from: active, to: page });
    onNavigate(page);
  }

  async function signOut() {
    await logActivity("SIGN_OUT", "authentication");
    await supabase?.auth.signOut();
    router.replace("/login");
  }

  const nav = profile?.role === "admin" ? ADMIN_NAV : ALL_NAV;
  const visibleNav = profile ? nav.filter(([, label]) => NAV_BY_ROLE[profile.role].includes(label)) : nav;

  return <aside className="relative hidden h-screen w-72 shrink-0 flex-col overflow-hidden bg-[var(--surface)]/35 p-5 text-[var(--foreground)] shadow-2xl backdrop-blur-3xl backdrop-saturate-150 lg:sticky lg:top-0 lg:flex">
    <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[var(--accent)]/[0.06] via-transparent to-[var(--accent)]/[0.02]" />
    <div className="pointer-events-none absolute -left-20 top-20 h-64 w-64 rounded-full bg-[var(--accent)]/8 blur-3xl" />
    <div className="pointer-events-none absolute -right-24 bottom-10 h-72 w-72 rounded-full bg-[var(--accent)]/5 blur-3xl" />

    <div className="relative mb-10 flex items-center gap-3 px-2">
      <img src="/Hayag-logo.png" alt="Hayag logo" className="h-11 w-11 rounded-2xl object-contain shadow-lg" />
      <div>
        <p className="font-bold tracking-wide text-[var(--foreground)]">LPMAS</p>
        <p className="text-xs text-[var(--accent)]">Flowerland Monitor</p>
      </div>
    </div>

    <nav className="relative space-y-2">
      {visibleNav.map(([Icon, label]) => {
        const selected = active === label;
        return <button key={label} onClick={() => navigate(label as DashboardSection)} className={`group flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition ${selected ? "[background:color-mix(in_srgb,var(--accent)_18%,transparent)] font-semibold text-[var(--foreground)] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur-xl" : "text-[var(--muted-foreground)] hover:[background:color-mix(in_srgb,var(--accent)_8%,transparent)] hover:text-[var(--foreground)]"}`}>
          <Icon size={19} className={selected ? "text-[var(--accent)]" : "text-[var(--muted-foreground)] group-hover:text-[var(--accent)]"} />
          <span>{label}</span>
          {selected && <span className="ml-auto h-2 w-2 rounded-full bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]" />}
        </button>;
      })}

      <button onClick={() => navigate("Appearance")} className={`group flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition ${active === "Appearance" ? "[background:color-mix(in_srgb,var(--accent)_18%,transparent)] font-semibold text-[var(--foreground)] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur-xl" : "text-[var(--muted-foreground)] hover:[background:color-mix(in_srgb,var(--accent)_8%,transparent)] hover:text-[var(--foreground)]"}`}>
        <Settings size={19} className={active === "Appearance" ? "text-[var(--accent)]" : "text-[var(--muted-foreground)] group-hover:text-[var(--accent)]"} />
        <span>Appearance</span>
        {active === "Appearance" && <span className="ml-auto h-2 w-2 rounded-full bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]" />}
      </button>
    </nav>

    <div className="relative mt-auto rounded-2xl [background:color-mix(in_srgb,var(--accent)_5%,transparent)] p-4 shadow-xl backdrop-blur-2xl">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl [background:color-mix(in_srgb,var(--accent)_15%,transparent)] text-sm font-bold uppercase text-[var(--accent)] ring-1 ring-[color-mix(in_srgb,var(--accent)_25%,transparent)]">
          {(profile?.full_name || profile?.role || "U").charAt(0)}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[var(--foreground)]">{profile?.full_name || profile?.role || "Loading..."}</p>
          <p className="truncate text-xs text-[var(--muted-foreground)]">{profile?.email ?? ""}</p>
        </div>
      </div>

      <button onClick={signOut} className="mt-4 flex items-center gap-2 rounded-lg px-2 py-2 text-xs text-[var(--muted-foreground)] transition hover:bg-red-500/10 hover:text-red-500">
        <LogOut size={15} />
        Sign out
      </button>
    </div>
  </aside>;
}