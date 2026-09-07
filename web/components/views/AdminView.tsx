"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { BarChart3, ClipboardList, Database, Pencil, Trash2, UserPlus, Users } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Badge } from "../ui";
import { Modal, ModalField, modalButtonClass } from "../Modal";
import { ExportCsvButton } from "../ExportCsvButton";
import { mockActivityLog, mockGreenhouses, mockPhaseConfig, mockSensorConfig, GREENHOUSE_BY_SENSOR } from "@/lib/mockData";
import { useDashboardData } from "@/lib/useDashboardData";
import { pivotReadingsBySensor, statusDistribution, STATUS_COLORS } from "@/lib/chartData";
import { listAdminUsers, createAdminUser, updateAdminUserRole, deleteAdminUser, type AdminUser } from "@/lib/adminUsers";
import type { Role } from "@/lib/profile";

const TITLES: Record<string, { title: string; description: string }> = {
  "Overview":        { title: "Admin overview", description: "Full system visibility across every greenhouse." },
  "Team":            { title: "Team management", description: "Invite staff and manage role-based access." },
  "System settings": { title: "System settings", description: "Phase cycle defaults and data management." },
  "Activity Logs":   { title: "Activity logs", description: "Full system activity, exportable for records." }
};

const LINE_COLORS = ["#d9a441", "#7fb3d5", "#e5484d"];
const ROLES: Role[] = ["technician", "manager", "admin"];

