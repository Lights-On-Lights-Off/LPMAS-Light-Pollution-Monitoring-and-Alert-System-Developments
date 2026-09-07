"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowLeft } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useDashboardData } from "@/lib/useDashboardData";
import { latestBySensor, STATUS_COLORS } from "@/lib/chartData";
import { GREENHOUSE_BY_SENSOR } from "@/lib/mockData";
import { Card, Badge } from "@/components/ui";

const SENSOR_IDS = ["sensor1", "sensor2"];
const LINE_COLOR = "#d9a441";

export function Monitor() {
  const { data, loading, error } = useDashboardData();
  const [selectedSensor, setSelectedSensor] = useState("sensor1");

  const latest = useMemo(() => latestBySensor(data.readings), [data.readings]);
  const selected = latest.get(selectedSensor);

  const selectedReadings = useMemo(() => data.readings
    .filter(r => r.sensor_id === selectedSensor)
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime())
    .slice(-20)
    .map(r => ({
      time: new Date(r.recorded_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      lux: r.lux
    })), [data.readings, selectedSensor]);

  const distribution = useMemo(() => {
    const counts = { safe: 0, warning: 0, violation: 0 };

    data.readings
      .filter(r => r.sensor_id === selectedSensor)
      .forEach(r => {
        if (r.classification in counts) counts[r.classification as keyof typeof counts]++;
      });

    return Object.entries(counts).map(([key, value]) => ({
      key,
      value,
      name: key.charAt(0).toUpperCase() + key.slice(1)
    }));
  }, [data.readings, selectedSensor]);

  const onlineCount = useMemo(() => {
    let count = 0;

    for (const id of SENSOR_IDS) {
      const reading = latest.get(id);
      if (reading && Date.now() - new Date(reading.recorded_at).getTime() < 20_000) count++;
    }

    return count;
  }, [latest]);

  const openIncidents = data.incidents.filter(i => i.status !== "resolved").length;

  return <main className="min-h-screen bg-ink font-sans text-metal-100">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-metal-700 bg-metal-800/60 px-5 py-4 md:px-8">
      <div className="flex items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${loading ? "bg-metal-500" : error ? "bg-red-500" : "bg-leaf-500 shadow-glow"}`} />
        <div>
          <h1 className="font-bold text-metal-50">LPMAS Live Monitor</h1>
          <p className="text-xs text-metal-400">Live lux monitoring from the greenhouse sensor network</p>
        </div>
      </div>
      <div className="flex items-center gap-4 text-sm">
        <span className={`text-xs ${error ? "text-red-400" : "text-leaf-400"}`}>
          {loading ? "Connecting..." : error ? "Connection unavailable" : "Live"}
        </span>
        <Link href="/login" className="rounded-full bg-leaf-500 px-4 py-2 text-xs font-semibold text-ink hover:bg-leaf-100">Staff sign in</Link>
      </div>
    </header>

    <div className="grid gap-5 p-5 md:p-8 xl:grid-cols-[1.7fr_1fr]">
      <div className="space-y-5">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-bold text-metal-50">Current Reading</h2>
              <p className="mt-1 text-sm text-metal-400">Live lux reading from the selected greenhouse</p>
            </div>
            <select value={selectedSensor} onChange={e => setSelectedSensor(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100">
              {SENSOR_IDS.map(id => <option key={id} value={id}>{GREENHOUSE_BY_SENSOR[id]}</option>)}
            </select>
          </div>

          <div className="mt-6 flex items-end justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-metal-400">{GREENHOUSE_BY_SENSOR[selectedSensor]}</p>
              <p className="mt-1 font-mono text-5xl font-bold text-metal-50">{selected ? selected.lux.toFixed(2) : "—"}</p>
              <p className="mt-1 text-sm text-metal-400">lux</p>
            </div>
            <div className="text-right">
              <Badge tone={selected?.classification === "violation" ? "red" : selected?.classification === "warning" ? "amber" : "green"}>{selected?.classification ?? "no data"}</Badge>
              {selected && <p className="mt-2 text-xs text-metal-400">{formatDistanceToNow(new Date(selected.recorded_at), { addSuffix: true })}</p>}
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-bold text-metal-50">Lux Readings</h2>
              <p className="mt-1 text-sm text-metal-400">{GREENHOUSE_BY_SENSOR[selectedSensor]} · updates every 5 seconds</p>
            </div>
            <span className="text-xs text-metal-400">{selectedReadings.length} readings</span>
          </div>

          <div className="mt-4 h-64">
            {selectedReadings.length ? <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={selectedReadings}>
                <defs>
                  <linearGradient id="lux-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={LINE_COLOR} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={LINE_COLOR} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#232427" />
                <XAxis dataKey="time" tick={{ fontSize: 11, fill: "#6f7278" }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: "#6f7278" }} width={45} />
                <Tooltip contentStyle={{ borderRadius: 12, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} formatter={(value) => [`${Number(value).toFixed(2)} lux`, "Reading"]} />
                <Area type="monotone" dataKey="lux" stroke={LINE_COLOR} strokeWidth={2} fill="url(#lux-fill)" />
              </AreaChart>
            </ResponsiveContainer> : <div className="flex h-full items-center justify-center text-sm text-metal-400">Waiting for live sensor readings...</div>}
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-bold text-metal-50">Monitoring Log</h2>
              <p className="mt-1 text-sm text-metal-400">Latest readings received from the sensors</p>
            </div>
            <span className="text-xs text-metal-400">Live</span>
          </div>

          <div className="mt-4 max-h-64 overflow-y-auto overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 border-b border-metal-700 bg-metal-800 text-metal-400">
                <tr><th className="p-3">Greenhouse</th><th className="p-3">Sensor</th><th className="p-3">Lux</th><th className="p-3">Status</th><th className="p-3">Recorded</th></tr>
              </thead>
              <tbody>
                {data.readings.slice(0, 20).map(r => <tr key={r.id} className="border-b border-metal-700 last:border-0">
                  <td className="p-3 text-metal-100">{GREENHOUSE_BY_SENSOR[r.sensor_id] ?? r.sensor_id}</td>
                  <td className="p-3 font-mono text-metal-400">{r.sensor_id}</td>
                  <td className="p-3 font-mono font-semibold text-metal-50">{r.lux.toFixed(2)}</td>
                  <td className="p-3"><Badge tone={r.classification === "violation" ? "red" : r.classification === "warning" ? "amber" : "green"}>{r.classification}</Badge></td>
                  <td className="p-3 text-metal-400">{new Date(r.recorded_at).toLocaleString()}</td>
                </tr>)}
                {!data.readings.length && <tr><td colSpan={5} className="p-6 text-center text-metal-400">No live readings received yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="space-y-5">
        <Card>
          <h2 className="mb-3 font-bold text-metal-50">Sensor KPIs</h2>
          <div className="grid grid-cols-2 gap-3">
            <Kpi label="Total sensors" value={2} />
            <Kpi label="Online" value={onlineCount} />
            <Kpi label="Offline" value={2 - onlineCount} />
            <Kpi label="Open incidents" value={openIncidents} tone={openIncidents ? "red" : undefined} />
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-bold text-metal-50">Status Distribution</h2>
              <p className="mt-1 text-sm text-metal-400">{GREENHOUSE_BY_SENSOR[selectedSensor]}</p>
            </div>
            <select value={selectedSensor} onChange={e => setSelectedSensor(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-2 py-1.5 text-xs text-metal-100">
              {SENSOR_IDS.map(id => <option key={id} value={id}>{GREENHOUSE_BY_SENSOR[id]}</option>)}
            </select>
          </div>

          <div className="mt-4 space-y-3">
            {distribution.map(d => <div key={d.key} className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-metal-400">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLORS[d.key as keyof typeof STATUS_COLORS] }} />
                {d.name}
              </span>
              <span className="font-mono text-sm text-metal-100">{d.value}</span>
            </div>)}
          </div>
        </Card>

        <Card>
          <h2 className="font-bold text-metal-50">Selected Greenhouse</h2>
          <select value={selectedSensor} onChange={e => setSelectedSensor(e.target.value)} className="mt-3 w-full rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100">
            {SENSOR_IDS.map(id => <option key={id} value={id}>{GREENHOUSE_BY_SENSOR[id]} ({id})</option>)}
          </select>

          {selected ? <div className="mt-4 space-y-3 text-sm">
            <SummaryRow label="Current lux" value={`${selected.lux.toFixed(2)} lux`} />
            <SummaryRow label="Status" value={<Badge tone={selected.classification === "violation" ? "red" : selected.classification === "warning" ? "amber" : "green"}>{selected.classification}</Badge>} />
            <SummaryRow label="Sensor" value={selected.sensor_id} />
            <SummaryRow label="Last reading" value={formatDistanceToNow(new Date(selected.recorded_at), { addSuffix: true })} />
          </div> : <p className="mt-4 text-sm text-metal-400">No live data for this greenhouse yet.</p>}
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