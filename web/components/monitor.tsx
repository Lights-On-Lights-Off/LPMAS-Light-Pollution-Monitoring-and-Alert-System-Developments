"use client";

import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Cell, Legend, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDashboardData } from "@/lib/useDashboardData";
import type { Reading, Greenhouse, MinuteAggregate } from "@/lib/api";
import { getGreenhouses } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { Card, Badge } from "@/components/ui";
import { PublicNavbar } from "@/components/public-navbar";
import { MonitoringStatus } from "@/components/MonitoringStatus";
import { sensorSeries } from "@/lib/chartData";
import { phaseForGreenhouse } from "@/lib/monitoring-state";

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

// The two fixed lux thresholds that separate safe / warning / violation for
// a given phase, drawn as reference lines on the chart. Matches the
// classification rules from the README — not manager-configurable.
function getThresholdLines(phase: string | null): { value: number; color: string; label: string }[] {
  if (phase === "illumination") return [
    { value: 50, color: STATUS_COLORS.safe, label: "Safe ≥ 50" },
    { value: 30, color: STATUS_COLORS.violation, label: "Violation ≤ 30" }
  ];
  if (phase === "dark") return [
    { value: 15, color: STATUS_COLORS.safe, label: "Safe ≤ 15" },
    { value: 30, color: STATUS_COLORS.violation, label: "Violation ≥ 30" }
  ];
  return [];
}

