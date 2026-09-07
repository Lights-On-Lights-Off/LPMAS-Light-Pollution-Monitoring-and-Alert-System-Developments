"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { BarChart3, ClipboardList, Database, Trash2, UserPlus, Users } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Badge } from "../ui";
import { Modal } from "../Modal";
import { ExportCsvButton } from "../ExportCsvButton";
import { useDashboardData } from "@/lib/useDashboardData";
import { latestBySensor, pivotReadingsBySensor, statusDistribution, STATUS_COLORS } from "@/lib/chartData";
import { listAdminUsers, createAdminUser, updateAdminUserRole, deleteAdminUser, type AdminUser } from "@/lib/adminUsers";
import type { Role } from "@/lib/profile";

const TITLES: Record<string, { title: string; description: string }> = {
  "Overview": { title: "Admin overview", description: "Live system visibility across the connected monitoring network." },
  "Team": { title: "Team management", description: "Invite staff and manage role-based access." },
  "System settings": { title: "System settings", description: "Review the active monitoring phase and connected sensor data." },
  "Activity Logs": { title: "Activity logs", description: "Live readings and incidents available for export." }
};

const ROLES: Role[] = ["manager", "admin"];
const LINE_COLORS = ["#d9a441", "#7fb3d5", "#e5484d"];

