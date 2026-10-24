"use client";

import { useEffect, useMemo, useState } from "react";
import { Line, LineChart, CartesianGrid, Cell, Legend, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDashboardData } from "@/lib/useDashboardData";
import type { Reading } from "@/lib/api";
import { Card, Badge } from "@/components/ui";
import { PublicNavbar } from "@/components/public-navbar";
import { MonitoringStatus } from "@/components/MonitoringStatus";
import { phaseForGreenhouse } from "@/lib/monitoring-state";

const LINE_COLORS = ["var(--accent)", "var(--warning)", "var(--success)", "var(--danger)", "var(--text-secondary)"];
const STATUS_COLORS = { safe: "var(--success)", warning: "var(--warning)", violation: "var(--danger)", unclassified: "var(--warning)" } as const;

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
  const { data, greenhouses, sensorHealthById, policy } = useDashboardData();
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

    // One point per minute; fresh samples update the running average.
    // Sensors keep their own minute buckets when samples arrive asynchronously.
    const map = new Map<number, Record<string, number>>();

    for (const reading of rows) {
      const time = Math.floor(Date.parse(reading.recorded_at) / 60_000) * 60_000;
      const row = map.get(time) ?? { time };
      row[reading.sensor_id] = reading.lux;
      map.set(time, row);
    }

    return Array.from(map.values()).sort((a, b) => a.time - b.time);
  }, [effectiveReadings, sensorIds, greenhouse]);

  const distribution = useMemo(() => {
    const counts = { safe: 0, warning: 0, violation: 0, unclassified: 0 };

    for (const reading of latest.values()) {
      counts[reading.classification]++;
    }

    return Object.entries(counts).filter(([, value]) => value > 0).map(([name, value]) => ({ name, value, label: name === "unclassified" ? "Outside configured phase" : name }));
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
    const count = Math.min(4, chart.length);
    const step = (last - first) / (count - 1);
    return Array.from({ length: count }, (_, i) => Math.round(first + step * i));
  }, [chart]);

  // Measurement timestamp behind the newest displayed minute average.
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
    <a href="#monitor-content" className="skip-link">Skip to monitoring data</a>
    <PublicNavbar />

    <div id="monitor-content" tabIndex={-1} className="page-container public-monitor">
      <header className="mb-3 grid items-end gap-3 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-theme-muted">Greenhouse monitoring</p>
          <h1 className="text-2xl font-bold text-theme-text">Light at a glance</h1>
          <p className="mt-1 max-w-2xl text-xs sm:text-sm text-theme-muted">Track light intensity, sensor health, and incidents across your greenhouses.</p>
        </div>
        <div className="min-w-0">{greenhouses.length > 0 && <div className="grid w-full min-w-0 grid-cols-2 gap-3">
              <label className="min-w-0 text-xs font-medium text-theme-muted">Greenhouse<select value={selectedGreenhouse} onChange={e => handleGreenhouseChange(e.target.value)} aria-label="Select greenhouse" className="mt-1 block w-full min-w-0 rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-50">
                {greenhouses.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select></label>

              <label className="min-w-0 text-xs font-medium text-theme-muted">Sensor<select aria-label="Select sensor" value={selectedSensor} onChange={e => handleSensorChange(e.target.value)} className="mt-1 block w-full min-w-0 rounded-lg border border-metal-700 bg-metal-800 px-3 py-2 text-sm text-metal-50">
                <option value="all">All Sensors</option>
                {configuredSensorIds.map(id => <option key={id} value={id}>{id}</option>)}
              </select></label>
            </div>}</div>
      </header>
      <div className="mb-3"><MonitoringStatus compact /></div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="font-bold text-metal-50">Minute-average lux history</h2>
                {asOf && <span className="text-xs text-metal-500">as of {new Date(asOf).toLocaleString()}</span>}
              </div>
            </div>
          </div>

          <div className="chart-frame relative mt-3">
            {!greenhouse ? <div className="grid h-full place-items-center text-center">
              <div>
                <p className="text-sm text-metal-400">System not configured</p>
                <p className="mt-1 text-xs text-metal-500">Ask a manager to configure a greenhouse and sensors first.</p>
              </div>
            </div> : !chart.length ? <div className="grid h-full place-items-center text-center">
              <span className="text-sm text-metal-400">No readings recorded yet for this greenhouse</span>
            </div> : <ResponsiveContainer width="100%" height="100%">
              <LineChart accessibilityLayer data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--surface-border)" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  scale="time"
                  ticks={xTicks}
                  minTickGap={32}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={10}
                  tick={{ fontSize: 12, fill: "var(--text-muted)" }}
                  tickFormatter={value => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                />
                <YAxis
                  tick={{ fontSize: 12, fill: "var(--text-muted)" }}
                  width={44}
                  tickFormatter={value => Number(value).toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })}
                  tickLine={false}
                  axisLine={false}
                  domain={[0, (dataMax: number) => Math.max(dataMax, ...thresholdLines.map(line => line.value)) + 20]}
                  allowDecimals={false}
                />
                <Tooltip position={{ x: 12, y: 8 }}
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
                  label={{ value: line.label, position: "insideTopRight", fontSize: 12, fill: line.color }}
                />)}
                {sensors.map((sensor, i) => <Line
                  key={sensor.id}
                  type="linear"
                  isAnimationActive={false}
                  dataKey={sensor.id}
                  name={sensor.name}
                  stroke={LINE_COLORS[i % LINE_COLORS.length]}
                  strokeWidth={2.5}
                  strokeDasharray={[undefined, "8 4", "2 4", "10 3 2 3", "6 3"][i % 5]}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  connectNulls
                />)}
              </LineChart>
            </ResponsiveContainer>}
          </div>
          <p className="mt-3 text-xs text-metal-400">{greenhouse ? `One point per minute from ${greenhouse.name}. The current minute updates as readings arrive.` : "System configuration required before monitoring begins"}</p>
          <p className="mt-3 text-xs text-theme-muted">Intensity in lux · one-minute averages · dashed reference lines show phase thresholds.</p>
        </Card>

        <div className="grid content-start gap-4">
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

            <div className="mt-3 grid min-h-0 grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(100px,0.65fr)_1fr]">
              <div className="h-32 min-w-0">
                {distribution.length ? <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie isAnimationActive={false} data={distribution} dataKey="value" nameKey="label" innerRadius={34} outerRadius={56} paddingAngle={2}>
                      {distribution.map(d => <Cell key={d.name} fill={STATUS_COLORS[d.name as keyof typeof STATUS_COLORS]} />)}
                    </Pie>
                    <Tooltip position={{ x: 12, y: 8 }} contentStyle={{ borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--surface-border)", color: "var(--text-primary)" }} />
                  </PieChart>
                </ResponsiveContainer> : <div className="grid h-full place-items-center text-center text-xs text-metal-500">No phase status available</div>}
              </div>

              <div className="space-y-2 text-sm">
                <p className="text-xs text-metal-500">Status uses minute average lux for the recorded phase. Alerts follow the configured monitoring window.</p>
                <InfoRow label="Phase" value={greenhouse ? phaseLabel : "—"} />
                <InfoRow label="Target" value={greenhouse ? target : "—"} />
                <InfoRow label="Window" value={greenhouse ? phaseWindow : "—"} />
                <InfoRow label="Sensor" value={!greenhouse ? "—" : selectedSensor === "all" ? "All Sensors" : selectedSensor} />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2 border-t border-metal-700 pt-3 text-xs text-metal-400">
              {(["safe", "warning", "violation", "unclassified"] as const).map(key => <span key={key} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[key] }} />
                {key === "unclassified" ? "Outside configured phase" : key} · {distribution.find(d => d.name === key)?.value ?? 0}
              </span>)}
            </div>
          </Card>
        </div>
      </div>

      <Card className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-bold text-metal-50">Minute-average log</h2>
          <span className="text-xs text-metal-500">Latest 3 minute averages</span>
        </div>

        <div className="mt-3 hidden max-h-64 overflow-auto md:block">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="sticky top-0 border-b border-metal-700 bg-metal-800 text-metal-400">
              <tr><th className="p-3">Greenhouse</th><th className="p-3">Sensor</th><th className="p-3">Status</th><th className="p-3">Average lux</th><th className="p-3">Phase</th><th className="p-3">Recorded</th></tr>
            </thead>

            <tbody>
              {selectedReadings.length ? selectedReadings.map(reading => <tr key={reading.id} className="border-b border-metal-700 last:border-0">
                <td className="p-3 text-metal-100">{greenhouse?.name ?? "—"}</td>
                <td className="p-3 text-metal-400">{reading.sensor_id}</td>
                <td className="p-3"><Badge tone={reading.classification === "unclassified" ? "amber" : reading.classification === "violation" ? "red" : reading.classification === "warning" ? "amber" : "green"}>{reading.classification === "unclassified" ? "Outside configured phase" : reading.classification}</Badge></td>
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
        <div className="mt-4 space-y-3 md:hidden">
          {selectedReadings.length ? selectedReadings.map(reading => <article key={reading.id} className="rounded-xl border border-theme-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="break-all text-sm font-semibold text-theme-text">{reading.sensor_id}</h3>
              <Badge tone={reading.classification === "violation" ? "red" : reading.classification === "warning" ? "amber" : reading.classification === "unclassified" ? "amber" : "green"}>{reading.classification === "unclassified" ? "Outside configured phase" : reading.classification}</Badge>
            </div>
            <p className="mt-3 font-mono text-2xl text-theme-text">{reading.lux.toFixed(2)} <span className="text-sm text-theme-muted">lux</span></p>
            <div className="mt-3 space-y-2 text-xs">
              <InfoRow label="Greenhouse" value={greenhouse?.name ?? "—"} />
              <InfoRow label="Phase" value={reading.phase_type} />
              <InfoRow label="Recorded" value={new Date(reading.recorded_at).toLocaleString()} />
            </div>
          </article>) : <p className="py-5 text-sm text-theme-muted">{!greenhouse ? "Configure a greenhouse before monitoring begins" : "No readings recorded yet"}</p>}
        </div>
      </Card>
    </div>
  </main>;
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "red" }) {
  return <div className="rounded-xl border border-metal-700 bg-white/[0.02] px-3 py-2">
    <p className="text-xs text-metal-400">{label}</p>
    <p className={`mt-1 text-3xl font-semibold tabular-nums ${tone === "red" ? "text-theme-danger" : "text-metal-50"}`}>{value}</p>
  </div>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-3 border-b border-metal-700 pb-1.5 last:border-0">
    <span className="shrink-0 text-metal-500">{label}</span>
    <span className="min-w-0 break-words text-right font-medium text-metal-50">{value}</span>
  </div>;
}
