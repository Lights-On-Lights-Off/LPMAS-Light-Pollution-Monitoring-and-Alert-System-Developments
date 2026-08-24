"use client";
import { useMemo, useState, type FormEvent } from "react";
import { Activity, AlertTriangle, Plus, Trash2 } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Badge } from "../ui";
import { Modal, ModalField, modalButtonClass } from "../Modal";
import { ExportCsvButton } from "../ExportCsvButton";
import { mockActivityLog, mockGreenhouses as initialGreenhouses, mockRecycleBin, mockSoftAlerts, GREENHOUSE_BY_SENSOR } from "@/lib/mockData";
import { useDashboardData } from "@/lib/useDashboardData";
import { pivotReadingsBySensor, statusDistribution, STATUS_COLORS } from "@/lib/chartData";

const TITLES: Record<string, { title: string; description: string }> = {
  "Overview":     { title: "Manager overview", description: "KPIs, aggregate trends, and recent activity across all greenhouses." },
  "Greenhouses":  { title: "Greenhouses", description: "Active crop entries and their current phase." },
  "Recycle bin":  { title: "Recycle bin", description: "Recently deleted greenhouse records." }
};

const LINE_COLORS = ["#d9a441", "#7fb3d5", "#e5484d"];

export function ManagerView({ section }: { section: string }) {
  const meta = TITLES[section] ?? TITLES["Overview"];
  const { data, demo } = useDashboardData();

  const chart = useMemo(() => pivotReadingsBySensor(data.readings, GREENHOUSE_BY_SENSOR), [data.readings]);
  const distribution = useMemo(() => statusDistribution(data.readings), [data.readings]);
  const openIncidents = data.incidents.filter(i => i.status !== "resolved").length;

  // Greenhouses (add/delete via the shared modal — same pattern used on Admin)
  const [greenhouses, setGreenhouses] = useState(initialGreenhouses);
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", crop: "", phase: "Illumination", startedOn: new Date().toISOString().slice(0, 10) });
  const [deleteTarget, setDeleteTarget] = useState<typeof initialGreenhouses[number] | null>(null);

  function submitAddGreenhouse(e: FormEvent) {
    e.preventDefault();
    setGreenhouses(list => [...list, { id: Math.max(0, ...list.map(g => g.id)) + 1, status: "active", ...addForm }]);
    setAddOpen(false);
    setAddForm({ name: "", crop: "", phase: "Illumination", startedOn: new Date().toISOString().slice(0, 10) });
  }
  function confirmDeleteGreenhouse() {
    if (!deleteTarget) return;
    setGreenhouses(list => list.filter(g => g.id !== deleteTarget.id));
    setDeleteTarget(null);
  }

  return <div className="space-y-6 p-6 md:p-8">
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold text-metal-50">{meta.title}</h1>
        <p className="mt-1 text-sm text-metal-400">{meta.description}</p>
      </div>
      {demo && section === "Overview" && <Badge tone="amber">Demo data — Pi not reachable</Badge>}
    </div>

    {section === "Overview" && <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><p className="text-sm text-metal-400">Active greenhouses</p><p className="mt-1 font-mono text-2xl font-bold text-metal-50">{greenhouses.filter(g => g.status === "active").length}</p></Card>
        <Card><p className="text-sm text-metal-400">Open incidents</p><p className="mt-1 font-mono text-2xl font-bold text-metal-50">{openIncidents}</p></Card>
        <Card><p className="text-sm text-metal-400">Sensors reporting</p><p className="mt-1 font-mono text-2xl font-bold text-metal-50">{Object.keys(GREENHOUSE_BY_SENSOR).length}</p></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <p className="mb-1 font-bold text-metal-50">All-greenhouse light trend</p>
          <p className="mb-4 text-sm text-metal-400">Aggregate lux across every active greenhouse, not just one at a time</p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart}>
                <defs>
                  {Object.values(GREENHOUSE_BY_SENSOR).map((label, i) => <linearGradient key={label} id={`m-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0} />
                  </linearGradient>)}
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#232427" />
                <XAxis dataKey="time" tick={{ fontSize: 11, fill: "#6f7278" }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: "#6f7278" }} width={35} />
                <Tooltip contentStyle={{ borderRadius: 12, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {Object.values(GREENHOUSE_BY_SENSOR).map((label, i) => <Area key={label} type="monotone" dataKey={label} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} fill={`url(#m-${i})`} />)}
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

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <p className="flex items-center gap-2 font-bold text-metal-50"><Activity size={18} /> Activity log</p>
          <ExportCsvButton filename="activity-log.csv" rows={mockActivityLog} />
        </div>
        <div className="space-y-2">{mockActivityLog.map((a, i) => <div key={i} className="flex gap-3 border-b border-metal-700 py-2 text-sm last:border-0"><span className="font-mono text-metal-500">{a.time}</span><span className="text-metal-200">{a.text}</span></div>)}</div>
      </Card>

      <Card>
        <p className="mb-3 flex items-center gap-2 font-bold text-metal-50"><AlertTriangle size={18} /> Soft alerts</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-metal-700 text-metal-400"><tr><th className="p-3">Time</th><th className="p-3">Greenhouse</th><th className="p-3">Lux value</th></tr></thead>
            <tbody>{mockSoftAlerts.map(a => <tr key={a.id} className="border-b border-metal-700 last:border-0"><td className="p-3 font-mono text-metal-400">{a.time}</td><td className="p-3 text-metal-100">{a.greenhouse}</td><td className="p-3 font-mono text-metal-50">{a.lux.toFixed(1)}</td></tr>)}</tbody>
          </table>
        </div>
      </Card>
    </>}

    {section === "Greenhouses" && <Card>
      <div className="mb-4 flex items-center justify-between">
        <p className="font-bold text-metal-50">Greenhouse entries</p>
        <button onClick={() => setAddOpen(true)} className="flex items-center gap-1 rounded-lg bg-leaf-500 px-3 py-1.5 text-sm font-semibold text-ink hover:bg-leaf-100"><Plus size={15} /> Add greenhouse</button>
      </div>
      <div className="space-y-2">
        {greenhouses.map(g => <div key={g.id} className="flex items-center justify-between rounded-xl border border-metal-700 bg-white/[0.02] p-3">
          <div><p className="font-semibold text-metal-100">{g.name}</p><p className="text-xs text-metal-400">{g.crop} · started {g.startedOn}</p></div>
          <div className="flex items-center gap-3"><Badge tone="green">{g.phase}</Badge><button onClick={() => setDeleteTarget(g)} className="text-metal-500 hover:text-red-400"><Trash2 size={16} /></button></div>
        </div>)}
        {greenhouses.length === 0 && <p className="text-sm text-metal-400">No greenhouses yet.</p>}
      </div>
    </Card>}

    {section === "Recycle bin" && <Card>
      <p className="mb-4 font-bold text-metal-50">Recycle bin</p>
      <div className="space-y-2">
        {mockRecycleBin.map(r => <div key={r.id} className="flex items-center justify-between rounded-xl border border-metal-700 bg-white/[0.02] p-3 text-sm">
          <div><p className="font-semibold text-metal-100">{r.name}</p><p className="text-xs text-metal-400">{r.type} · deleted {r.deletedOn} by {r.deletedBy}</p></div>
          <button className="text-xs font-semibold text-leaf-500 hover:text-leaf-100">Restore</button>
        </div>)}
      </div>
    </Card>}

    <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add greenhouse" footer={<>
      <button type="button" onClick={() => setAddOpen(false)} className={modalButtonClass.secondary}>Cancel</button>
      <button type="submit" form="add-greenhouse-form" className={modalButtonClass.primary}>Add greenhouse</button>
    </>}>
      <form id="add-greenhouse-form" onSubmit={submitAddGreenhouse} className="space-y-4">
        <ModalField label="Name"><input required value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} className="w-full" /></ModalField>
        <ModalField label="Crop"><input required value={addForm.crop} onChange={e => setAddForm(f => ({ ...f, crop: e.target.value }))} className="w-full" /></ModalField>
        <div className="grid grid-cols-2 gap-4">
          <ModalField label="Phase">
            <select value={addForm.phase} onChange={e => setAddForm(f => ({ ...f, phase: e.target.value }))} className="w-full">
              <option>Illumination</option><option>Dark</option>
            </select>
          </ModalField>
          <ModalField label="Started on"><input type="date" value={addForm.startedOn} onChange={e => setAddForm(f => ({ ...f, startedOn: e.target.value }))} className="w-full" /></ModalField>
        </div>
      </form>
    </Modal>

    <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete greenhouse" description="This moves the entry to the recycle bin." footer={<>
      <button onClick={() => setDeleteTarget(null)} className={modalButtonClass.secondary}>Cancel</button>
      <button onClick={confirmDeleteGreenhouse} className={modalButtonClass.danger}>Delete</button>
    </>}>
      <p className="text-sm text-metal-300">{deleteTarget?.name}</p>
    </Modal>
  </div>;
}
