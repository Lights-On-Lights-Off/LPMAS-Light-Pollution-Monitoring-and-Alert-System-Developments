"use client";
import { Suspense,useEffect } from "react";
import { useRouter,useSearchParams } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { ManagerView } from "@/components/views/ManagerView";
import { AdminView } from "@/components/views/AdminView";
import { Appearance } from "@/components/appearance";
import { useProfile,NAV_BY_ROLE } from "@/lib/profile";
type DashboardSection = "Overview" | "Greenhouses" | "Recycle bin" | "Team" | "System settings" | "Activity Logs" | "Appearance";
const sections: DashboardSection[] = ["Overview","Greenhouses","Recycle bin","Team","System settings","Activity Logs","Appearance"];
const slug = (section: string) => section.toLowerCase().replace(/\s+/g,"-");
function DashboardContent() {
  const {profile,loading} = useProfile();
  const router = useRouter(),params = useSearchParams();
  const section = sections.find(s => slug(s) === params.get("section")) ?? "Overview";
  useEffect(() => {
    if (loading) return;
    if (!profile) {router.replace("/login");return;}
    if (![...NAV_BY_ROLE[profile.role],"Appearance"].includes(section)) router.replace("/dashboard?section=overview");
  },[profile,loading,section,router]);
  if (loading || !profile) return <div role="status" className="grid min-h-screen place-items-center bg-ink text-theme-muted">Checking dashboard access…</div>;
  return <div className="flex min-h-screen bg-ink">
    <a href="#dashboard-main" className="skip-link">Skip to main content</a>
    <Sidebar active={section} onNavigate={next => router.push(`/dashboard?section=${slug(next)}`)} />
    <main id="dashboard-main" tabIndex={-1} className="min-w-0 flex-1 pt-[env(safe-area-inset-top)] lg:pt-0">
      {section === "Appearance" ? <Appearance /> : profile.role === "manager" ? <ManagerView section={section as "Overview"|"Greenhouses"|"Activity Logs"|"Recycle bin"} /> : <AdminView section={section} />}
    </main>
  </div>;
}
export default function DashboardPage() {return <Suspense fallback={<p className="p-6 text-theme-muted">Loading dashboard…</p>}><DashboardContent /></Suspense>;}
