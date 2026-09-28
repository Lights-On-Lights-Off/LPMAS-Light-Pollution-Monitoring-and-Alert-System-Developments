// app/dashboard/page.tsx
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { ManagerView } from "@/components/views/ManagerView";
import { AdminView } from "@/components/views/AdminView";
import { Appearance } from "@/components/appearance";
import { useProfile, NAV_BY_ROLE } from "@/lib/profile";

type DashboardSection = "Overview" | "Greenhouses" | "Recycle bin" | "Team" | "System settings" | "Activity Logs" | "Appearance";

export default function DashboardPage() {
  const { profile, loading } = useProfile();
  const router = useRouter();
  const [section, setSection] = useState<DashboardSection>("Overview");

  useEffect(() => {
    if (!profile) return;
    const allowed = [...NAV_BY_ROLE[profile.role], "Appearance"];
    if (!allowed.includes(section)) setSection((NAV_BY_ROLE[profile.role][0] ?? "Overview") as DashboardSection);
  }, [profile, section]);

  if (loading) return <div className="grid min-h-screen place-items-center bg-ink text-metal-400">Loading...</div>;

  if (!profile) return <div className="grid min-h-screen place-items-center bg-ink text-metal-400">No profile found. Contact an admin.</div>;

  return <div className="flex min-h-screen bg-ink">
    <Sidebar active={section} onNavigate={setSection} />
    {/* pt-[4.5rem] on mobile clears the fixed hamburger button (top-4, h-11, plus
        the safe-area inset it now respects) so page titles/badges never sit
        underneath it; lg:pt-0 restores flush layout once the sidebar is static. */}
    <main className="min-w-0 flex-1 pt-[calc(4.5rem+env(safe-area-inset-top))] lg:pt-0">
      {section === "Appearance" ? <Appearance /> : profile.role === "manager" ? <ManagerView section={section as "Overview" | "Greenhouses" | "Recycle bin"} /> : <AdminView section={section} />}
    </main>
  </div>;
}