export function Monitor() {
  const { data, greenhouses, sensorHealthById, policy, sources } = useDashboardData();
  const [selectedGreenhouse, setSelectedGreenhouse] = useState("");
  const [selectedSensor, setSelectedSensor] = useState("all");

  useEffect(() => {
    if (!greenhouses.some(g => g.id === selectedGreenhouse)) {
      setSelectedGreenhouse(greenhouses[0]?.id ?? "");
      setSelectedSensor("all");
    }
  },[greenhouses,selectedGreenhouse]);

  const greenhouse = useMemo(() => greenhouses.find(g => g.id === selectedGreenhouse) ?? null, [greenhouses, selectedGreenhouse]);

  const configuredSensorIds = useMemo(() => greenhouse?.sensor_ids ?? [], [greenhouse]);

  const sensorIds = useMemo(() => selectedSensor === "all" ? configuredSensorIds : configuredSensorIds.filter(id => id === selectedSensor), [configuredSensorIds, selectedSensor]);

  const sensors = useMemo(() => sensorIds.map(id => ({ id, name: id })), [sensorIds]);

  const configuredReadings = useMemo(() => {
    if (!greenhouse || !configuredSensorIds.length) return [];
    return data.readings.filter(reading => reading.greenhouse_id === greenhouse.id && configuredSensorIds.includes(reading.sensor_id));
  }, [data.readings, greenhouse, configuredSensorIds]);

  const effectiveReadings = configuredReadings;

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

    // Numeric epoch preserves actual elapsed time. Each plotted sensor has
    // its own timestamps and explicit gaps; asynchronous devices stay distinct.
    const map = new Map<number, Record<string, number>>();

    for (const reading of rows) {
      const raw = new Date(reading.recorded_at).getTime();
      const time = raw;
      const row = map.get(time) ?? { time };
      row[reading.sensor_id] = reading.lux;
      map.set(time, row);
    }

    return Array.from(map.values()).sort((a, b) => a.time - b.time);
  }, [effectiveReadings, sensorIds, greenhouse]);

  const distribution = useMemo(() => {
    const counts = { safe: 0, warning: 0, violation: 0 };

    for (const reading of latest.values()) {
      if (reading.classification !== "unclassified") counts[reading.classification]++;
    }

    return Object.entries(counts).filter(([, value]) => value > 0).map(([name, value]) => ({ name, value }));
  }, [latest]);

  const onlineCount = configuredSensorIds.filter(id => sensorHealthById[id] === "Online").length;

  const totalSensors = greenhouse ? configuredSensorIds.length : 0;
  const offlineCount = configuredSensorIds.filter(id => sensorHealthById[id] === "Offline").length;

  const incidentCount = useMemo(() => {
    if (!greenhouse) return 0;

    return data.incidents.filter(incident => incident.status !== "resolved" && incident.greenhouse_id === greenhouse.id).length;
  }, [data.incidents, configuredSensorIds, greenhouse]);

  const selectedReadings = useMemo(() => {
    if (!greenhouse || !sensorIds.length) return [];

    return effectiveReadings
      .filter(reading => sensorIds.includes(reading.sensor_id))
      .sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime())
      .slice(0, 3);
  }, [effectiveReadings, sensorIds, greenhouse]);

  const phase = phaseForGreenhouse(greenhouse ?? undefined,policy.dark_phase_days);
  const phaseLabel = phase === "illumination" ? "Illumination" : phase === "dark" ? "Dark" : phase ?? "—";
  const phaseWindow = greenhouse ? `${greenhouse.phase_start} - ${greenhouse.phase_end}` : "—";
  const target = phase === "illumination" ? "≥ 50 safe · > 30 and < 50 warning · ≤ 30 violation" : phase === "dark" ? "0–15 safe · > 15 to 29 warning · > 29 violation" : "—";

  const thresholdLines = useMemo(() => getThresholdLines(phase), [phase]);

  // Explicit, evenly-spaced tick positions instead of Recharts' automatic
  // ticks, which crowd the axis with near-duplicate timestamps when
  // readings land seconds apart (see the previous chart).
  const xTicks = useMemo(() => {
    if (chart.length < 2) return chart.map(row => row.time);
    const first = chart[0].time;
    const last = chart[chart.length - 1].time;
    const count = Math.min(6, chart.length);
    const step = (last - first) / (count - 1);
    return Array.from({ length: count }, (_, i) => Math.round(first + step * i));
  }, [chart]);

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
      <MonitoringStatus />
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
              <select value={selectedGreenhouse} onChange={e => handleGreenhouseChange(e.target.value)} aria-label="Select greenhouse" className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100">
                {greenhouses.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>

              <select aria-label="Select sensor" value={selectedSensor} onChange={e => handleSensorChange(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100">
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
              <AreaChart data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  {sensors.map((sensor, i) => <linearGradient key={sensor.id} id={`lux-fill-${sensor.id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0.35} />
                    <stop offset="95%" stopColor={LINE_COLORS[i % LINE_COLORS.length]} stopOpacity={0.03} />
                  </linearGradient>)}
                </defs>

                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--surface-border)" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  scale="time"
                  ticks={xTicks}
                  tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                  tickFormatter={value => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                  width={40}
                  domain={[0, (dataMax: number) => Math.max(dataMax, ...thresholdLines.map(line => line.value)) + 20]}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{ borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--surface-border)", color: "var(--text-primary)" }}
                  labelFormatter={value => new Date(value as number).toLocaleTimeString()}
                  formatter={(value: number, name: string) => [`${value.toFixed(1)} lux`, name]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />

                {thresholdLines.map(line => <ReferenceLine
                  key={line.label}
                  y={line.value}
                  stroke={line.color}
                  strokeDasharray="4 4"
                  strokeOpacity={0.7}
                  label={{ value: line.label, position: "insideTopRight", fontSize: 10, fill: line.color }}
                />)}
                {sensors.map((sensor, i) => <Area
                  key={sensor.id}
                  type="linear"
                  data={sensorSeries(chart,sensor.id,sources[sensor.id] === "minute" ? 90_000 : 15_000)}
                  isAnimationActive={false}
                  dataKey={sensor.id}
                  name={`${sensor.name} (${sources[sensor.id] === "minute" ? "minute avg" : "raw"})`}
                  stroke={LINE_COLORS[i % LINE_COLORS.length]}
                  strokeWidth={2}
                  fill={`url(#lux-fill-${sensor.id})`}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                />)}
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

            <div className="mt-4 grid min-h-0 grid-cols-1 items-center gap-4 sm:grid-cols-[minmax(130px,0.8fr)_1fr]">
              <div className="h-40 min-w-0">
                {distribution.length ? <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={distribution} dataKey="value" nameKey="name" innerRadius={34} outerRadius={56} paddingAngle={2}>
                      {distribution.map(d => <Cell key={d.name} fill={STATUS_COLORS[d.name as keyof typeof STATUS_COLORS]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--surface-border)", color: "var(--text-primary)" }} />
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

              <select aria-label="Select sensor" value={selectedSensor} onChange={e => handleSensorChange(e.target.value)} className="rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-100">
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