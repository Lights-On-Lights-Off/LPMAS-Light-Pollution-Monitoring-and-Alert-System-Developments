"use client";

import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDashboardData } from "@/lib/useDashboardData";
import type { Reading, Greenhouse, MinuteAggregate } from "@/lib/api";
import { getGreenhouses } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { Card, Badge } from "@/components/ui";
import { PublicNavbar } from "@/components/public-navbar";

type GreenhouseConfig = {
  id: string;
  name: string;
  sensorIds: string[];
  phaseStart: string;
  phaseEnd: string;
};

const CONFIG_KEY = "lpmas-greenhouse-config";
const LINE_COLORS = ["#d9a441", "#7fb3d5", "#e5484d", "#7bd389", "#b18cff"];
const STATUS_COLORS = { safe: "#7fbf7f", warning: "#d9a441", violation: "#e5484d" } as const;
const ONLINE_WINDOW = 60_000;

export function Monitor() {
  const { data } = useDashboardData();
  const [greenhouses, setGreenhouses] = useState<(GreenhouseConfig | Greenhouse)[]>([]);
  const [selectedGreenhouse, setSelectedGreenhouse] = useState("");
  const [selectedSensor, setSelectedSensor] = useState("all");

  useEffect(() => {
    async function loadConfiguration() {
      try {
        const remote = await getGreenhouses();
        const configs = remote as Greenhouse[];
        setGreenhouses(configs as any);
        if (configs.length && !configs.some(g => g.id === selectedGreenhouse)) setSelectedGreenhouse(configs[0].id);
        if (!configs.length) { setSelectedGreenhouse(""); setSelectedSensor("all"); }
        localStorage.setItem(CONFIG_KEY, JSON.stringify(configs.map(g => ({ id: g.id, name: g.name, sensorIds: g.sensor_ids, phaseStart: g.phase_start, phaseEnd: g.phase_end, windowStart: g.window_start, windowEnd: g.window_end }))));
      } catch {
        try { const stored = localStorage.getItem(CONFIG_KEY); const parsed = stored ? JSON.parse(stored) : []; const configs = Array.isArray(parsed) ? parsed : []; setGreenhouses(configs); if (configs.length && !configs.some(g => g.id === selectedGreenhouse)) setSelectedGreenhouse(configs[0].id); } catch { setGreenhouses([]); setSelectedGreenhouse(""); setSelectedSensor("all"); }
      }
    }
    loadConfiguration();

    const handleStorage = () => loadConfiguration();
    window.addEventListener("storage", handleStorage);

    const interval = setInterval(loadConfiguration, 1000);

    return () => {
      window.removeEventListener("storage", handleStorage);
      clearInterval(interval);
    };
  }, [selectedGreenhouse]);

  const greenhouse = useMemo(() => greenhouses.find(g => g.id === selectedGreenhouse) ?? null, [greenhouses, selectedGreenhouse]);

  const configuredSensorIds = useMemo(() => greenhouse ? ("sensor_ids" in greenhouse ? greenhouse.sensor_ids : greenhouse.sensorIds) : [], [greenhouse]);

  const sensorIds = useMemo(() => selectedSensor === "all" ? configuredSensorIds : configuredSensorIds.filter(id => id === selectedSensor), [configuredSensorIds, selectedSensor]);

  const sensors = useMemo(() => sensorIds.map(id => ({ id, name: id })), [sensorIds]);

  const configuredReadings = useMemo(() => {
    if (!greenhouse || !configuredSensorIds.length) return [];
    return data.readings.filter(reading => configuredSensorIds.includes(reading.sensor_id));
  }, [data.readings, greenhouse, configuredSensorIds]);

  // Fallback source so the dashboard is never blank: when the Pi is
  // unreachable (or has sent nothing yet), fall back to the most recent
  // 1-minute Supabase aggregates for this greenhouse instead of showing
  // empty charts/tables.
  const [fallbackAggregates, setFallbackAggregates] = useState<MinuteAggregate[]>([]);

  useEffect(() => {
    let active = true;
    async function loadFallback() {
      if (!supabase || !greenhouse || !configuredSensorIds.length) {
        setFallbackAggregates([]);
        return;
      }
      const { data: rows, error } = await supabase
        .from("sensor_minute_aggregates")
        .select("id, sensor_id, greenhouse_id, bucket_start, phase_type, sample_count, avg_lux, min_lux, max_lux, safe_count, warning_count, violation_count, updated_at")
        .eq("greenhouse_id", greenhouse.id)
        .order("bucket_start", { ascending: false })
        .limit(60);
      if (!active) return;
      setFallbackAggregates(error ? [] : ((rows ?? []) as MinuteAggregate[]));
    }
    loadFallback();
    const interval = setInterval(loadFallback, 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [greenhouse, configuredSensorIds]);

  function classificationFromAggregate(row: MinuteAggregate): Reading["classification"] {
    if (row.violation_count > 0) return "violation";
    if (row.warning_count > 0) return "warning";
    return "safe";
  }

  // Live Pi readings win when present; otherwise the chart/table/KPIs below
  // fall back to the recent Supabase aggregates so nothing renders blank.
  const effectiveReadings = useMemo(() => {
    if (configuredReadings.length) return configuredReadings;
    return fallbackAggregates
      .filter(row => configuredSensorIds.includes(row.sensor_id))
      .map(row => ({
        id: row.id,
        sensor_id: row.sensor_id,
        greenhouse_id: row.greenhouse_id,
        lux: row.avg_lux,
        recorded_at: row.bucket_start,
        classification: classificationFromAggregate(row),
        phase_type: row.phase_type
      }));
  }, [configuredReadings, fallbackAggregates, configuredSensorIds]);

  const latest = useMemo(() => {
    const map = new Map<string, Reading>();

    for (const reading of effectiveReadings) {
      if (!sensorIds.includes(reading.sensor_id)) continue;

      const current = map.get(reading.sensor_id);

      if (!current || new Date(reading.recorded_at).getTime() > new Date(current.recorded_at).getTime()) {
        map.set(reading.sensor_id, reading);
      }
    }

    return map;
  }, [effectiveReadings, sensorIds]);

  const chart = useMemo(() => {
    if (!greenhouse || !sensorIds.length) return [];

    const rows = effectiveReadings
      .filter(reading => sensorIds.includes(reading.sensor_id))
      .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime())
      .slice(-30);

    // Keyed by numeric epoch (rounded to the nearest 5s so near-simultaneous
    // readings from different sensors share a point) rather than a formatted
    // string, so points space proportionally to real elapsed time instead of
    // evenly by array index — a long gap between readings now shows as a
    // long gap on the axis instead of being compressed to the same width as
    // a 10-second gap.
    const map = new Map<number, Record<string, number>>();

    for (const reading of rows) {
      const raw = new Date(reading.recorded_at).getTime();
      const time = Math.round(raw / 5000) * 5000;
      const row = map.get(time) ?? { time };
      row[reading.sensor_id] = reading.lux;
      map.set(time, row);
    }

    return Array.from(map.values()).sort((a, b) => a.time - b.time);
  }, [effectiveReadings, sensorIds, greenhouse]);

  const distribution = useMemo(() => {
    const counts = { safe: 0, warning: 0, violation: 0 };

    for (const reading of latest.values()) {
      counts[reading.classification]++;
    }

    return Object.entries(counts).filter(([, value]) => value > 0).map(([name, value]) => ({ name, value }));
  }, [latest]);

  const onlineCount = useMemo(() => {
    if (!greenhouse) return 0;

    return Array.from(latest.values()).filter(reading => Date.now() - new Date(reading.recorded_at).getTime() < ONLINE_WINDOW).length;
  }, [latest, greenhouse]);

  const totalSensors = greenhouse ? configuredSensorIds.length : 0;
  const offlineCount = Math.max(0, totalSensors - onlineCount);

  const incidentCount = useMemo(() => {
    if (!greenhouse) return 0;

    return data.incidents.filter(incident => incident.status !== "resolved" && configuredSensorIds.includes(incident.sensor_id)).length;
  }, [data.incidents, configuredSensorIds, greenhouse]);

  const selectedReadings = useMemo(() => {
    if (!greenhouse || !sensorIds.length) return [];

    return effectiveReadings
      .filter(reading => sensorIds.includes(reading.sensor_id))
      .sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime())
      .slice(0, 3);
  }, [effectiveReadings, sensorIds, greenhouse]);

  const phase = latest.values().next().value?.phase_type ?? data.phase?.phase_type ?? null;
  const phaseLabel = phase === "illumination" ? "Illumination" : phase === "dark" ? "Dark" : phase ?? "—";
  const phaseWindow = greenhouse ? (("phase_start" in greenhouse ? greenhouse.phase_start : greenhouse.phaseStart) && ("phase_end" in greenhouse ? greenhouse.phase_end : greenhouse.phaseEnd) ? `${"phase_start" in greenhouse ? greenhouse.phase_start : greenhouse.phaseStart} - ${"phase_end" in greenhouse ? greenhouse.phase_end : greenhouse.phaseEnd}` : "—") : "—";
  const target = phase === "illumination" ? "≥ 50 safe · 31–49 warning · ≤ 30 violation" : phase === "dark" ? "0–15 safe · 16–29 warning · ≥ 30 incident" : "—";

  // Timestamp of the newest reading actually being displayed, whether it came
  // from the live Pi feed or the Supabase aggregate fallback.
  const asOf = useMemo(() => {
    if (!effectiveReadings.length) return null;
    return effectiveReadings.reduce((newest, reading) => {
      const time = new Date(reading.recorded_at).getTime();
      return time > newest ? time : newest;
    }, 0);
  }, [effectiveReadings]);

  const handleGreenhouseChange = (value: string) => {
    setSelectedGreenhouse(value);
    setSelectedSensor("all");
  };

  const handleSensorChange = (value: string) => {
    setSelectedSensor(value);
  };

  return <main className="min-h-screen bg-ink font-sans text-metal-100">
    <PublicNavbar />

    <div className="p-5 md:p-8">
      <div className="grid items-stretch gap-5 xl:grid-cols-[1.7fr_1fr]">
        <Card className="h-full min-h-[34rem]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="font-bold text-metal-50">Lux Intensity Trend</h2>
                {asOf && <span className="text-xs text-metal-500">as of {new Date(asOf).toLocaleString()}</span>}
              </div>
              <p className="mt-1 text-sm text-metal-400">{greenhouse ? `Real sensor readings from ${greenhouse.name}` : "System configuration required before monitoring begins"}</p>
            </div>

            {greenhouses.length > 0 && <div className="flex flex-wrap items-center gap-2">
              <select value={selectedGreenhouse} onChange={e => handleGreenhouseChange(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100">
                {greenhouses.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>

              <select value={selectedSensor} onChange={e => handleSensorChange(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100">
                <option value="all">All Sensors</option>
                {sensors.map(sensor => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}
              </select>
            </div>}
          </div>

          <div className="relative mt-6 h-[26rem]">
            {!greenhouse ? <div className="grid h-full place-items-center text-center">
              <div>
                <p className="text-sm text-metal-400">System not configured</p>
                <p className="mt-1 text-xs text-metal-500">Ask a manager to configure a greenhouse and sensors first.</p>
              </div>
            </div> : !chart.length ? <div className="grid h-full place-items-center text-center">
              <span className="text-sm text-metal-400">No readings recorded yet for this greenhouse</span>
            </div> : <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#232427" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  scale="time"
                  tick={{ fontSize: 11, fill: "#6f7278" }}
                  tickFormatter={value => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  interval="preserveStartEnd"
                />
                <YAxis tick={{ fontSize: 11, fill: "#6f7278" }} width={40} />
                <Tooltip
                  contentStyle={{ borderRadius: 12, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }}
                  labelFormatter={value => new Date(value as number).toLocaleTimeString()}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {sensors.map((sensor, i) => <Area key={sensor.id} type="monotone" dataKey={sensor.id} name={sensor.name} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} fill="none" />)}
              </AreaChart>
            </ResponsiveContainer>}
          </div>
        </Card>

        <div className="grid h-full grid-rows-[auto_1fr] gap-5">
          <Card>
            <h2 className="mb-3 font-bold text-metal-50">Sensor KPI</h2>

            <div className="grid grid-cols-2 gap-3">
              <Kpi label="Total sensors" value={totalSensors} />
              <Kpi label="Online" value={onlineCount} />
              <Kpi label="Incidents" value={incidentCount} tone={incidentCount ? "red" : undefined} />
              <Kpi label="Offline" value={offlineCount} />
            </div>
          </Card>

          <Card className="min-h-0">
            <h2 className="font-bold text-metal-50">Status Distribution</h2>

            <div className="mt-4 grid min-h-0 grid-cols-[minmax(130px,0.8fr)_1fr] items-center gap-4">
              <div className="h-40 min-w-0">
                {distribution.length ? <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={distribution} dataKey="value" nameKey="name" innerRadius={34} outerRadius={56} paddingAngle={2}>
                      {distribution.map(d => <Cell key={d.name} fill={STATUS_COLORS[d.name as keyof typeof STATUS_COLORS]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ borderRadius: 12, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} />
                  </PieChart>
                </ResponsiveContainer> : <div className="grid h-full place-items-center text-center text-xs text-metal-500">No status data</div>}
              </div>

              <div className="space-y-3 text-sm">
                <InfoRow label="Phase" value={greenhouse ? phaseLabel : "—"} />
                <InfoRow label="Target" value={greenhouse ? target : "—"} />
                <InfoRow label="Window" value={greenhouse ? phaseWindow : "—"} />
                <InfoRow label="Sensor" value={!greenhouse ? "—" : selectedSensor === "all" ? "All Sensors" : selectedSensor} />
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-3 border-t border-metal-700 pt-4 text-xs text-metal-400">
              {(["safe", "warning", "violation"] as const).map(key => <span key={key} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[key] }} />
                {key}
              </span>)}
            </div>

            {greenhouses.length > 0 && <div className="mt-4 flex flex-wrap items-center gap-2">
              <select value={selectedGreenhouse} onChange={e => handleGreenhouseChange(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100">
                {greenhouses.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>

              <select value={selectedSensor} onChange={e => handleSensorChange(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100">
                <option value="all">All Sensors</option>
                {sensors.map(sensor => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}
              </select>
            </div>}
          </Card>
        </div>
      </div>

      <Card className="mt-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-bold text-metal-50">Monitoring Log</h2>
          <span className="text-xs text-metal-500">Latest 3 readings</span>
        </div>

        <div className="mt-3 max-h-56 overflow-y-auto overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="sticky top-0 border-b border-metal-700 bg-metal-800 text-metal-400">
              <tr><th className="p-3">Greenhouse</th><th className="p-3">Sensor</th><th className="p-3">Status</th><th className="p-3">Lux</th><th className="p-3">Phase</th><th className="p-3">Recorded</th></tr>
            </thead>

            <tbody>
              {selectedReadings.length ? selectedReadings.map(reading => <tr key={reading.id} className="border-b border-metal-700 last:border-0">
                <td className="p-3 text-metal-100">{greenhouse?.name ?? "—"}</td>
                <td className="p-3 text-metal-400">{reading.sensor_id}</td>
                <td className="p-3"><Badge tone={reading.classification === "violation" ? "red" : reading.classification === "warning" ? "amber" : "green"}>{reading.classification}</Badge></td>
                <td className="p-3 font-mono text-metal-100">{reading.lux.toFixed(2)}</td>
                <td className="p-3 text-metal-400">{reading.phase_type}</td>
                <td className="p-3 text-metal-400">{new Date(reading.recorded_at).toLocaleString()}</td>
              </tr>) : <tr>
                <td colSpan={6} className="p-8 text-center text-sm text-metal-500">
                  {!greenhouse ? "Configure a greenhouse before monitoring begins" : "No readings recorded yet"}
                </td>
              </tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  </main>;
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "red" }) {
  return <div className="rounded-xl border border-metal-700 bg-white/[0.02] p-3">
    <p className="text-xs text-metal-400">{label}</p>
    <p className={`mt-1 font-mono text-xl font-bold ${tone === "red" ? "text-red-400" : "text-metal-50"}`}>{value}</p>
  </div>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-3 border-b border-metal-700 pb-2 last:border-0">
    <span className="text-metal-500">{label}</span>
    <span className="text-right font-medium text-metal-100">{value}</span>
  </div>;
}