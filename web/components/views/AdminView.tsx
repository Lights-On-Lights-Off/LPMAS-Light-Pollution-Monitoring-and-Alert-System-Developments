"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Activity, BarChart3, ClipboardList, Database, Pencil, Phone, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Badge } from "../ui";
import { Modal } from "../Modal";
import { ExportCsvButton } from "../ExportCsvButton";
import { useDashboardData } from "@/lib/useDashboardData";
import { getGreenhouses, type Greenhouse } from "@/lib/api";
import { listAdminUsers, createAdminUser, updateAdminUserRole, deleteAdminUser, type AdminUser } from "@/lib/adminUsers";
import type { Role } from "@/lib/profile";
import { useProfile } from "@/lib/profile";
import { supabase } from "@/lib/supabase";
import { logActivity } from "@/lib/activityLog";

const TITLES: Record<string, { title: string; description: string }> = {
  Overview: { title: "Admin overview", description: "System-wide visibility for monitoring sites, sensors, incidents, and users." },
  Team: { title: "Team management", description: "Invite users and manage administrator and manager access." },
  "System settings": { title: "System settings", description: "Review monitoring rules, SMS recipients, and currently connected sensors." },
  "Activity Logs": { title: "Activity logs", description: "Review administrator and manager actions recorded by the system." }
};

const ROLES: Role[] = ["manager", "admin"];
const LINE_COLORS = ["var(--theme-accent)", "var(--theme-accent-hover)"];

type ActivityLog = { id: number; username: string | null; role: string; action: string; resource: string | null; resource_id: string | null; details: Record<string, unknown> | null; created_at: string };
type SensorAggregate = { sensor_id: string; greenhouse_id: string; bucket_start: string; phase_type: string; sample_count: number; avg_lux: number; min_lux: number; max_lux: number; safe_count: number; warning_count: number; violation_count: number; updated_at: string };
type MonitoringIncident = { id: number; pi_incident_id: number; sensor_id: string; greenhouse_id: string; phase_type: string; opened_at: string; resolved_at: string | null; status: "open" | "acknowledged" | "resolved"; peak_lux: number; lowest_lux: number; reason: string; updated_at: string };

