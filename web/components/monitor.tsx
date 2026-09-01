"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Area, AreaChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowLeft } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useDashboardData } from "@/lib/useDashboardData";
import { pivotReadingsBySensor, statusDistribution, latestBySensor, STATUS_COLORS } from "@/lib/chartData";
import { GREENHOUSE_BY_SENSOR } from "@/lib/mockData";
import { Card, Badge } from "@/components/ui";

const SENSOR_IDS = ["sensor1", "sensor2"];
const LINE_COLORS = ["#d9a441", "#7fb3d5"];

export function Monitor() {
  const { data, demo } = useDashboardData();
  const [selectedSensor, setSelectedSensor] = useState("sensor1");

  const latest = useMemo(() => latestBySensor(data.readings), [data.readings]);
  const chart = useMemo(() => pivotReadingsBySensor(data.readings, GREENHOUSE_BY_SENSOR), [data.readings]);
  const distribution = useMemo(() => statusDistribution(data.readings), [data.readings]);
  const onlineCount = useMemo(() => {
    let n = 0;
    for (const r of latest.values()) if (Date.now() - new Date(r.recorded_at).getTime() < 60_000) n++;
    return n;
  }, [latest]);
  const openIncidents = data.incidents.filter(i => i.status !== "resolved").length;

  const selected = latest.get(selectedSensor);

  return <main className="min-h-screen bg-ink font-sans text-metal-100">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-metal-700 bg-metal-800/60 px-5 py-4 md:px-8">
      <div className="flex items-center gap-3">
        <span className="h-2.5 w-2.5 rounded-full bg-leaf-500 shadow-glow" />
        <div>
          <h1 className="font-bold text-metal-50">LPMAS Live Monitor</h1>
          <p className="text-xs text-metal-400">Smart light pollution monitoring — no sign-in required</p>
        </div>
      </div>
      <div className="flex items-center gap-4 text-sm">
        {demo && <Badge tone="amber">Demo data — Pi not reachable</Badge>}
        <span className="hidden text-metal-400 sm:inline">Realtime Flowerland Greenhouse Network</span>
        <Link href="/login" className="rounded-full bg-leaf-500 px-4 py-2 text-xs font-semibold text-ink hover:bg-leaf-100">Staff sign in</Link>
      </div>
    </header>

    <div className="grid gap-5 p-5 md:p-8 xl:grid-cols-[1.7fr_1fr]">
      {/* Main column — sensor table + trend line, in place of the map */}
      <div className="space-y-5">
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-metal-50">Sensor readings</h2>
              <p className="mt-1 text-sm text-metal-400">Latest lux reading from every greenhouse sensor</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-metal-700 text-metal-400">
                <tr><th className="p-3">Greenhouse</th><th className="p-3">Sensor</th><th className="p-3">Lux</th><th className="p-3">Status</th><th className="p-3">Last updated</th></tr>
              </thead>
              <tbody>
                {SENSOR_IDS.map(id => {
                  const r = latest.get(id);
                  const online = r && Date.now() - new Date(r.recorded_at).getTime() < 60_000;
                  return <tr key={id} className={`cursor-pointer border-b border-metal-700 last:border-0 hover:bg-white/[0.03] ${selectedSensor === id ? "bg-leaf-500/[0.06]" : ""}`} onClick={() => setSelectedSensor(id)}>
                    <td className="p-3 font-semibold text-metal-100">{GREENHOUSE_BY_SENSOR[id]}</td>
                    <td className="p-3 font-mono text-metal-400">{id}</td>
                    <td className="p-3 font-mono font-semibold text-metal-50">{r ? r.lux.toFixed(1) : "—"}</td>
                    <td className="p-3"><Badge tone={r?.classification === "violation" ? "red" : r?.classification === "warning" ? "amber" : "green"}>{r?.classification ?? "no data"}</Badge></td>
                    <td className="p-3 text-metal-400">{r ? `${online ? "" : "⚠ "}${formatDistanceToNow(new Date(r.recorded_at), { addSuffix: true })}` : "—"}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <h2 className="font-bold text-metal-50">Light intensity trend</h2>
          <p className="mt-1 text-sm text-metal-400">Recent BH1750 readings, all greenhouses</p>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart}>
                <defs>
                  {Object.values(GREENHOUSE_BY_SENSOR).map((label, i) => <linearGradient key={label} id={`g-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0} />
                  </linearGradient>)}
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#232427" />
                <XAxis dataKey="time" tick={{ fontSize: 11, fill: "#6f7278" }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: "#6f7278" }} width={35} />
                <Tooltip contentStyle={{ borderRadius: 12, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {Object.values(GREENHOUSE_BY_SENSOR).map((label, i) => <Area key={label} type="monotone" dataKey={label} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} fill={`url(#g-${i})`} />)}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 font-bold text-metal-50">Monitoring log</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-metal-700 text-metal-400">
                <tr><th className="p-3">Greenhouse</th><th className="p-3">Status</th><th className="p-3">Lux</th><th className="p-3">Recorded</th></tr>
              </thead>
              <tbody>
                {data.readings.slice(0, 12).map(r => <tr key={r.id} className="border-b border-metal-700 last:border-0">
                  <td className="p-3 text-metal-100">{GREENHOUSE_BY_SENSOR[r.sensor_id] ?? r.sensor_id}</td>
                  <td className="p-3"><Badge tone={r.classification === "violation" ? "red" : r.classification === "warning" ? "amber" : "green"}>{r.classification}</Badge></td>
                  <td className="p-3 font-mono text-metal-100">{r.lux.toFixed(2)}</td>
                  <td className="p-3 text-metal-400">{new Date(r.recorded_at).toLocaleString()}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Right column — KPIs, status distribution, selected-sensor summary */}
      <div className="space-y-5">
        <Card>
          <h2 className="mb-3 font-bold text-metal-50">Sensor KPIs</h2>
          <div className="grid grid-cols-2 gap-3">
            <Kpi label="Total sensors" value={SENSOR_IDS.length} />
            <Kpi label="Online" value={onlineCount} />
            <Kpi label="Offline" value={SENSOR_IDS.length - onlineCount} />
            <Kpi label="Open incidents" value={openIncidents} tone={openIncidents ? "red" : undefined} />
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 font-bold text-metal-50">Status distribution</h2>
          <div className="mb-2 flex flex-wrap gap-3 text-xs text-metal-400">
            {distribution.map(d => <span key={d.key} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[d.key] }} />{d.name}</span>)}
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={distribution} dataKey="value" nameKey="name" innerRadius={40} outerRadius={65} paddingAngle={2}>
                  {distribution.map(d => <Cell key={d.key} fill={STATUS_COLORS[d.key]} />)}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: 12, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <h2 className="font-bold text-metal-50">Sensor summary</h2>
          <select value={selectedSensor} onChange={e => setSelectedSensor(e.target.value)} className="mt-3 w-full">
            {SENSOR_IDS.map(id => <option key={id} value={id}>{GREENHOUSE_BY_SENSOR[id]} ({id})</option>)}
          </select>
          {selected ? <div className="mt-4 space-y-3 text-sm">
            <SummaryRow label="Status" value={<Badge tone={selected.classification === "violation" ? "red" : selected.classification === "warning" ? "amber" : "green"}>{selected.classification}</Badge>} />
            <SummaryRow label="Lux" value={`${selected.lux.toFixed(1)} lux`} />
            <SummaryRow label="Phase" value={selected.phase_type} />
            <SummaryRow label="Last reading" value={formatDistanceToNow(new Date(selected.recorded_at), { addSuffix: true })} />
          </div> : <p className="mt-4 text-sm text-metal-400">No data for this sensor yet.</p>}
        </Card>
      </div>
    </div>

    <footer className="border-t border-metal-700 px-5 py-6 md:px-8">
      <Link href="/" className="inline-flex items-center gap-2 text-sm text-metal-400 hover:text-metal-100"><ArrowLeft size={15} /> Back to home</Link>
    </footer>
  </main>;
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "red" }) {
  return <div className="rounded-xl border border-metal-700 bg-white/[0.02] p-3">
    <p className="text-xs text-metal-400">{label}</p>
    <p className={`mt-1 font-mono text-xl font-bold ${tone === "red" ? "text-red-400" : "text-metal-50"}`}>{value}</p>
  </div>;
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="flex items-center justify-between border-b border-metal-700 pb-3 last:border-0 last:pb-0">
    <span className="text-metal-400">{label}</span>
    <span className="font-semibold text-metal-100">{value}</span>
  </div>;
}