export function AdminView({ section }: { section: string }) {
  const meta = TITLES[section] ?? TITLES["Overview"];
  const { data, demo } = useDashboardData();

  // ---- Team (live from Supabase via /api/admin/users) --------------------
  const [team, setTeam] = useState<AdminUser[] | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [teamLoading, setTeamLoading] = useState(true);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addUserForm, setAddUserForm] = useState({ email: "", full_name: "", role: "technician" as Role });
  const [addUserBusy, setAddUserBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function refreshTeam() {
    setTeamLoading(true);
    try { setTeam((await listAdminUsers()).users); setTeamError(null); }
    catch (e) { setTeamError(e instanceof Error ? e.message : "Failed to load team"); }
    finally { setTeamLoading(false); }
  }
  useEffect(() => { refreshTeam(); }, []);

  async function changeRole(id: string, role: Role) {
    setTeam(t => t?.map(u => (u.id === id ? { ...u, role } : u)) ?? t); // optimistic
    try { await updateAdminUserRole(id, role); } catch (e) { setTeamError(e instanceof Error ? e.message : "Failed to update role"); refreshTeam(); }
  }

  async function submitAddUser(e: FormEvent) {
    e.preventDefault();
    setAddUserBusy(true);
    try {
      await createAdminUser(addUserForm.email, addUserForm.role, addUserForm.full_name || undefined);
      setAddUserOpen(false);
      setAddUserForm({ email: "", full_name: "", role: "technician" });
      refreshTeam();
    } catch (e) { setTeamError(e instanceof Error ? e.message : "Failed to add user"); }
    finally { setAddUserBusy(false); }
  }

  async function confirmDeleteUser() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try { await deleteAdminUser(deleteTarget.id); setDeleteTarget(null); refreshTeam(); }
    catch (e) { setTeamError(e instanceof Error ? e.message : "Failed to delete user"); }
    finally { setDeleteBusy(false); }
  }

  // ---- System settings (read-only display, edited via shared modal) ------
  const [sensorConfig, setSensorConfig] = useState(mockSensorConfig);
  const [phaseConfig, setPhaseConfig] = useState(mockPhaseConfig);
  const [editingSensor, setEditingSensor] = useState<typeof mockSensorConfig[number] | null>(null);
  const [editSensorForm, setEditSensorForm] = useState<typeof mockSensorConfig[number] | null>(null);
  const [editingPhase, setEditingPhase] = useState(false);
  const [editPhaseForm, setEditPhaseForm] = useState(mockPhaseConfig);
  const [confirmDeleteData, setConfirmDeleteData] = useState(false);

  function openSensorEdit(row: typeof mockSensorConfig[number]) { setEditingSensor(row); setEditSensorForm(row); }
  function saveSensorEdit(e: FormEvent) {
    e.preventDefault();
    if (!editSensorForm) return;
    setSensorConfig(list => list.map(s => (s.id === editSensorForm.id ? editSensorForm : s)));
    setEditingSensor(null);
  }
  function openPhaseEdit() { setEditPhaseForm(phaseConfig); setEditingPhase(true); }
  function savePhaseEdit(e: FormEvent) {
    e.preventDefault();
    setPhaseConfig(editPhaseForm);
    setEditingPhase(false);
  }

  // ---- Overview charts -----------------------------------------------------
  const chart = useMemo(() => pivotReadingsBySensor(data.readings, GREENHOUSE_BY_SENSOR), [data.readings]);
  const distribution = useMemo(() => statusDistribution(data.readings), [data.readings]);
  const openIncidents = data.incidents.filter(i => i.status !== "resolved").length;

  return <div className="space-y-6 p-6 md:p-8">
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold text-metal-50">{meta.title}</h1>
        <p className="mt-1 text-sm text-metal-400">{meta.description}</p>
      </div>
      {demo && section === "Overview" && <Badge tone="amber">Demo data — Pi not reachable</Badge>}
    </div>

    {section === "Overview" && <>
      <div className="grid gap-4 sm:grid-cols-4">
        <Card><p className="text-sm text-metal-400">Greenhouses</p><p className="mt-1 font-mono text-2xl font-bold text-metal-50">{mockGreenhouses.filter(g => g.status === "active").length}</p></Card>
        <Card><p className="text-sm text-metal-400">Sensors</p><p className="mt-1 font-mono text-2xl font-bold text-metal-50">{Object.keys(GREENHOUSE_BY_SENSOR).length}</p></Card>
        <Card><p className="text-sm text-metal-400">Incidents</p><p className="mt-1 font-mono text-2xl font-bold text-metal-50">{openIncidents}</p></Card>
        <Card><p className="text-sm text-metal-400">Team members</p><p className="mt-1 font-mono text-2xl font-bold text-metal-50">{team ? team.length : "—"}</p></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <p className="mb-1 flex items-center gap-2 font-bold text-metal-50"><BarChart3 size={18} /> Lux trend, all sensors</p>
          <p className="mb-4 text-sm text-metal-400">Live BH1750 readings across every greenhouse</p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart}>
                <defs>
                  {Object.values(GREENHOUSE_BY_SENSOR).map((label, i) => <linearGradient key={label} id={`a-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0} />
                  </linearGradient>)}
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#232427" />
                <XAxis dataKey="time" tick={{ fontSize: 11, fill: "#6f7278" }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: "#6f7278" }} width={35} />
                <Tooltip contentStyle={{ borderRadius: 12, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {Object.values(GREENHOUSE_BY_SENSOR).map((label, i) => <Area key={label} type="monotone" dataKey={label} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} fill={`url(#a-${i})`} />)}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <p className="mb-4 font-bold text-metal-50">Status distribution</p>
          <div className="mb-2 flex flex-wrap gap-3 text-xs text-metal-400">
            {distribution.map(d => <span key={d.key} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[d.key] }} />{d.name}</span>)}
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={distribution} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2}>
                  {distribution.map(d => <Cell key={d.key} fill={STATUS_COLORS[d.key]} />)}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: 12, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </>}

    {section === "Team" && <Card>
      <div className="mb-4 flex items-center justify-between">
        <p className="font-bold text-metal-50">Team management</p>
        <button onClick={() => setAddUserOpen(true)} className="flex items-center gap-1 rounded-lg bg-leaf-500 px-3 py-1.5 text-sm font-semibold text-ink hover:bg-leaf-100"><UserPlus size={15} /> Add user</button>
      </div>

      {teamError && <p className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{teamError}</p>}
      {teamLoading && <p className="text-sm text-metal-400">Loading team…</p>}

      {!teamLoading && team && <div className="space-y-2">
        {team.map(m => <div key={m.id} className="flex items-center justify-between rounded-xl border border-metal-700 bg-white/[0.02] p-3">
          <div className="flex items-center gap-3"><span className="rounded-full bg-leaf-500/15 p-2 text-leaf-500"><Users size={16} /></span><div><p className="font-semibold text-metal-100">{m.full_name || "Unnamed"}</p><p className="text-xs text-metal-400">{m.email}</p></div></div>
          <div className="flex items-center gap-3">
            <select value={m.role} onChange={e => changeRole(m.id, e.target.value as Role)} className="rounded-lg px-2 py-1 text-xs capitalize">
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <button onClick={() => setDeleteTarget(m)} className="text-metal-500 hover:text-red-400"><Trash2 size={16} /></button>
          </div>
        </div>)}
        {team.length === 0 && <p className="text-sm text-metal-400">No team members yet.</p>}
      </div>}
    </Card>}

    {section === "System settings" && <div className="space-y-4">
      <Card className="w-full">
        <div className="mb-4 flex items-center justify-between">
          <p className="font-bold text-metal-50">Phase cycle configuration</p>
          <button onClick={openPhaseEdit} className="flex items-center gap-1 rounded-lg border border-metal-600 px-3 py-1.5 text-xs font-semibold text-metal-200 hover:text-leaf-500"><Pencil size={13} /> Edit</button>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SettingRow label="Illumination phase length" value={`${phaseConfig.illuminationDays} days`} />
          <SettingRow label="Dark phase length" value={`${phaseConfig.darkDays} days`} />
          <SettingRow label="Alert channel" value={phaseConfig.alertChannel} />
          <SettingRow label="Timezone" value={phaseConfig.timezone} />
        </dl>
        <p className="mt-4 text-xs text-metal-500">Default cycle is {phaseConfig.illuminationDays + phaseConfig.darkDays} days total ({phaseConfig.illuminationDays} illumination + {phaseConfig.darkDays} dark). Adjust per crop as needed.</p>
      </Card>

      <Card className="w-full">
        <p className="mb-4 font-bold text-metal-50">Sensor configuration</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-metal-700 text-metal-400">
              <tr><th className="p-3">Sensor</th><th className="p-3">Greenhouse</th><th className="p-3">Interval</th><th className="p-3">Lux min</th><th className="p-3">Lux max</th><th className="p-3">Calibration</th><th className="p-3">Updated</th><th className="p-3" /></tr>
            </thead>
            <tbody>
              {sensorConfig.map(s => <tr key={s.id} className="border-b border-metal-700 last:border-0">
                <td className="p-3 font-mono text-metal-400">{s.id}</td>
                <td className="p-3 text-metal-100">{s.greenhouse}</td>
                <td className="p-3 text-metal-300">{s.reportingIntervalSec}s</td>
                <td className="p-3 font-mono text-metal-300">{s.luxMin}</td>
                <td className="p-3 font-mono text-metal-300">{s.luxMax}</td>
                <td className="p-3 font-mono text-metal-300">{s.calibrationOffset > 0 ? "+" : ""}{s.calibrationOffset}</td>
                <td className="p-3 text-metal-500">{s.updatedAt}</td>
                <td className="p-3"><button onClick={() => openSensorEdit(s)} className="text-metal-400 hover:text-leaf-500"><Pencil size={15} /></button></td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="w-full">
        <p className="mb-3 flex items-center gap-2 font-bold text-red-300"><Database size={16} /> Data management</p>
        <div className="flex flex-wrap gap-3">
          <button className="rounded-lg border border-red-400/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10">Clear system cache</button>
          <button onClick={() => setConfirmDeleteData(true)} className="rounded-lg border border-red-400/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10">Delete system data</button>
        </div>
      </Card>
    </div>}

    {section === "Activity Logs" && <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-2 font-bold text-metal-50"><ClipboardList size={18} /> Full activity log</p>
        <ExportCsvButton filename="activity-log.csv" rows={mockActivityLog} />
      </div>
      <div className="space-y-2">{mockActivityLog.map((a, i) => <div key={i} className="flex gap-3 border-b border-metal-700 py-2 text-sm last:border-0"><span className="font-mono text-metal-500">{a.time}</span><span className="text-metal-200">{a.text}</span></div>)}</div>
    </Card>}

    {/* ---- Modals (shared pattern across every edit/add/delete action) ---- */}

    <Modal open={addUserOpen} onClose={() => setAddUserOpen(false)} title="Add user" description="Invites a new account and assigns it a role." footer={<>
      <button type="button" onClick={() => setAddUserOpen(false)} className={modalButtonClass.secondary}>Cancel</button>
      <button type="submit" form="add-user-form" disabled={addUserBusy} className={modalButtonClass.primary}>{addUserBusy ? "Adding…" : "Add user"}</button>
    </>}>
      <form id="add-user-form" onSubmit={submitAddUser} className="space-y-4">
        <ModalField label="Email"><input type="email" required value={addUserForm.email} onChange={e => setAddUserForm(f => ({ ...f, email: e.target.value }))} className="w-full" /></ModalField>
        <ModalField label="Full name (optional)"><input value={addUserForm.full_name} onChange={e => setAddUserForm(f => ({ ...f, full_name: e.target.value }))} className="w-full" /></ModalField>
        <ModalField label="Role">
          <select value={addUserForm.role} onChange={e => setAddUserForm(f => ({ ...f, role: e.target.value as Role }))} className="w-full capitalize">
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </ModalField>
      </form>
    </Modal>

    <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete account" description={`This permanently removes ${deleteTarget?.email ?? "this user"}'s login and profile. This cannot be undone.`} footer={<>
      <button onClick={() => setDeleteTarget(null)} className={modalButtonClass.secondary}>Cancel</button>
      <button onClick={confirmDeleteUser} disabled={deleteBusy} className={modalButtonClass.danger}>{deleteBusy ? "Deleting…" : "Delete account"}</button>
    </>}>
      <p className="text-sm text-metal-300">{deleteTarget?.full_name || deleteTarget?.email}</p>
    </Modal>

    <Modal open={!!editingSensor} onClose={() => setEditingSensor(null)} title={`Edit ${editingSensor?.id ?? "sensor"}`} description={`Configuration for ${editingSensor?.greenhouse ?? ""}`} footer={<>
      <button type="button" onClick={() => setEditingSensor(null)} className={modalButtonClass.secondary}>Cancel</button>
      <button type="submit" form="edit-sensor-form" className={modalButtonClass.primary}>Save changes</button>
    </>}>
      {editSensorForm && <form id="edit-sensor-form" onSubmit={saveSensorEdit} className="space-y-4">
        <ModalField label="Reporting interval (seconds)"><input type="number" value={editSensorForm.reportingIntervalSec} onChange={e => setEditSensorForm(f => f && { ...f, reportingIntervalSec: Number(e.target.value) })} className="w-full" /></ModalField>
        <div className="grid grid-cols-2 gap-4">
          <ModalField label="Lux min"><input type="number" value={editSensorForm.luxMin} onChange={e => setEditSensorForm(f => f && { ...f, luxMin: Number(e.target.value) })} className="w-full" /></ModalField>
          <ModalField label="Lux max"><input type="number" value={editSensorForm.luxMax} onChange={e => setEditSensorForm(f => f && { ...f, luxMax: Number(e.target.value) })} className="w-full" /></ModalField>
        </div>
        <ModalField label="Calibration offset"><input type="number" step="0.1" value={editSensorForm.calibrationOffset} onChange={e => setEditSensorForm(f => f && { ...f, calibrationOffset: Number(e.target.value) })} className="w-full" /></ModalField>
      </form>}
    </Modal>

    <Modal open={editingPhase} onClose={() => setEditingPhase(false)} title="Edit phase cycle configuration" footer={<>
      <button type="button" onClick={() => setEditingPhase(false)} className={modalButtonClass.secondary}>Cancel</button>
      <button type="submit" form="edit-phase-form" className={modalButtonClass.primary}>Save changes</button>
    </>}>
      <form id="edit-phase-form" onSubmit={savePhaseEdit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <ModalField label="Illumination phase (days)"><input type="number" value={editPhaseForm.illuminationDays} onChange={e => setEditPhaseForm(f => ({ ...f, illuminationDays: Number(e.target.value) }))} className="w-full" /></ModalField>
          <ModalField label="Dark phase (days)"><input type="number" value={editPhaseForm.darkDays} onChange={e => setEditPhaseForm(f => ({ ...f, darkDays: Number(e.target.value) }))} className="w-full" /></ModalField>
        </div>
        <ModalField label="Alert channel"><input value={editPhaseForm.alertChannel} onChange={e => setEditPhaseForm(f => ({ ...f, alertChannel: e.target.value }))} className="w-full" /></ModalField>
        <ModalField label="Timezone"><input value={editPhaseForm.timezone} onChange={e => setEditPhaseForm(f => ({ ...f, timezone: e.target.value }))} className="w-full" /></ModalField>
      </form>
    </Modal>

    <Modal open={confirmDeleteData} onClose={() => setConfirmDeleteData(false)} title="Delete system data" description="This clears all cached readings and logs. This cannot be undone." footer={<>
      <button onClick={() => setConfirmDeleteData(false)} className={modalButtonClass.secondary}>Cancel</button>
      <button onClick={() => setConfirmDeleteData(false)} className={modalButtonClass.danger}>Delete data</button>
    </>}>
      <p className="text-sm text-metal-300">Wire this up to your actual data-deletion endpoint before relying on it — right now it's a confirmation-only placeholder.</p>
    </Modal>
  </div>;
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return <div>
    <dt className="text-xs text-metal-400">{label}</dt>
    <dd className="mt-1 font-mono font-semibold text-metal-50">{value}</dd>
  </div>;
}
