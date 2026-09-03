"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Area, AreaChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowLeft } from "lucide-react";
import { useDashboardData } from "@/lib/useDashboardData";
import type { Reading } from "@/lib/api";
import { Card, Badge } from "@/components/ui";

const GREENHOUSES = [{ id: "greenhouse1", name: "Greenhouse 1", sensors: [{ id: "sensor1", name: "Sensor 1" }, { id: "sensor2", name: "Sensor 2" }] }];
const LINE_COLORS = ["#d9a441", "#7fb3d5", "#e5484d", "#7bd389", "#b18cff"];
const STATUS_COLORS = { safe: "#7fbf7f", warning: "#d9a441", violation: "#e5484d" } as const;
const ONLINE_WINDOW = 60_000;

export function Monitor() {
  const { data, loading, error } = useDashboardData();
  const [selectedGreenhouse, setSelectedGreenhouse] = useState(GREENHOUSES[0].id);
  const [selectedSensor, setSelectedSensor] = useState("all");

  const greenhouse = GREENHOUSES.find(g => g.id === selectedGreenhouse) ?? GREENHOUSES[0];
  const sensors = greenhouse.sensors;
  const sensorIds = selectedSensor === "all" ? sensors.map(s => s.id) : sensors.filter(s => s.id === selectedSensor).map(s => s.id);

  const latest = useMemo(() => {
    const map = new Map<string, Reading>();
    for (const reading of data.readings) if (sensorIds.includes(reading.sensor_id)) {
      const current = map.get(reading.sensor_id);
      if (!current || new Date(reading.recorded_at).getTime() > new Date(current.recorded_at).getTime()) map.set(reading.sensor_id, reading);
    }
    return map;
  }, [data.readings, sensorIds.join(",")]);

  const chart = useMemo(() => {
    const rows = data.readings.filter(r => sensorIds.includes(r.sensor_id)).sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()).slice(-30);
    const map = new Map<string, Record<string, string | number>>();
    for (const reading of rows) {
      const key = new Date(reading.recorded_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const row = map.get(key) ?? { time: key };
      row[reading.sensor_id] = reading.lux;
      map.set(key, row);
    }
    return Array.from(map.values());
  }, [data.readings, sensorIds.join(",")]);

  const distribution = useMemo(() => {
    const counts = { safe: 0, warning: 0, violation: 0 };
    for (const reading of latest.values()) counts[reading.classification]++;
    return Object.entries(counts).filter(([, value]) => value > 0).map(([name, value]) => ({ name, value }));
  }, [latest]);

  const onlineCount = useMemo(() => Array.from(latest.values()).filter(r => Date.now() - new Date(r.recorded_at).getTime() < ONLINE_WINDOW).length, [latest]);
  const offlineCount = sensors.length - onlineCount;
  const incidentCount = data.incidents.filter(i => i.status !== "resolved" && sensorIds.includes(i.sensor_id)).length;

  const selectedReadings = useMemo(() => data.readings.filter(r => sensorIds.includes(r.sensor_id)).sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()).slice(0, 3), [data.readings, sensorIds.join(",")]);

  const phase = latest.values().next().value?.phase_type ?? data.phase?.phase_type ?? null;
  const phaseLabel = phase === "illumination" ? "Illumination" : phase === "dark" ? "Dark" : phase ?? "—";
  const phaseWindow = data.phase?.window_start && data.phase?.window_end ? `${data.phase.window_start} - ${data.phase.window_end}` : "—";
  const target = data.phase?.lux_min != null || data.phase?.lux_max != null ? `${data.phase.lux_min ?? "—"} - ${data.phase.lux_max ?? "—"} lux` : "—";
  const status = latest.size === 0 ? "Waiting for data" : onlineCount > 0 ? "Online" : "Offline";

  const handleGreenhouseChange = (value: string) => {
    setSelectedGreenhouse(value);
    setSelectedSensor("all");
  };

  return <main className="min-h-screen bg-ink font-sans text-metal-100">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-metal-700 bg-metal-800/60 px-5 py-4 md:px-8">
      <div className="flex items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${status === "Online" ? "bg-leaf-500 shadow-glow" : status === "Offline" ? "bg-red-400" : "bg-metal-500"}`} />
        <div><h1 className="font-bold text-metal-50">LPMAS Live Monitor</h1><p className="text-xs text-metal-400">Smart light pollution monitoring</p></div>
      </div>
      <div className="flex items-center gap-4 text-sm"><span className="hidden text-metal-400 sm:inline">System Status: {status}</span><Link href="/login" className="rounded-full bg-leaf-500 px-4 py-2 text-xs font-semibold text-ink hover:bg-leaf-100">Staff sign in</Link></div>
    </header>

    <div className="p-5 md:p-8">
      {error && <div className="mb-5 rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">Unable to load live sensor data. Waiting for a real sensor connection.</div>}

      <div className="grid items-stretch gap-5 xl:grid-cols-[1.7fr_1fr]">
        <Card className="h-full min-h-[34rem]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><h2 className="font-bold text-metal-50">Lux Intensity Trend</h2><p className="mt-1 text-sm text-metal-400">Real sensor readings from the selected greenhouse</p></div>
            <div className="flex flex-wrap gap-2">
              <select value={selectedGreenhouse} onChange={e => handleGreenhouseChange(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100">{GREENHOUSES.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
              <select value={selectedSensor} onChange={e => setSelectedSensor(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100"><option value="all">All Sensors</option>{sensors.map(sensor => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}</select>
            </div>
          </div>

          <div className="mt-6 h-[26rem]">
            {loading && !data.readings.length ? <div className="grid h-full place-items-center text-sm text-metal-400">Waiting for sensor data...</div> : !chart.length ? <div className="grid h-full place-items-center text-sm text-metal-400">No sensor data available</div> : <ResponsiveContainer width="100%" height="100%"><AreaChart data={chart}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#232427" /><XAxis dataKey="time" tick={{ fontSize: 11, fill: "#6f7278" }} interval="preserveStartEnd" /><YAxis tick={{ fontSize: 11, fill: "#6f7278" }} width={40} /><Tooltip contentStyle={{ borderRadius: 12, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} /><Legend wrapperStyle={{ fontSize: 12 }} />{sensors.filter(sensor => sensorIds.includes(sensor.id)).map((sensor, i) => <Area key={sensor.id} type="monotone" dataKey={sensor.id} name={sensor.name} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} fill="none" />)}</AreaChart></ResponsiveContainer>}
          </div>
        </Card>

        <div className="grid h-full grid-rows-[auto_1fr] gap-5">
          <Card>
            <h2 className="mb-3 font-bold text-metal-50">Sensor KPI</h2>
            <div className="grid grid-cols-2 gap-3"><Kpi label="Total sensors" value={sensors.length} /><Kpi label="Online" value={onlineCount} /><Kpi label="Incidents" value={incidentCount} tone={incidentCount ? "red" : undefined} /><Kpi label="Offline" value={offlineCount} /></div>
          </Card>

          <Card className="min-h-0">
            <h2 className="font-bold text-metal-50">Status Distribution</h2>
            <div className="mt-4 grid min-h-0 grid-cols-[minmax(130px,0.8fr)_1fr] items-center gap-4">
              <div className="h-40 min-w-0">{distribution.length ? <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={distribution} dataKey="value" nameKey="name" innerRadius={34} outerRadius={56} paddingAngle={2}>{distribution.map(d => <Cell key={d.name} fill={STATUS_COLORS[d.name as keyof typeof STATUS_COLORS]} />)}</Pie><Tooltip contentStyle={{ borderRadius: 12, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} /></PieChart></ResponsiveContainer> : <div className="grid h-full place-items-center text-center text-xs text-metal-500">No status data</div>}</div>
              <div className="space-y-3 text-sm"><InfoRow label="Phase" value={phaseLabel} /><InfoRow label="Target" value={target} /><InfoRow label="Window" value={phaseWindow} /><InfoRow label="Sensor" value={selectedSensor === "all" ? "All Sensors" : sensors.find(s => s.id === selectedSensor)?.name ?? "—"} /></div>
            </div>
            <div className="mt-5 flex flex-wrap gap-3 border-t border-metal-700 pt-4 text-xs text-metal-400">{(["safe", "warning", "violation"] as const).map(key => <span key={key} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[key] }} />{key}</span>)}</div>
            <div className="mt-4 flex flex-wrap gap-2"><select value={selectedGreenhouse} onChange={e => handleGreenhouseChange(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100">{GREENHOUSES.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select><select value={selectedSensor} onChange={e => setSelectedSensor(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100"><option value="all">All Sensors</option>{sensors.map(sensor => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}</select></div>
          </Card>
        </div>
      </div>

      <Card className="mt-5">
        <div className="flex items-center justify-between gap-3"><h2 className="font-bold text-metal-50">Monitoring Log</h2><span className="text-xs text-metal-500">Latest 3 readings</span></div>
        <div className="mt-3 max-h-56 overflow-y-auto overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="sticky top-0 border-b border-metal-700 bg-metal-800 text-metal-400"><tr><th className="p-3">Greenhouse</th><th className="p-3">Sensor</th><th className="p-3">Status</th><th className="p-3">Lux</th><th className="p-3">Phase</th><th className="p-3">Recorded</th></tr></thead><tbody>{selectedReadings.length ? selectedReadings.map(r => <tr key={r.id} className="border-b border-metal-700 last:border-0"><td className="p-3 text-metal-100">{greenhouse.name}</td><td className="p-3 text-metal-400">{sensors.find(s => s.id === r.sensor_id)?.name ?? r.sensor_id}</td><td className="p-3"><Badge tone={r.classification === "violation" ? "red" : r.classification === "warning" ? "amber" : "green"}>{r.classification}</Badge></td><td className="p-3 font-mono text-metal-100">{r.lux.toFixed(2)}</td><td className="p-3 text-metal-400">{r.phase_type}</td><td className="p-3 text-metal-400">{new Date(r.recorded_at).toLocaleString()}</td></tr>) : <tr><td colSpan={6} className="p-8 text-center text-sm text-metal-500">No sensor readings available</td></tr>}</tbody></table></div>
      </Card>
    </div>

    <footer className="border-t border-metal-700 px-5 py-6 md:px-8"><Link href="/" className="inline-flex items-center gap-2 text-sm text-metal-400 hover:text-metal-100"><ArrowLeft size={15} /> Back to home</Link></footer>
  </main>;
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "red" }) {
  return <div className="rounded-xl border border-metal-700 bg-white/[0.02] p-3"><p className="text-xs text-metal-400">{label}</p><p className={`mt-1 font-mono text-xl font-bold ${tone === "red" ? "text-red-400" : "text-metal-50"}`}>{value}</p></div>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-3 border-b border-metal-700 pb-2 last:border-0"><span className="text-metal-500">{label}</span><span className="text-right font-medium text-metal-100">{value}</span></div>;
}