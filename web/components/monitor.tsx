"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Area, AreaChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDashboardData } from "@/lib/useDashboardData";
import { statusDistribution, latestBySensor, STATUS_COLORS } from "@/lib/chartData";
import { GREENHOUSE_BY_SENSOR } from "@/lib/mockData";
import { Card, Badge } from "@/components/ui";

const SENSOR_IDS = ["sensor1", "sensor2"];
const LINE_COLORS = ["#d9a441", "#7fb3d5"];

export function Monitor() {
  const { data } = useDashboardData();
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    setMounted(true);
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  const latest = useMemo(() => latestBySensor(data.readings), [data.readings]);
  const distribution = useMemo(() => statusDistribution(data.readings), [data.readings]);

  const sensorDistribution = useMemo(() => {
    if (!mounted) return [
      { name: "Online", value: 0, color: "#3fae64" },
      { name: "Offline", value: SENSOR_IDS.length, color: "#6f7278" }
    ];

    let online = 0;
    for (const r of latest.values()) if (now - new Date(r.recorded_at).getTime() < 60_000) online++;

    return [
      { name: "Online", value: online, color: "#3fae64" },
      { name: "Offline", value: SENSOR_IDS.length - online, color: "#6f7278" }
    ];
  }, [latest, mounted, now]);

const liveChart = useMemo(() => {
  const merged = new Map<string, any>();

  data.readings.forEach((reading) => {
    const timestamp = new Date(reading.recorded_at).getTime();
    const key = new Date(reading.recorded_at).toISOString().slice(0, 19);

    const point = merged.get(key) ?? { timestamp };

    point[GREENHOUSE_BY_SENSOR[reading.sensor_id] ?? reading.sensor_id] = reading.lux;
    merged.set(key, point);
  });

  return Array.from(merged.values()).sort((a, b) => a.timestamp - b.timestamp).slice(-20);
}, [data.readings]);

  const onlineCount = sensorDistribution[0].value;
  const openIncidents = data.incidents.filter(i => i.status !== "resolved").length;

  return <main className="min-h-screen bg-ink font-sans text-metal-100 antialiased">

    <header className="sticky top-0 z-30 border-b border-metal-700 bg-ink/80 backdrop-blur-xl">
      <nav className="mx-auto flex min-h-[72px] max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-3">

        <Link href="/" className="flex items-center gap-3">
          <span className="h-3 w-3 rounded-full bg-leaf-500 shadow-glow" />
          <div>
            <h1 className="text-lg font-bold tracking-tight text-metal-50">LPMAS Live Monitor</h1>
            <p className="text-xs text-metal-400">Light Pollution Monitoring & Alert System</p>
          </div>
        </Link>

        <div className="flex flex-wrap items-center justify-end gap-5 text-sm text-metal-300">
          <Link href="/about#features" className="transition hover:text-metal-50">Features</Link>
          <Link href="/about#how-it-works" className="transition hover:text-metal-50">How it works</Link>
          <Link href="/about" className="transition hover:text-metal-50">About</Link>
          <Link href="/" className="font-semibold text-metal-50">Live monitor</Link>
          <Link href="/login" className="rounded-full bg-leaf-500 px-5 py-2 font-semibold text-ink transition hover:bg-leaf-100">Sign In</Link>
        </div>

      </nav>
    </header>

    <div className="mx-auto max-w-[1800px] space-y-5 p-4 md:p-6">

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(340px,.85fr)]">

        <Card className="h-[440px]">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-metal-50">Light Intensity</h2>
                <span className="rounded-full bg-leaf-500/10 px-2 py-0.5 text-[10px] font-semibold text-leaf-500">LIVE</span>
              </div>
              <p className="mt-1 text-xs text-metal-400">Live BH1750 telemetry · latest 60 readings</p>
            </div>

            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wide text-metal-500">Refresh</p>
              <p className="font-mono text-xs text-metal-300">1s</p>
            </div>
          </div>

          <div className="h-[355px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={liveChart}>
                <defs>
                  {Object.values(GREENHOUSE_BY_SENSOR).map((label, i) => <linearGradient key={label} id={`g-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0} />
                  </linearGradient>)}
                </defs>

                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#232427" />
                <XAxis dataKey="time" tick={{ fontSize: 10, fill: "#6f7278" }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: "#6f7278" }} width={35} />
                <Tooltip contentStyle={{ borderRadius: 10, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />

                {Object.values(GREENHOUSE_BY_SENSOR).map((label, i) => <Area key={label} type="monotone" dataKey={label} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} fill={`url(#g-${i})`} dot={false} isAnimationActive={false} connectNulls />)}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <div className="space-y-5">

          <Card className="h-[135px] p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-bold text-metal-50">Sensor KPIs</h2>
              <span className="text-[10px] uppercase tracking-wide text-metal-500">Live</span>
            </div>

            <div className="grid grid-cols-4 gap-2">
              <Kpi label="Sensors" value={SENSOR_IDS.length} />
              <Kpi label="Online" value={onlineCount} />
              <Kpi label="Offline" value={SENSOR_IDS.length - onlineCount} />
              <Kpi label="Incidents" value={openIncidents} tone={openIncidents ? "red" : undefined} />
            </div>
          </Card>

          <Card className="h-[280px]">
            <h2 className="text-sm font-bold text-metal-50">Network distribution</h2>
            <p className="mt-1 text-xs text-metal-400">Current status and sensor availability</p>

            <div className="grid h-[215px] grid-cols-2 gap-2">
              <DistributionPanel title="Status" data={distribution.map(d => ({ name: d.name, value: d.value, color: STATUS_COLORS[d.key] }))} />
              <DistributionPanel title="Sensors" data={sensorDistribution} />
            </div>
          </Card>

        </div>
      </div>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="font-bold text-metal-50">Monitoring log</h2>
            <p className="mt-1 text-xs text-metal-400">Latest sensor readings</p>
          </div>
          <span className="text-[10px] uppercase tracking-wide text-metal-500">Live</span>
        </div>

        <div className="max-h-[156px] overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 border-b border-metal-700 bg-metal-800 text-metal-400">
              <tr><th className="p-3">Greenhouse</th><th className="p-3">Status</th><th className="p-3">Lux</th><th className="p-3">Recorded</th></tr>
            </thead>

            <tbody>
              {data.readings.map(r => <tr key={r.id} className="border-b border-metal-700 last:border-0">
                <td className="p-3 text-metal-100">{GREENHOUSE_BY_SENSOR[r.sensor_id] ?? r.sensor_id}</td>
                <td className="p-3"><Badge tone={r.classification === "violation" ? "red" : r.classification === "warning" ? "amber" : "green"}>{r.classification}</Badge></td>
                <td className="p-3 font-mono text-metal-100">{r.lux.toFixed(2)}</td>
                <td className="p-3 text-metal-400">{new Date(r.recorded_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </Card>

    </div>
  </main>;
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "red" }) {
  return <div className="rounded-lg border border-metal-700 bg-white/[0.02] px-2 py-2">
    <p className="text-[9px] uppercase tracking-wide text-metal-500">{label}</p>
    <p className={`mt-0.5 font-mono text-lg font-bold ${tone === "red" ? "text-red-400" : "text-metal-50"}`}>{value}</p>
  </div>;
}

function DistributionPanel({ title, data }: { title: string; data: { name: string; value: number; color: string }[] }) {
  return <div className="flex min-w-0 flex-col rounded-xl border border-metal-700 bg-white/[0.015] p-2">
    <h3 className="px-1 text-[11px] font-semibold text-metal-300">{title}</h3>

    <div className="min-h-0 flex-1">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="52%" outerRadius="72%" paddingAngle={2}>
            {data.map(item => <Cell key={item.name} fill={item.color} />)}
          </Pie>
          <Tooltip contentStyle={{ borderRadius: 10, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} />
        </PieChart>
      </ResponsiveContainer>
    </div>

    <div className="flex flex-wrap justify-center gap-x-2 gap-y-1 pb-1">
      {data.map(item => <span key={item.name} className="flex items-center gap-1 text-[9px] text-metal-400"><span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />{item.name}</span>)}
    </div>
  </div>;
}