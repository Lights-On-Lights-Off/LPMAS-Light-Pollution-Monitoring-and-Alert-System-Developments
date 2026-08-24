"use client";
import type { ComponentType } from "react";
import { ClipboardList, Gauge, LogOut, Recycle, Sprout, Settings, Users } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useProfile, NAV_BY_ROLE } from "@/lib/profile";
import { useRouter } from "next/navigation";

// Icon + description per section — every section a role can see must have an entry here.
const SECTION_META: Record<string, { icon: ComponentType<{ size?: number }>; hint: string }> = {
  "Overview":         { icon: Gauge,   hint: "Live status & KPIs" },
  "Team":             { icon: Users,   hint: "Members & access" },
  "System settings":  { icon: Settings, hint: "Phase cycle & data" },
  "Activity Logs":    { icon: ClipboardList, hint: "Full system log" },
  "Greenhouses":       { icon: Sprout, hint: "Active crop entries" },
  "Recycle bin":       { icon: Recycle, hint: "Deleted records" }
};

export function Sidebar({ active = "Overview", onNavigate = () => {} }: { active?: string; onNavigate?: (section: string) => void }) {
  const router = useRouter();
  const { profile } = useProfile();

  async function signOut() {
    await supabase?.auth.signOut();
    router.replace("/login");
  }

  const sections = profile ? NAV_BY_ROLE[profile.role] : NAV_BY_ROLE.admin;

  return <aside className="metal-panel hidden min-h-screen w-64 shrink-0 flex-col border-r border-metal-600 p-5 lg:flex">
    <div className="mb-10 flex items-center gap-3 px-2">
      <img src="/Hayag-logo.png" alt="Hayag logo" className="h-11 w-11 rounded-2xl object-contain ring-1 ring-metal-600" />
      <div>
        <p className="font-bold tracking-wide text-metal-50">LPMAS</p>
        <p className="text-xs text-metal-400">Flowerland Monitor</p>
      </div>
    </div>

    <nav className="space-y-1">
      {sections.map(label => {
        const meta = SECTION_META[label];
        const Icon = meta?.icon ?? Gauge;
        const isActive = active === label;
        return <button
          key={label}
          onClick={() => onNavigate(label)}
          className={`group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition ${
            isActive
              ? "bg-leaf-500/12 font-semibold text-leaf-500 shadow-metal ring-1 ring-leaf-500/20"
              : "text-metal-300 hover:bg-white/[0.04] hover:text-metal-100"
          }`}
        >
          <Icon size={19} />
          <span>{label}</span>
        </button>;
      })}
    </nav>

    <div className="mt-auto rounded-2xl border border-metal-600 bg-metal-900/60 p-4">
      <p className="truncate text-sm font-semibold capitalize text-metal-100">{profile?.full_name || profile?.role || "Loading..."}</p>
      <p className="mt-1 truncate text-xs text-metal-400">{profile?.email ?? ""}</p>
      <button onClick={signOut} className="mt-4 flex items-center gap-2 text-xs font-medium text-metal-300 hover:text-leaf-500">
        <LogOut size={15} /> Sign out
      </button>
    </div>
  </aside>;
}