export function AdminView({ section }: { section: string }) {
  const meta = TITLES[section] ?? TITLES["Overview"];
  const { data, loading, error } = useDashboardData();

  const [team, setTeam] = useState<AdminUser[] | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [teamLoading, setTeamLoading] = useState(true);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addUserForm, setAddUserForm] = useState({ email: "", full_name: "", role: "manager" as Role });
  const [addUserBusy, setAddUserBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const latest = useMemo(() => latestBySensor(data.readings), [data.readings]);
  const sensorIds = useMemo(() => Array.from(latest.keys()), [latest]);
  const chart = useMemo(() => pivotReadingsBySensor(data.readings), [data.readings]);
  const distribution = useMemo(() => statusDistribution(data.readings), [data.readings]);
  const openIncidents = data.incidents.filter(i => i.status !== "resolved").length;
  const onlineSensors = sensorIds.filter(id => {
    const reading = latest.get(id);
    return !!reading && Date.now() - new Date(reading.recorded_at).getTime() < 60_000;
  }).length;

  const activityRows = [
    ...data.readings.slice(0, 20).map(r => ({
      Type: "Reading",
      Recorded: new Date(r.recorded_at).toLocaleString(),
      Sensor: r.sensor_id,
      Status: r.classification,
      Lux: Number(r.lux.toFixed(2))
    })),
    ...data.incidents.slice(0, 20).map(i => ({
      Type: "Incident",
      Recorded: new Date(i.opened_at).toLocaleString(),
      Sensor: i.sensor_id,
      Status: i.status,
      Lux: Number((i.peak_lux ?? i.lowest_lux ?? 0).toFixed(2))
    }))
  ].sort((a, b) => new Date(b.Recorded).getTime() - new Date(a.Recorded).getTime()).slice(0, 30);

  async function refreshTeam() {
    setTeamLoading(true);
    try {
      setTeam((await listAdminUsers()).users);
      setTeamError(null);
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : "Failed to load team");
    } finally {
      setTeamLoading(false);
    }
  }

  useEffect(() => {
    refreshTeam();
  }, []);

  async function changeRole(id: string, role: Role) {
    setTeam(current => current?.map(user => user.id === id ? { ...user, role } : user) ?? current);
    try {
      await updateAdminUserRole(id, role);
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : "Failed to update role");
      refreshTeam();
    }
  }

  async function submitAddUser(e: FormEvent) {
    e.preventDefault();
    setAddUserBusy(true);
    try {
      await createAdminUser(addUserForm.email, addUserForm.role, addUserForm.full_name || undefined);
      setAddUserOpen(false);
      setAddUserForm({ email: "", full_name: "", role: "manager" });
      refreshTeam();
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : "Failed to add user");
    } finally {
      setAddUserBusy(false);
    }
  }

  async function confirmDeleteUser() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteAdminUser(deleteTarget.id);
      setDeleteTarget(null);
      refreshTeam();
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : "Failed to delete user");
    } finally {
      setDeleteBusy(false);
    }
  }

  return <div className="space-y-6 p-6 md:p-8">
    <div>
      <h1 className="text-2xl font-bold text-theme-text">{meta.title}</h1>
      <p className="mt-1 text-sm text-theme-muted">{meta.description}</p>
    </div>

    {error && <div className="rounded-xl border border-theme-danger/30 bg-theme-danger/10 p-3 text-sm text-theme-danger">{error}</div>}
    {loading && <div className="rounded-xl border border-theme-border bg-theme-surface-secondary p-4 text-sm text-theme-muted">Loading live monitoring data…</div>}

    {section === "Overview" && <>
      <div className="grid gap-4 sm:grid-cols-4">
        <Card><p className="text-sm text-theme-muted">Greenhouses</p><p className="mt-2 font-mono text-2xl font-bold text-theme-text">{sensorIds.length > 0 ? 1 : 0}</p><p className="mt-1 text-xs text-theme-subtle">Currently monitored site</p></Card>
        <Card><p className="text-sm text-theme-muted">Sensors</p><p className="mt-2 font-mono text-2xl font-bold text-theme-text">{sensorIds.length}</p><p className="mt-1 text-xs text-theme-subtle">{onlineSensors} currently online</p></Card>
        <Card><p className="text-sm text-theme-muted">Open incidents</p><p className="mt-2 font-mono text-2xl font-bold text-theme-text">{openIncidents}</p><p className="mt-1 text-xs text-theme-subtle">{openIncidents ? "Requires attention" : "No open incidents"}</p></Card>
        <Card><p className="text-sm text-theme-muted">Team members</p><p className="mt-2 font-mono text-2xl font-bold text-theme-text">{team ? team.length : "—"}</p><p className="mt-1 text-xs text-theme-subtle">Loaded from admin API</p></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <p className="mb-1 flex items-center gap-2 font-bold text-theme-text"><BarChart3 size={18} /> Lux trend, all sensors</p>
          <p className="mb-4 text-sm text-theme-muted">Live BH1750 readings from the connected sensors.</p>
          <div className="h-72">
            {chart.length > 0 ? <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart}>
                <defs>
                  {sensorIds.map((id, i) => <linearGradient key={id} id={`admin-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0} />
                  </linearGradient>)}
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--theme-border)" />
                <XAxis dataKey="time" tick={{ fontSize: 11, fill: "var(--theme-text-muted)" }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: "var(--theme-text-muted)" }} width={35} />
                <Tooltip contentStyle={{ borderRadius: 12, background: "var(--theme-surface)", border: "1px solid var(--theme-border)", color: "var(--theme-text)" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {sensorIds.map((id, i) => <Area key={id} type="monotone" dataKey={id} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} fill={`url(#admin-${i})`} />)}
              </AreaChart>
            </ResponsiveContainer> : <div className="grid h-full place-items-center text-sm text-theme-muted">No sensor data available.</div>}
          </div>
        </Card>

        <Card>
          <p className="mb-4 font-bold text-theme-text">Status distribution</p>
          {data.readings.length > 0 ? <div className="space-y-3">
            {distribution.map(d => <div key={d.key} className="flex items-center justify-between rounded-xl border border-theme-border bg-theme-surface-secondary px-3 py-3"><span className="flex items-center gap-2 text-sm text-theme-secondary-text"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[d.key] }} />{d.name}</span><span className="font-mono font-semibold text-theme-text">{d.value}</span></div>)}
          </div> : <div className="grid h-40 place-items-center text-sm text-theme-muted">No status data available.</div>}
        </Card>
      </div>
    </>}

    {section === "Team" && <Card>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <p className="font-bold text-theme-text">Team management</p>
          <p className="mt-1 text-sm text-theme-muted">Live user records from the admin API.</p>
        </div>
        <button onClick={() => setAddUserOpen(true)} className="flex items-center gap-1 rounded-lg bg-theme-accent px-3 py-2 text-sm font-semibold text-theme-accent-foreground hover:bg-theme-accent-hover"><UserPlus size={15} /> Add user</button>
      </div>

      {teamError && <p className="mb-3 rounded-xl border border-theme-danger/30 bg-theme-danger/10 p-3 text-sm text-theme-danger">{teamError}</p>}
      {teamLoading && <p className="text-sm text-theme-muted">Loading team…</p>}

      {!teamLoading && team && <div className="space-y-2">
        {team.map(user => <div key={user.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-theme-border bg-theme-surface-secondary p-3">
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-theme-accent-soft p-2 text-theme-accent"><Users size={16} /></span>
            <div><p className="font-semibold text-theme-text">{user.full_name || "Unnamed"}</p><p className="text-xs text-theme-muted">{user.email}</p></div>
          </div>
          <div className="flex items-center gap-3">
            <select value={user.role} onChange={e => changeRole(user.id, e.target.value as Role)} className="rounded-lg px-2 py-1 text-xs capitalize">{ROLES.map(role => <option key={role} value={role}>{role}</option>)}</select>
            <button onClick={() => setDeleteTarget(user)} className="text-theme-muted hover:text-theme-danger"><Trash2 size={16} /></button>
          </div>
        </div>)}
        {team.length === 0 && <p className="text-sm text-theme-muted">No team members yet.</p>}
      </div>}
    </Card>}

    {section === "System settings" && <div className="space-y-4">
      <Card>
        <p className="font-bold text-theme-text">Active phase configuration</p>
        <p className="mt-1 text-sm text-theme-muted">Read directly from the active phase returned by the monitoring API.</p>
        {data.phase ? <dl className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <SettingRow label="Phase" value={data.phase.phase_type} />
          <SettingRow label="Starts" value={data.phase.starts_on} />
          <SettingRow label="Ends" value={data.phase.ends_on} />
          <SettingRow label="Night window" value={data.phase.window_start && data.phase.window_end ? `${data.phase.window_start} – ${data.phase.window_end}` : "—"} />
          <SettingRow label="Lux minimum" value={data.phase.lux_min == null ? "—" : `${data.phase.lux_min} lux`} />
          <SettingRow label="Lux maximum" value={data.phase.lux_max == null ? "—" : `${data.phase.lux_max} lux`} />
          <SettingRow label="Lux ceiling" value={data.phase.lux_ceiling == null ? "—" : `${data.phase.lux_ceiling} lux`} />
          <SettingRow label="Status" value={data.phase.is_active ? "Active" : "Inactive"} />
        </dl> : <p className="mt-5 text-sm text-theme-muted">No active phase is currently configured.</p>}
      </Card>

      <Card>
        <p className="mb-4 font-bold text-theme-text">Connected sensors</p>
        {sensorIds.length > 0 ? <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-theme-border text-theme-muted"><tr><th className="p-3">Sensor</th><th className="p-3">Latest lux</th><th className="p-3">Status</th><th className="p-3">Recorded</th></tr></thead>
            <tbody>{sensorIds.map(id => {
              const reading = latest.get(id);
              const online = !!reading && Date.now() - new Date(reading.recorded_at).getTime() < 60_000;
              return <tr key={id} className="border-b border-theme-border last:border-0">
                <td className="p-3 font-mono text-theme-text">{id}</td>
                <td className="p-3 font-mono text-theme-text">{reading ? reading.lux.toFixed(2) : "—"}</td>
                <td className="p-3"><Badge tone={online ? "green" : "slate"}>{online ? "Online" : "Offline"}</Badge></td>
                <td className="p-3 text-theme-muted">{reading ? new Date(reading.recorded_at).toLocaleString() : "—"}</td>
              </tr>;
            })}</tbody>
          </table>
        </div> : <p className="text-sm text-theme-muted">No sensors have reported data.</p>}
      </Card>

      <Card>
        <p className="mb-3 flex items-center gap-2 font-bold text-theme-text"><Database size={16} /> Data management</p>
        <p className="text-sm text-theme-muted">Data deletion and cache management are not enabled because the current live API does not expose those operations.</p>
      </Card>
    </div>}

    {section === "Activity Logs" && <Card>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 font-bold text-theme-text"><ClipboardList size={18} /> Live activity</p>
          <p className="mt-1 text-sm text-theme-muted">Recent sensor readings and incidents from the live monitoring API.</p>
        </div>
        <ExportCsvButton filename="activity-log.csv" rows={activityRows} />
      </div>
      {activityRows.length > 0 ? <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-theme-border text-theme-muted"><tr><th className="p-3">Type</th><th className="p-3">Recorded</th><th className="p-3">Sensor</th><th className="p-3">Status</th><th className="p-3">Lux</th></tr></thead>
          <tbody>{activityRows.map((row, index) => <tr key={`${row.Type}-${row.Recorded}-${row.Sensor}-${index}`} className="border-b border-theme-border last:border-0"><td className="p-3 text-theme-muted">{row.Type}</td><td className="p-3 text-theme-muted">{row.Recorded}</td><td className="p-3 font-mono text-theme-text">{row.Sensor}</td><td className="p-3"><Badge tone={row.Status === "violation" || row.Status === "open" ? "red" : row.Status === "warning" || row.Status === "acknowledged" ? "amber" : "green"}>{row.Status}</Badge></td><td className="p-3 font-mono text-theme-text">{row.Lux.toFixed(2)}</td></tr>)}</tbody>
        </table>
      </div> : <p className="text-sm text-theme-muted">No live activity available.</p>}
    </Card>}

    <Modal open={addUserOpen} onClose={() => setAddUserOpen(false)} title="Add user" description="Invites a new account and assigns it a role." footer={<>
      <button type="button" onClick={() => setAddUserOpen(false)} className="rounded-lg border border-theme-border px-4 py-2 text-sm font-semibold text-theme-secondary-text hover:text-theme-text">Cancel</button>
      <button type="submit" form="add-user-form" disabled={addUserBusy} className="rounded-lg bg-theme-accent px-4 py-2 text-sm font-semibold text-theme-accent-foreground hover:bg-theme-accent-hover disabled:opacity-50">{addUserBusy ? "Adding…" : "Add user"}</button>
    </>}>
      <form id="add-user-form" onSubmit={submitAddUser} className="space-y-4">
        <label className="block"><span className="mb-1.5 block text-sm font-semibold text-theme-secondary-text">Email</span><input type="email" required value={addUserForm.email} onChange={e => setAddUserForm(form => ({ ...form, email: e.target.value }))} className="w-full" /></label>
        <label className="block"><span className="mb-1.5 block text-sm font-semibold text-theme-secondary-text">Full name</span><input value={addUserForm.full_name} onChange={e => setAddUserForm(form => ({ ...form, full_name: e.target.value }))} className="w-full" /></label>
        <label className="block"><span className="mb-1.5 block text-sm font-semibold text-theme-secondary-text">Role</span><select value={addUserForm.role} onChange={e => setAddUserForm(form => ({ ...form, role: e.target.value as Role }))} className="w-full capitalize">{ROLES.map(role => <option key={role} value={role}>{role}</option>)}</select></label>
      </form>
    </Modal>

    <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete account" description={`This permanently removes ${deleteTarget?.email ?? "this user"}'s login and profile.`} footer={<>
      <button onClick={() => setDeleteTarget(null)} className="rounded-lg border border-theme-border px-4 py-2 text-sm font-semibold text-theme-secondary-text hover:text-theme-text">Cancel</button>
      <button onClick={confirmDeleteUser} disabled={deleteBusy} className="rounded-lg border border-theme-danger/30 px-4 py-2 text-sm font-semibold text-theme-danger hover:bg-theme-danger/10 disabled:opacity-50">{deleteBusy ? "Deleting…" : "Delete account"}</button>
    </>}>
      <p className="text-sm text-theme-secondary-text">{deleteTarget?.full_name || deleteTarget?.email}</p>
    </Modal>
  </div>;
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-theme-muted">{label}</dt><dd className="mt-1 font-mono font-semibold capitalize text-theme-text">{value}</dd></div>;
}