export function AdminView({ section }: { section: string }) {
  const meta = TITLES[section] ?? TITLES.Overview;
  const { data, loading, error } = useDashboardData();
  const { profile } = useProfile();
  const [greenhouses, setGreenhouses] = useState<Greenhouse[]>([]);
  const [greenhouseLoading, setGreenhouseLoading] = useState(true);
  const [greenhouseError, setGreenhouseError] = useState<string | null>(null);
  const [team, setTeam] = useState<AdminUser[] | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [teamLoading, setTeamLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [editRoleTarget, setEditRoleTarget] = useState<AdminUser | null>(null);
  const [editRole, setEditRole] = useState<Role>("manager");
  const [editRoleBusy, setEditRoleBusy] = useState(false);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addUserForm, setAddUserForm] = useState({ email: "", full_name: "", role: "manager" as Role });
  const [addUserBusy, setAddUserBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [managerPhone, setManagerPhone] = useState("");
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneMessage, setPhoneMessage] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [monitoringEditOpen, setMonitoringEditOpen] = useState(false);
  const [smsAddOpen, setSmsAddOpen] = useState(false);
  const [smsEditTarget, setSmsEditTarget] = useState<{ id: string; name: string; phone: string } | null>(null);
  const [smsManagerId, setSmsManagerId] = useState("");
  const [smsPhone, setSmsPhone] = useState("");
  const [smsRecipients, setSmsRecipients] = useState<{ id: string; name: string; phone: string }[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activitySearch, setActivitySearch] = useState("");
  const [activityRoleFilter, setActivityRoleFilter] = useState<"all" | Role>("all");
  const [activityActionFilter, setActivityActionFilter] = useState("all");
  const [overviewAggregates, setOverviewAggregates] = useState<SensorAggregate[]>([]);
  const [overviewIncidents, setOverviewIncidents] = useState<MonitoringIncident[]>([]);
  const [overviewActivity, setOverviewActivity] = useState<ActivityLog[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const latest = useMemo(() => {
    const map = new Map<string, SensorAggregate>();
    [...overviewAggregates].sort((a, b) => new Date(b.bucket_start).getTime() - new Date(a.bucket_start).getTime()).forEach(row => { if (!map.has(row.sensor_id)) map.set(row.sensor_id, row); });
    return map;
  }, [overviewAggregates]);

  const sensorIds = useMemo(() => Array.from(latest.keys()).sort(), [latest]);

  const allSensorIds = useMemo(() => {
    const ids = new Set<string>(sensorIds);
    greenhouses.forEach(greenhouse => greenhouse.sensor_ids.forEach(id => ids.add(id)));
    return Array.from(ids).sort();
  }, [greenhouses, sensorIds]);

  const systemActivity = useMemo(() => {
    const buckets = new Map<string, { time: string; sensorUpdates: number; systemActions: number }>();
    overviewAggregates.forEach(row => {
      const date = new Date(row.bucket_start);
      date.setMinutes(Math.floor(date.getMinutes() / 10) * 10, 0, 0);
      const key = date.toISOString();
      const bucket = buckets.get(key) ?? { time: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), sensorUpdates: 0, systemActions: 0 };
      bucket.sensorUpdates += 1;
      buckets.set(key, bucket);
    });
    overviewActivity.forEach(log => {
      const date = new Date(log.created_at);
      date.setMinutes(Math.floor(date.getMinutes() / 10) * 10, 0, 0);
      const key = date.toISOString();
      const bucket = buckets.get(key) ?? { time: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), sensorUpdates: 0, systemActions: 0 };
      bucket.systemActions += 1;
      buckets.set(key, bucket);
    });
    return Array.from(buckets.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  }, [overviewActivity, overviewAggregates]);

  const reportingSensors = Array.from(latest.values()).filter(row => {
    const updatedAt = row.updated_at || row.bucket_start;
    return !!updatedAt && Date.now() - new Date(updatedAt).getTime() <= 120_000;
  }).length;

  const openIncidents = overviewIncidents.filter(incident => incident.status !== "resolved").length;
  const activeGreenhouses = greenhouses.filter(greenhouse => greenhouse.is_active === 1).length;
  const activeGreenhouseSensorIds = useMemo(() => new Set(greenhouses.filter(g => g.is_active === 1).flatMap(g => g.sensor_ids)), [greenhouses]);
  const connectedSensors = useMemo(() => {
    const now = Date.now();
    const latestBySensor = new Map<string, typeof data.readings[number]>();
    data.readings.forEach(reading => {
      if (!activeGreenhouseSensorIds.has(reading.sensor_id)) return;
      const current = latestBySensor.get(reading.sensor_id);
      if (!current || new Date(reading.recorded_at).getTime() > new Date(current.recorded_at).getTime()) latestBySensor.set(reading.sensor_id, reading);
    });
    return Array.from(latestBySensor.values()).filter(reading => now - new Date(reading.recorded_at).getTime() <= 60_000).sort((a, b) => a.sensor_id.localeCompare(b.sensor_id));
  }, [activeGreenhouseSensorIds, data.readings]);
  const activityStatus = overviewLoading || loading ? "Loading" : overviewError || error || greenhouseError ? "Failed to fetch" : "Connected";
  const activityTone = activityStatus === "Failed to fetch" ? "red" : activityStatus === "Loading" ? "slate" : "green";

  async function loadOverviewData() {
    if (!supabase) { setOverviewError("Supabase is not configured."); return; }

    setOverviewLoading(true);
    setOverviewError(null);

    const [aggregateResult, incidentResult, activityResult] = await Promise.all([
      supabase.from("sensor_minute_aggregates").select("sensor_id, greenhouse_id, bucket_start, phase_type, sample_count, avg_lux, min_lux, max_lux, safe_count, warning_count, violation_count, updated_at").order("bucket_start", { ascending: false }).limit(500),
      supabase.from("monitoring_incidents").select("id, pi_incident_id, sensor_id, greenhouse_id, phase_type, opened_at, resolved_at, status, peak_lux, lowest_lux, reason, updated_at").order("opened_at", { ascending: false }).limit(100),
      supabase.from("activity_logs").select("id, username, role, action, resource, resource_id, details, created_at").neq("action", "NAVIGATE").order("created_at", { ascending: false }).limit(100)
    ]);

    const errors = [aggregateResult.error, incidentResult.error, activityResult.error].filter(Boolean);

    setOverviewAggregates(aggregateResult.error ? [] : (aggregateResult.data ?? []) as SensorAggregate[]);
    setOverviewIncidents(incidentResult.error ? [] : (incidentResult.data ?? []) as MonitoringIncident[]);
    setOverviewActivity(activityResult.error ? [] : (activityResult.data ?? []) as ActivityLog[]);

    if (errors.length) setOverviewError(errors.map(item => item?.message).join(" · "));
    setOverviewLoading(false);
  }

  async function refreshTeam() {
    setTeamLoading(true);

    try {
      const result = await listAdminUsers();
      setTeam(result.users);
      setTeamError(null);
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : "Failed to load team.");
    } finally {
      setTeamLoading(false);
    }
  }

  async function refreshGreenhouses() {
    setGreenhouseLoading(true);

    try {
      const result = await getGreenhouses();
      setGreenhouses(result);
      setGreenhouseError(null);
    } catch (e) {
      setGreenhouseError(e instanceof Error ? e.message : "Failed to load greenhouses.");
    } finally {
      setGreenhouseLoading(false);
    }
  }

  async function loadManagerPhone() {
    setPhoneLoading(true);
    setPhoneError(null);

    try {
      const response = await fetch("/api/admin/settings", { method: "GET", cache: "no-store" });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

      setManagerPhone(body.manager_phone ?? "");
    } catch (e) {
      setPhoneError(e instanceof Error ? e.message : "Failed to load manager phone.");
    } finally {
      setPhoneLoading(false);
    }
  }

  async function saveManagerPhone() {
    if (phoneSaving) return;

    setPhoneSaving(true);
    setPhoneMessage("");
    setPhoneError(null);

    try {
      const response = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manager_phone: managerPhone.trim() })
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

      setManagerPhone(body.manager_phone ?? "");
      setPhoneMessage("Manager phone saved successfully.");
      await logActivity("UPDATE_SYSTEM_SETTING", "system_settings", "manager_phone", { value_changed: true });
    } catch (e) {
      setPhoneError(e instanceof Error ? e.message : "Failed to save manager phone.");
    } finally {
      setPhoneSaving(false);
    }
  }

  async function loadActivityLogs(showLoading = false) {
    if (!supabase) {
      setActivityError("Supabase is not configured.");
      return;
    }

    if (showLoading) setActivityLoading(true);

    const { data: logs, error } = await supabase.from("activity_logs").select("id, username, role, action, resource, resource_id, details, created_at").neq("action", "NAVIGATE").order("created_at", { ascending: false }).limit(100);

    if (error) setActivityError(error.message);
    else {
      setActivityLogs((logs ?? []) as ActivityLog[]);
      setActivityError(null);
    }

    if (showLoading) setActivityLoading(false);
  }

  useEffect(() => { refreshTeam(); refreshGreenhouses(); }, []);
  useEffect(() => { loadOverviewData(); }, []);
  useEffect(() => {
    if (section !== "Overview") return;
    const interval = setInterval(loadOverviewData, 30_000);
    return () => clearInterval(interval);
  }, [section]);
  useEffect(() => {
    if (section === "System settings") loadManagerPhone();
    if (section === "Activity Logs") loadActivityLogs();
  }, [section]);
  useEffect(() => {
    if (!managerPhone || !team?.length || smsRecipients.length) return;
    const manager = team.find(user => user.role === "manager");
    if (manager) setSmsRecipients([{ id: manager.id, name: manager.full_name || manager.email, phone: managerPhone }]);
  }, [managerPhone, smsRecipients.length, team]);
  useEffect(() => {
    if (section !== "Activity Logs") return;
    const interval = setInterval(loadActivityLogs, 5000);
    return () => clearInterval(interval);
  }, [section]);

  async function changeRole(id: string, role: Role) {
    const previous = team?.find(user => user.id === id)?.role;

    setTeam(current => current?.map(user => user.id === id ? { ...user, role } : user) ?? current);

    try {
      await updateAdminUserRole(id, role);
      await logActivity("UPDATE_USER_ROLE", "profiles", id, { previous_role: previous ?? null, new_role: role });
      await refreshTeam();
      return true;
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : "Failed to update role.");
      await refreshTeam();
      return false;
    }
  }

  async function saveEditedRole() {
    if (!editRoleTarget || editRoleBusy) return;

    setEditRoleBusy(true);
    setTeamError(null);

    try {
      const saved = await changeRole(editRoleTarget.id, editRole);
      if (saved) setEditRoleTarget(null);
    } finally {
      setEditRoleBusy(false);
    }
  }

  async function submitAddUser(e: FormEvent) {
    e.preventDefault();
    setAddUserBusy(true);
    setTeamError(null);

    try {
      const result = await createAdminUser(addUserForm.email, addUserForm.role, addUserForm.full_name || undefined);

      setAddUserOpen(false);
      setAddUserForm({ email: "", full_name: "", role: "manager" });
      await logActivity("CREATE_USER", "profiles", result.id, { email: addUserForm.email, role: addUserForm.role });
      await refreshTeam();
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : "Failed to add user.");
    } finally {
      setAddUserBusy(false);
    }
  }

  async function confirmDeleteUser() {
    if (!deleteTarget) return;

    setDeleteBusy(true);
    setTeamError(null);

    try {
      const deletedUser = deleteTarget;

      await deleteAdminUser(deletedUser.id);
      await logActivity("DELETE_USER", "profiles", deletedUser.id, { email: deletedUser.email, role: deletedUser.role });

      setDeleteTarget(null);
      await refreshTeam();
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : "Failed to delete user.");
    } finally {
      setDeleteBusy(false);
    }
  }

  const activityActions = useMemo(() => Array.from(new Set(activityLogs.map(log => log.action))).sort(), [activityLogs]);

  const filteredActivityLogs = useMemo(() => {
    const query = activitySearch.trim().toLowerCase();

    return activityLogs.filter(log => {
      const matchesRole = activityRoleFilter === "all" || log.role === activityRoleFilter;
      const matchesAction = activityActionFilter === "all" || log.action === activityActionFilter;
      const haystack = [log.username, log.role, log.action, log.resource, log.resource_id, log.details ? JSON.stringify(log.details) : ""].filter(Boolean).join(" ").toLowerCase();
      return matchesRole && matchesAction && (!query || haystack.includes(query));
    });
  }, [activityActionFilter, activityLogs, activityRoleFilter, activitySearch]);

  const activityRows = useMemo(() => filteredActivityLogs.map(log => ({
    Timestamp: new Date(log.created_at).toLocaleString(),
    Username: log.username ?? "Unknown",
    Role: log.role,
    Action: log.action,
    Resource: log.resource ?? "—",
    ResourceID: log.resource_id ?? "—",
    Details: log.details ? JSON.stringify(log.details) : "—"
  })), [filteredActivityLogs]);

  const filteredTeam = useMemo(() => {
    if (!team) return [];
    if (roleFilter === "all") return team;
    return team.filter(user => user.role === roleFilter);
  }, [roleFilter, team]);

  const controlClassName = "block w-full min-w-0 rounded-lg border border-theme-accent/60 bg-theme-surface-secondary px-3 py-2.5 text-sm font-medium text-theme-text shadow-sm outline-none transition placeholder:text-theme-muted focus:border-theme-accent focus:ring-2 focus:ring-theme-accent/30 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="space-y-5 p-5 md:p-7">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-theme-text">{meta.title}</h1>
          <p className="mt-1 text-sm text-theme-muted">{meta.description}</p>
        </div>
        <Badge tone={activityTone}>{activityStatus}</Badge>
      </header>

      {section === "Overview" && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-theme-muted">Greenhouses</p>
                  <p className="mt-2 font-mono text-3xl font-bold text-theme-text">{greenhouseLoading ? "—" : greenhouses.length}</p>
                  <p className="mt-1 text-xs text-theme-subtle">{activeGreenhouses} currently active</p>
                </div>
                <Database size={17} className="text-theme-muted" />
              </div>
            </Card>

            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-theme-muted">Sensors</p>
                  <p className="mt-2 font-mono text-3xl font-bold text-theme-text">{reportingSensors}</p>
                  <p className="mt-1 text-xs text-theme-subtle">Currently reporting</p>
                </div>
                <Activity size={17} className="text-theme-muted" />
              </div>
            </Card>

            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-theme-muted">Open incidents</p>
                  <p className="mt-2 font-mono text-3xl font-bold text-theme-text">{openIncidents}</p>
                  <p className="mt-1 text-xs text-theme-subtle">{openIncidents ? "Requires attention" : "No open incidents"}</p>
                </div>
                <ClipboardList size={17} className="text-theme-muted" />
              </div>
            </Card>

            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-theme-muted">Team members</p>
                  <p className="mt-2 font-mono text-3xl font-bold text-theme-text">{team ? team.length : "—"}</p>
                  <p className="mt-1 text-xs text-theme-subtle">Admin and manager accounts</p>
                </div>
                <Users size={17} className="text-theme-muted" />
              </div>
            </Card>
          </div>

          <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,1.75fr)_minmax(330px,0.8fr)]">
            <Card className="min-w-0 min-h-[370px]">
              <div className="mb-5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <BarChart3 size={18} className="shrink-0 text-theme-accent" />
                    <p className="text-base font-bold text-theme-text">System activity</p>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-theme-muted">Recorded sensor aggregate updates and user/system actions.</p>
                </div>
                <span className="shrink-0 rounded-full border border-theme-accent/25 bg-theme-surface-secondary px-2.5 py-1 text-[11px] font-medium text-theme-muted">Supabase</span>
              </div>

              <div className="h-[285px]">
                {systemActivity.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={systemActivity} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                      <defs>
                        <linearGradient id="admin-sensor" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={LINE_COLORS[0]} stopOpacity={0.25} />
                          <stop offset="95%" stopColor={LINE_COLORS[0]} stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="admin-actions" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={LINE_COLORS[1]} stopOpacity={0.2} />
                          <stop offset="95%" stopColor={LINE_COLORS[1]} stopOpacity={0} />
                        </linearGradient>
                      </defs>

                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--theme-border)" />
                      <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--theme-text-muted)" }} tickMargin={8} interval="preserveStartEnd" />
                      <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "var(--theme-text-muted)" }} width={30} />
                      <Tooltip contentStyle={{ borderRadius: 12, background: "var(--theme-surface)", border: "1px solid var(--theme-border)", color: "var(--theme-text)" }} />
                      <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                      <Area type="monotone" dataKey="sensorUpdates" name="Sensor updates" stroke={LINE_COLORS[0]} fill="url(#admin-sensor)" strokeWidth={2} />
                      <Area type="monotone" dataKey="systemActions" name="System actions" stroke={LINE_COLORS[1]} fill="url(#admin-actions)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="grid h-full place-items-center rounded-xl border border-dashed border-theme-border text-sm text-theme-muted">No system activity available.</div>
                )}
              </div>
            </Card>

            <Card className="min-w-0 min-h-[370px]">
              <div className="mb-5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Activity size={18} className="shrink-0 text-theme-accent" />
                    <p className="text-base font-bold text-theme-text">Sensor Status</p>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-theme-muted">Current reporting state and greenhouse assignment.</p>
                </div>
                <span className="shrink-0 rounded-full border border-theme-accent/25 bg-theme-surface-secondary px-2.5 py-1 text-[11px] font-medium text-theme-muted">{allSensorIds.length} sensors</span>
              </div>

              <div className="min-w-0 overflow-x-auto rounded-xl border border-theme-border/70">
                <table className="w-full min-w-[520px] border-collapse text-sm">
                  <thead className="bg-theme-surface-secondary">
                    <tr className="border-b border-theme-accent/30">
                      <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-text">Sensor ID</th>
                      <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Status</th>
                      <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Assigned</th>
                    </tr>
                  </thead>

                  <tbody>
                    {allSensorIds.length > 0 ? (
                      allSensorIds.map(id => {
                        const row = latest.get(id);
                        const updatedAt = row?.updated_at || row?.bucket_start;
                        const reporting = !!updatedAt && Date.now() - new Date(updatedAt).getTime() <= 120_000;
                        const greenhouse = row?.greenhouse_id ? greenhouses.find(item => item.id === row.greenhouse_id) : greenhouses.find(item => item.sensor_ids.includes(id));

                        return (
                          <tr key={id} className="border-b border-theme-border/80">
                            <td className="px-5 py-3.5 text-center font-mono text-xs font-medium text-theme-text">{id}</td>
                            <td className="px-5 py-3.5 text-center">
                              <span className={`inline-flex min-w-[88px] justify-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${reporting ? "bg-theme-accent-soft text-theme-accent" : "bg-theme-surface-secondary text-theme-muted"}`}>
                                {row ? reporting ? "Reporting" : "Stale" : "No data"}
                              </span>
                            </td>
                            <td className="px-5 py-3.5 text-center text-theme-secondary-text">{greenhouse?.name ?? "Unassigned"}</td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={3} className="px-5 py-10 text-center text-sm text-theme-muted">No sensor records are available.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          <Card className="min-w-0">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <ClipboardList size={18} className="text-theme-accent" />
                  <p className="text-base font-bold text-theme-text">Incident Report</p>
                </div>
                <p className="mt-1 text-xs leading-5 text-theme-muted">Incidents recorded by the monitoring system.</p>
              </div>
              <span className="shrink-0 rounded-full border border-theme-accent/25 bg-theme-surface-secondary px-2.5 py-1 text-[11px] font-medium text-theme-muted">{overviewIncidents.length} incident{overviewIncidents.length === 1 ? "" : "s"}</span>
            </div>

            <div className="min-w-0 overflow-x-auto rounded-xl border border-theme-border/70">
              <table className="w-full min-w-[1080px] border-collapse text-sm">
                <thead className="bg-theme-surface-secondary">
                  <tr className="border-b border-theme-border/80">
                    <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Opened</th>
                    <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Sensor ID</th>
                    <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Greenhouse</th>
                    <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Phase</th>
                    <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Status</th>
                    <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Reason</th>
                  </tr>
                </thead>

                <tbody>
                  {overviewIncidents.length > 0 ? (
                    overviewIncidents.map(incident => (
                      <tr key={incident.id} className="border-b border-theme-border/80">
                        <td className="px-5 py-3.5 text-center whitespace-nowrap text-theme-secondary-text">{new Date(incident.opened_at).toLocaleString()}</td>
                        <td className="px-5 py-3.5 text-center font-mono text-xs text-theme-text">{incident.sensor_id}</td>
                        <td className="px-5 py-3.5 text-center text-theme-secondary-text">{greenhouses.find(item => item.id === incident.greenhouse_id)?.name ?? incident.greenhouse_id ?? "Unassigned"}</td>
                        <td className="px-5 py-3.5 text-center capitalize text-theme-secondary-text">{incident.phase_type || "—"}</td>
                        <td className="px-5 py-3.5 text-center">
                          <span className="inline-flex min-w-[92px] justify-center rounded-full bg-theme-accent-soft px-2.5 py-1 text-[11px] font-semibold capitalize text-theme-accent">{incident.status}</span>
                        </td>
                        <td className="px-5 py-3.5 text-center text-theme-secondary-text">{incident.reason || "—"}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="px-5 py-10 text-center text-sm text-theme-muted">No incidents have been recorded.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {section === "Team" && (
        <Card className="flex min-h-[calc(100vh-170px)] flex-col">
          <div className="mb-5 flex shrink-0 flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-base font-bold text-theme-text">All Accounts</p>
              <p className="mt-1 text-xs leading-5 text-theme-muted">Manage administrator and manager access.</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select value={roleFilter} onChange={e => setRoleFilter(e.target.value as "all" | Role)} className={`${controlClassName} w-auto min-w-[112px]`}>
                <option value="all" className="bg-theme-surface-secondary text-theme-text">All roles</option>
                {ROLES.map(role => <option key={role} value={role} className="bg-theme-surface-secondary text-theme-text">{role}</option>)}
              </select>

              <button onClick={() => setAddUserOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-theme-accent px-3 py-2 text-sm font-semibold text-theme-accent-foreground hover:bg-theme-accent-hover">
                <UserPlus size={15} />
                Add account
              </button>
            </div>
          </div>

          {teamError && (
            <p className="mb-4 shrink-0 rounded-xl border border-theme-danger/30 bg-theme-danger/10 p-3 text-sm text-theme-danger">{teamError}</p>
          )}

          {teamLoading ? (
            <div className="grid min-h-[300px] flex-1 place-items-center rounded-xl border border-dashed border-theme-border text-sm text-theme-muted">Loading accounts…</div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-theme-border/70">
              <table className="w-full min-w-[820px] border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-theme-surface-secondary">
                  <tr className="border-b border-theme-border/80">
                    <th className="w-[28%] px-5 py-4 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Name</th>
                    <th className="w-[30%] px-5 py-4 text-center text-xs font-semibold uppercase tracking-wide text-theme-text">Email</th>
                    <th className="w-[17%] px-5 py-4 text-center text-xs font-semibold uppercase tracking-wide text-theme-text">Role</th>
                    <th className="w-[25%] px-5 py-4 text-center text-xs font-semibold uppercase tracking-wide text-theme-text">Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {filteredTeam.length > 0 ? (
                    filteredTeam.map(user => {
                      const isCurrentUser = profile?.id === user.id;

                      return (
                        <tr key={user.id} className="border-b border-theme-border/80">
                          <td className="px-5 py-[18px] text-center">
                            <div className="flex items-center justify-center gap-2.5">
                              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-theme-accent-soft text-xs font-bold uppercase text-theme-accent">
                                {(user.full_name || user.email || "U").charAt(0)}
                              </span>

                              <div className="text-center">
                                <p className="font-semibold text-theme-text">{user.full_name || "Unnamed"}</p>
                                {isCurrentUser && <p className="mt-0.5 text-[11px] text-theme-accent">Current account</p>}
                              </div>
                            </div>
                          </td>

                          <td className="px-5 py-[18px] text-center text-theme-secondary-text">{user.email}</td>

                          <td className="px-5 py-[18px] text-center">
                            <span className="inline-flex min-w-[88px] justify-center rounded-full bg-theme-accent-soft px-2.5 py-1 text-[11px] font-semibold capitalize text-theme-accent">{user.role}</span>
                          </td>

                          <td className="px-5 py-[18px] text-center">
                            <div className="flex items-center justify-center gap-2">
                              <button
                                type="button"
                                disabled={isCurrentUser}
                                onClick={() => {
                                  setEditRoleTarget(user);
                                  setEditRole(user.role);
                                }}
                                className="rounded-lg border border-theme-accent/60 px-3 py-2 text-xs font-semibold text-theme-accent transition hover:bg-theme-accent-soft hover:border-theme-accent disabled:cursor-not-allowed disabled:opacity-30"
                                title={isCurrentUser ? "You cannot modify your own account" : "Edit role"}
                              >
                                Edit Role
                              </button>

                              <button
                                type="button"
                                disabled={isCurrentUser}
                                onClick={() => setDeleteTarget(user)}
                                className="rounded-lg border border-theme-danger/30 px-3 py-2 text-xs font-semibold text-theme-danger transition hover:bg-theme-danger/10 disabled:cursor-not-allowed disabled:opacity-30"
                                title={isCurrentUser ? "You cannot delete your own account" : "Delete account"}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={4} className="px-5 py-12 text-center text-sm text-theme-muted">
                        {team && team.length > 0 ? "No accounts match the selected role." : "No accounts are available."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {section === "System settings" && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card><p className="text-sm text-theme-muted">Greenhouses active</p><p className="mt-2 font-mono text-3xl font-bold text-theme-text">{greenhouseLoading ? "—" : activeGreenhouses}</p><p className="mt-1 text-xs text-theme-subtle">Currently active sites</p></Card>
            <Card><p className="text-sm text-theme-muted">Sensors online</p><p className="mt-2 font-mono text-3xl font-bold text-theme-text">{reportingSensors}</p><p className="mt-1 text-xs text-theme-subtle">Reporting within 2 minutes</p></Card>
            <Card><p className="text-sm text-theme-muted">Open incidents</p><p className="mt-2 font-mono text-3xl font-bold text-theme-text">{openIncidents}</p><p className="mt-1 text-xs text-theme-subtle">Requires attention</p></Card>
            <Card><p className="text-sm text-theme-muted">Users</p><p className="mt-2 font-mono text-3xl font-bold text-theme-text">{team?.length ?? "—"}</p><p className="mt-1 text-xs text-theme-subtle">Admin and manager accounts</p></Card>
          </div>

          <div className="grid items-stretch gap-5 xl:grid-cols-2">
            <Card className="min-w-0">
              <div className="mb-5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><Database size={18} className="shrink-0 text-theme-accent" /><p className="text-base font-bold text-theme-text">Monitoring configuration</p></div>
                  <p className="mt-1 text-xs leading-5 text-theme-muted">System monitoring rules applied to configured greenhouse schedules.</p>
                </div>
                <button type="button" onClick={() => setMonitoringEditOpen(true)} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-theme-accent px-3 py-2 text-xs font-semibold text-theme-accent transition hover:bg-theme-accent-soft"><Pencil size={14} /> Edit</button>
              </div>
              {data.phase ? (
                <dl className="grid gap-4 sm:grid-cols-2">
                  <SettingRow label="Current phase" value={data.phase.phase_type} />
                  <SettingRow label="Monitoring window" value={data.phase.window_start && data.phase.window_end ? `${data.phase.window_start} – ${data.phase.window_end}` : "Continuous dark phase"} />
                  <SettingRow label="Phase dates" value={`${data.phase.starts_on} – ${data.phase.ends_on}`} />
                  <SettingRow label="Violation confirmation" value="3 consecutive readings" />
                  <SettingRow label="Illumination rule" value="≥ 50 safe · 31–49 warning · ≤ 30 violation" />
                  <SettingRow label="Dark rule" value="0–15 safe · 16–29 warning · ≥ 30 violation" />
                </dl>
              ) : <p className="text-sm text-theme-muted">No active phase is currently configured.</p>}
            </Card>

            <Card className="min-w-0">
              <div className="mb-5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><Phone size={18} className="shrink-0 text-theme-accent" /><p className="text-base font-bold text-theme-text">SMS configuration</p></div>
                  <p className="mt-1 text-xs leading-5 text-theme-muted">Manager recipients for confirmed violation notifications.</p>
                </div>
                <button type="button" onClick={() => { setSmsManagerId(""); setSmsPhone(""); setSmsAddOpen(true); }} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-theme-accent px-3 py-2 text-xs font-semibold text-theme-accent-foreground transition hover:bg-theme-accent-hover"><Plus size={14} /> Add</button>
              </div>
              {phoneError && <div className="mb-3 rounded-xl border border-theme-danger/30 bg-theme-danger/10 p-3 text-sm text-theme-danger">{phoneError}</div>}
              <div className="overflow-x-auto rounded-xl border border-theme-border/70">
                <table className="w-full min-w-[460px] border-collapse text-sm">
                  <thead className="bg-theme-surface-secondary"><tr className="border-b border-theme-accent/30"><th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-theme-text">User name</th><th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-theme-text">Phone</th><th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-theme-text">Actions</th></tr></thead>
                  <tbody>{smsRecipients.length ? smsRecipients.map(recipient => <tr key={recipient.id} className="border-b border-theme-border last:border-0"><td className="px-4 py-3.5 text-theme-text">{recipient.name}</td><td className="px-4 py-3.5 font-mono text-xs text-theme-secondary-text">{recipient.phone}</td><td className="px-4 py-3.5"><div className="flex justify-end gap-2"><button type="button" onClick={() => { setSmsEditTarget(recipient); setSmsPhone(recipient.phone); }} className="rounded-lg border border-theme-accent/60 px-2.5 py-1.5 text-xs font-semibold text-theme-accent hover:bg-theme-accent-soft hover:border-theme-accent"><Pencil size={13} /></button><button type="button" onClick={() => setSmsRecipients(current => current.filter(item => item.id !== recipient.id))} className="rounded-lg border border-theme-danger/30 px-2.5 py-1.5 text-xs font-semibold text-theme-danger hover:bg-theme-danger/10"><Trash2 size={13} /></button></div></td></tr>) : <tr><td colSpan={3} className="px-4 py-10 text-center text-sm text-theme-muted">No SMS recipients configured.</td></tr>}</tbody>
                </table>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-xs"><span className="text-theme-muted">Provider status</span><span className="rounded-full border border-theme-accent/40 bg-theme-accent-soft px-2.5 py-1 font-semibold text-theme-accent">Not configured</span></div>
            </Card>
          </div>

          <Card>
            <div className="mb-5"><p className="font-bold text-theme-text">Connected sensors</p><p className="mt-1 text-sm text-theme-muted">Only active greenhouse sensors currently sending real lux values are shown.</p></div>
            <div className="min-w-0 overflow-x-auto rounded-xl border border-theme-border/70">
              <table className="w-full min-w-[760px] border-collapse text-sm"><thead className="bg-theme-surface-secondary"><tr className="border-b border-theme-border/80"><th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Sensor ID</th><th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Latest lux</th><th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Status</th><th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Recorded</th></tr></thead>
                <tbody>{connectedSensors.length ? connectedSensors.map(reading => <tr key={`${reading.sensor_id}-${reading.recorded_at}`} className="border-b border-theme-border last:border-0"><td className="px-5 py-3.5 text-center font-mono text-xs font-medium text-theme-text">{reading.sensor_id}</td><td className="px-5 py-3.5 text-center font-mono font-semibold text-theme-text">{reading.lux.toFixed(2)} lx</td><td className="px-5 py-3.5 text-center"><span className="inline-flex min-w-[82px] justify-center rounded-full bg-theme-accent-soft px-2.5 py-1 text-[11px] font-semibold text-theme-accent">Reporting</span></td><td className="px-5 py-3.5 text-center whitespace-nowrap text-theme-secondary-text">{new Date(reading.recorded_at).toLocaleString()}</td></tr>) : <tr><td colSpan={4} className="px-5 py-10 text-center text-sm text-theme-muted">No active sensors are currently reporting lux values.</td></tr>}</tbody>
              </table>
            </div>
          </Card>

          <Modal open={monitoringEditOpen} onClose={() => setMonitoringEditOpen(false)} title="Edit monitoring configuration" description="Review the active monitoring policy. Greenhouse dates, monitoring windows and sensor assignments remain managed by Greenhouse Management." footer={<button onClick={() => setMonitoringEditOpen(false)} className="rounded-lg bg-theme-accent px-4 py-2 text-sm font-semibold text-theme-accent-foreground hover:bg-theme-accent-hover">Done</button>}>
            {data.phase ? <div className="space-y-5"><div className="grid gap-4 sm:grid-cols-2"><SettingRow label="Current phase" value={data.phase.phase_type} /><SettingRow label="Monitoring window" value={data.phase.window_start && data.phase.window_end ? `${data.phase.window_start} – ${data.phase.window_end}` : "Continuous dark phase"} /><SettingRow label="Phase dates" value={`${data.phase.starts_on} – ${data.phase.ends_on}`} /><SettingRow label="Confirmation" value="3 consecutive readings" /></div><div className="rounded-xl border border-theme-accent/20 bg-theme-accent-soft p-4"><p className="text-sm font-semibold text-theme-text">System-defined thresholds</p><div className="mt-3 grid gap-3 sm:grid-cols-2 text-xs"><div><p className="text-theme-muted">Illumination</p><p className="mt-1 font-medium text-theme-text">≥ 50 safe · 31–49 warning · ≤ 30 violation</p></div><div><p className="text-theme-muted">Dark</p><p className="mt-1 font-medium text-theme-text">0–15 safe · 16–29 warning · ≥ 30 violation</p></div></div></div><p className="text-xs text-theme-muted">Thresholds are fixed by the monitoring service and are intentionally not editable here.</p></div> : <p className="text-sm text-theme-muted">No active phase is currently configured.</p>}
          </Modal>

          <Modal open={smsAddOpen || !!smsEditTarget} onClose={() => { setSmsAddOpen(false); setSmsEditTarget(null); }} title={smsEditTarget ? "Edit SMS recipient" : "Add SMS recipient"} description="Select a manager account and provide the mobile number used for incident notifications." footer={<><button onClick={() => { setSmsAddOpen(false); setSmsEditTarget(null); }} className="rounded-lg border border-theme-accent/60 px-4 py-2 text-sm font-semibold text-theme-accent hover:bg-theme-accent-soft hover:border-theme-accent">Cancel</button><button onClick={() => { const manager = team?.find(user => user.id === smsManagerId); if (!smsEditTarget && manager && smsPhone.trim()) setSmsRecipients(current => [...current.filter(item => item.id !== manager.id), { id: manager.id, name: manager.full_name || manager.email, phone: smsPhone.trim() }]); if (smsEditTarget && smsPhone.trim()) setSmsRecipients(current => current.map(item => item.id === smsEditTarget.id ? { ...item, phone: smsPhone.trim() } : item)); setSmsAddOpen(false); setSmsEditTarget(null); }} disabled={(!smsEditTarget && !smsManagerId) || !smsPhone.trim()} className="rounded-lg bg-theme-accent px-4 py-2 text-sm font-semibold text-theme-accent-foreground disabled:opacity-50">{smsEditTarget ? "Save" : "Add"}</button></>}>
            <div className="space-y-4">{!smsEditTarget && <label className="block"><span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-theme-text">Manager</span><select value={smsManagerId} onChange={e => setSmsManagerId(e.target.value)} className={controlClassName}><option value="" className="bg-theme-surface-secondary text-theme-text">Select manager</option>{(team ?? []).filter(user => user.role === "manager").map(user => <option key={user.id} value={user.id} className="bg-theme-surface-secondary text-theme-text">{user.full_name || user.email}</option>)}</select></label>}<label className="block"><span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-theme-text">Mobile number</span><input value={smsPhone} onChange={e => setSmsPhone(e.target.value)} placeholder="+63 9XX XXX XXXX" inputMode="tel" className={controlClassName} /></label></div>
          </Modal>
        </div>
      )}
      {section === "Activity Logs" && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card>
              <p className="text-sm text-theme-muted">Greenhouses active</p>
              <p className="mt-2 font-mono text-3xl font-bold text-theme-text">{greenhouseLoading ? "—" : activeGreenhouses}</p>
              <p className="mt-1 text-xs text-theme-subtle">Currently active sites</p>
            </Card>

            <Card>
              <p className="text-sm text-theme-muted">Sensors online</p>
              <p className="mt-2 font-mono text-3xl font-bold text-theme-text">{reportingSensors}</p>
              <p className="mt-1 text-xs text-theme-subtle">Reporting within 2 minutes</p>
            </Card>

            <Card>
              <p className="text-sm text-theme-muted">Open incidents</p>
              <p className="mt-2 font-mono text-3xl font-bold text-theme-text">{openIncidents}</p>
              <p className="mt-1 text-xs text-theme-subtle">Requires attention</p>
            </Card>

            <Card>
              <p className="text-sm text-theme-muted">Users</p>
              <p className="mt-2 font-mono text-3xl font-bold text-theme-text">{team ? team.length : "—"}</p>
              <p className="mt-1 text-xs text-theme-subtle">Admin and manager accounts</p>
            </Card>
          </div>

          <Card>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <ClipboardList size={18} className="text-theme-accent" />
                  <p className="font-bold text-theme-text">User activity</p>
                </div>
                <p className="mt-1 text-sm text-theme-muted">Administrator and manager actions recorded by the system.</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={activitySearch}
                  onChange={e => setActivitySearch(e.target.value)}
                  placeholder="Search activity"
                  className={`${controlClassName} w-[210px]`}
                />

                <select value={activityRoleFilter} onChange={e => setActivityRoleFilter(e.target.value as "all" | Role)} className={`${controlClassName} w-auto min-w-[112px]`}>
                  <option value="all" className="bg-theme-surface-secondary text-theme-text">All roles</option>
                  {ROLES.map(role => <option key={role} value={role} className="bg-theme-surface-secondary text-theme-text">{role}</option>)}
                </select>

                <select value={activityActionFilter} onChange={e => setActivityActionFilter(e.target.value)} className={`${controlClassName} w-auto min-w-[128px]`}>
                  <option value="all" className="bg-theme-surface-secondary text-theme-text">All actions</option>
                  {activityActions.map(action => <option key={action} value={action} className="bg-theme-surface-secondary text-theme-text">{action}</option>)}
                </select>

                <ExportCsvButton filename="admin-activity-logs.csv" rows={activityRows} />
              </div>
            </div>

            {activityError && <div className="mb-3 rounded-xl border border-theme-danger/30 bg-theme-danger/10 p-3 text-sm text-theme-danger">{activityError}</div>}

            {activityLoading ? (
              <p className="text-sm text-theme-muted">Loading activity logs…</p>
            ) : (
              <div className="min-w-0 overflow-x-auto rounded-xl border border-theme-border/70">
                <table className="w-full min-w-[1120px] border-collapse text-sm">
                  <thead className="bg-theme-surface-secondary">
                    <tr className="border-b border-theme-accent/30">
                      <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-text">Time</th>
                      <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Actor</th>
                      <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-text">Role</th>
                      <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Action</th>
                      <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Resource</th>
                      <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Resource ID</th>
                      <th className="px-5 py-3 text-center text-xs font-semibold uppercase tracking-wide text-theme-muted">Details</th>
                    </tr>
                  </thead>

                  <tbody>
                    {filteredActivityLogs.length > 0 ? (
                      filteredActivityLogs.map(log => (
                        <tr key={log.id} className="border-b border-theme-border/80">
                          <td className="px-5 py-3.5 text-center whitespace-nowrap text-theme-secondary-text">{new Date(log.created_at).toLocaleString()}</td>
                          <td className="px-5 py-3.5 text-center text-theme-text">{log.username ?? "Unknown"}</td>
                          <td className="px-5 py-3.5 text-center capitalize text-theme-secondary-text">{log.role}</td>
                          <td className="px-5 py-3.5 text-center font-mono text-xs font-medium text-theme-text">{log.action}</td>
                          <td className="px-5 py-3.5 text-center text-theme-secondary-text">{log.resource ?? "—"}</td>
                          <td className="px-5 py-3.5 text-center font-mono text-xs text-theme-secondary-text">{log.resource_id ?? "—"}</td>
                          <td className="max-w-[360px] px-5 py-3.5 text-center text-xs text-theme-secondary-text">{log.details ? JSON.stringify(log.details) : "—"}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={7} className="px-5 py-10 text-center text-sm text-theme-muted">{activityLogs.length > 0 ? "No activity logs match the selected filters." : "No activity logs are available."}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
      <Modal
        open={addUserOpen}
        onClose={() => setAddUserOpen(false)}
        title="Add user"
        description="Invite a new account and assign an administrator or manager role."
        footer={
          <>
            <button type="button" onClick={() => setAddUserOpen(false)} className="rounded-lg border border-theme-accent/60 px-4 py-2 text-sm font-semibold text-theme-accent hover:bg-theme-accent-soft hover:border-theme-accent">Cancel</button>
            <button type="submit" form="add-user-form" disabled={addUserBusy} className="rounded-lg bg-theme-accent px-4 py-2 text-sm font-semibold text-theme-accent-foreground hover:bg-theme-accent-hover disabled:opacity-50">{addUserBusy ? "Adding…" : "Add user"}</button>
          </>
        }
      >
        <form id="add-user-form" onSubmit={submitAddUser} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-theme-secondary-text">Email</span>
            <input type="email" required value={addUserForm.email} onChange={e => setAddUserForm(form => ({ ...form, email: e.target.value }))} className={controlClassName} />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-theme-secondary-text">Full name</span>
            <input value={addUserForm.full_name} onChange={e => setAddUserForm(form => ({ ...form, full_name: e.target.value }))} className={controlClassName} />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-theme-secondary-text">Role</span>
            <select value={addUserForm.role} onChange={e => setAddUserForm(form => ({ ...form, role: e.target.value as Role }))} className={`${controlClassName} capitalize`}>
              {ROLES.map(role => <option key={role} value={role} className="bg-theme-surface-secondary text-theme-text">{role}</option>)}
            </select>
          </label>
        </form>
      </Modal>

      <Modal
        open={!!editRoleTarget}
        onClose={() => { if (!editRoleBusy) setEditRoleTarget(null); }}
        title="Edit Role"
        description={`Change the role for ${editRoleTarget?.full_name || editRoleTarget?.email || "this user"}.`}
        footer={
          <>
            <button type="button" onClick={() => setEditRoleTarget(null)} disabled={editRoleBusy} className="rounded-lg border border-theme-accent/60 px-4 py-2 text-sm font-semibold text-theme-accent hover:bg-theme-accent-soft hover:border-theme-accent disabled:opacity-50">Cancel</button>
            <button type="button" onClick={saveEditedRole} disabled={editRoleBusy || !editRoleTarget} className="rounded-lg bg-theme-accent px-4 py-2 text-sm font-semibold text-theme-accent-foreground hover:bg-theme-accent-hover disabled:opacity-50">{editRoleBusy ? "Saving…" : "Save"}</button>
          </>
        }
      >
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-theme-text">Role</span>
          <select value={editRole} onChange={e => setEditRole(e.target.value as Role)} disabled={editRoleBusy} className={`${controlClassName} w-full capitalize`}>
            {ROLES.map(role => <option key={role} value={role} className="bg-theme-surface-secondary text-theme-text">{role}</option>)}
          </select>
        </label>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete account"
        description={`This permanently removes ${deleteTarget?.email ?? "this user's"} login and profile.`}
        footer={
          <>
            <button onClick={() => setDeleteTarget(null)} className="rounded-lg border border-theme-accent/60 px-4 py-2 text-sm font-semibold text-theme-accent hover:bg-theme-accent-soft hover:border-theme-accent">Cancel</button>
            <button onClick={confirmDeleteUser} disabled={deleteBusy} className="rounded-lg border border-theme-danger/30 px-4 py-2 text-sm font-semibold text-theme-danger hover:bg-theme-danger/10 disabled:opacity-50">{deleteBusy ? "Deleting…" : "Delete account"}</button>
          </>
        }
      >
        <p className="text-sm text-theme-secondary-text">{deleteTarget?.full_name || deleteTarget?.email}</p>
      </Modal>
    </div>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-theme-muted">{label}</dt><dd className="mt-1 font-medium text-theme-text">{value}</dd></div>;
}