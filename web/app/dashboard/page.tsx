"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { ManagerView } from "@/components/views/ManagerView";
import { AdminView } from "@/components/views/AdminView";
import { useProfile, NAV_BY_ROLE } from "@/lib/profile";

export default function DashboardPage() {
  const { profile, loading } = useProfile();
  const router = useRouter();
  const [section, setSection] = useState("Overview");

  useEffect(() => {
    // Technicians no longer have an authenticated dashboard — that data now
    // lives on the public, no-login /monitor page, so send them straight there.
    if (profile?.role === "technician") router.replace("/monitor");
  }, [profile, router]);

  // Snap back to a valid section whenever the signed-in role changes
  // (e.g. after switching accounts) so we never render a stale tab.
  useEffect(() => {
    if (profile && profile.role !== "technician" && !NAV_BY_ROLE[profile.role].includes(section)) {
      setSection(NAV_BY_ROLE[profile.role][0]);
    }
  }, [profile, section]);

  return <div className="flex min-h-screen bg-ink">
    <Sidebar active={section} onNavigate={setSection} />
    <main className="min-w-0 flex-1">
      {loading && <p className="p-8 text-metal-400">Loading...</p>}
      {!loading && profile?.role === "manager" && <ManagerView section={section} />}
      {!loading && profile?.role === "admin" && <AdminView section={section} />}
      {!loading && profile?.role === "technician" && <p className="p-8 text-metal-400">Redirecting to the live monitor...</p>}
      {!loading && !profile && <p className="p-8 text-metal-400">No profile found. Contact an admin.</p>}
    </main>
  </div>;
}
