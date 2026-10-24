"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CircleAlert,
  Gauge,
  Radio,
  RefreshCw,
  Wifi,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge, healthTone, Card, EmptyRow } from "../ui";
import { MonitoringStatus } from "../MonitoringStatus";
import { IncidentList } from "../IncidentList";
import { useDashboardData } from "@/lib/useDashboardData";
import { type MinuteAggregate } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { type GreenhouseConfig, toLocalConfig } from "@/lib/greenhouse-config";
import { phaseForGreenhouse } from "@/lib/monitoring-state";
import { greenhouseMonitoringWindow, windowContains, plotLuxPoints } from "@/lib/monitoring-window";
import { minuteHistoryPoints, sensorSeries } from "@/lib/chartData";

export function ManagerOverview(
  { data, loading, error }: {
    data: ReturnType<typeof useDashboardData>["data"];
    loading: boolean;
    error: string | null;
  },
) {
  const monitoring = useDashboardData();
  const [chartScale, setChartScale] = useState<"log" | "linear">("log");
  const [reportRefreshing, setReportRefreshing] = useState(false);
  const [greenhouseConfigs, setGreenhouseConfigs] = useState<
    GreenhouseConfig[]
  >([]);
  const [selectedGreenhouse, setSelectedGreenhouse] = useState("");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [history, setHistory] = useState<MinuteAggregate[]>([]);
  const knownSensors = monitoring.sensors.map((s) => s.sensor_id);

  const readings = useMemo(
    () =>
      [...data.readings].sort((a, b) =>
        new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
      ),
    [data.readings],
  );

  const latestBySensor = useMemo(() => {
    const map = new Map<string, (typeof data.readings)[number]>();
    for (const reading of readings) {
      const current = map.get(reading.sensor_id);
      if (
        !current ||
        new Date(reading.recorded_at).getTime() >
          new Date(current.recorded_at).getTime()
      ) {
        map.set(reading.sensor_id, reading);
      }
    }
    return map;
  }, [readings]);

  const sensors = monitoring.sensors.filter((s) =>
    s.greenhouse_id === selectedGreenhouse
  );
  const allKnownSensorIds = useMemo(
    () =>
      Array.from(new Set([...latestBySensor.keys(), ...knownSensors])).sort(),
    [latestBySensor, knownSensors],
  );
  const availableSensors = allKnownSensorIds.filter((id) =>
    !greenhouseConfigs.some((g) => g.sensorIds.includes(id))
  );
  const selectedConfig = greenhouseConfigs.find((g) =>
    g.id === selectedGreenhouse
  );
  const assignedIds = selectedConfig?.sensorIds ?? [];
  const selectedGreenhouseRecord = monitoring.greenhouses.find(g => g.id === selectedGreenhouse);
  const chartWindow = greenhouseMonitoringWindow(selectedGreenhouseRecord, monitoring.policy.dark_phase_days, monitoring.now || Date.now());
  const windowStart = chartWindow?.start;
  const windowEnd = chartWindow?.end;
  const windowPhase = chartWindow?.phase;

  const selectedPhase = phaseForGreenhouse(
    monitoring.greenhouses.find((g) => g.id === selectedGreenhouse),
    monitoring.policy.dark_phase_days,
  );
  const onlineSensorCount = assignedIds.filter(id => monitoring.sensorHealthById[id] === "Online").length;
  const scopedReadings = readings.filter((r) =>
    r.greenhouse_id === selectedGreenhouse
  );
  const openIncidents =
    data.incidents.filter((i) =>
      i.status !== "resolved" && i.greenhouse_id === selectedGreenhouse
    ).length;
  const warningReads =
    scopedReadings.filter((r) => r.classification === "warning").length;
  const recentActivities = [...scopedReadings].reverse().slice(0, 3);
  const warnings = scopedReadings.filter(r => r.classification === "warning")
    .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))
    .slice(0, 3);

  useEffect(() => {
    const configs = monitoring.greenhouses.map(toLocalConfig);
    setGreenhouseConfigs(configs);
    setSelectedGreenhouse((current) =>
      configs.some((g) => g.id === current) ? current : configs[0]?.id ?? ""
    );
  }, [monitoring.greenhouses]);

  useEffect(() => {
    let active = true;
    let fetching = false;
    async function loadHistory() {
      if (fetching) return;
      if (!selectedConfig || !supabase || !assignedIds.length || windowStart == null || windowEnd == null || !windowPhase) {
        setHistoryError(null);
        setHistory([]);
        return;
      }
      fetching = true;
      const start = new Date(windowStart).toISOString();
      const end = new Date(windowEnd).toISOString();
      const rows: MinuteAggregate[] = [];
      try {
        for (
          let offset = 0;
          offset < 1440 * assignedIds.length;
          offset += 1000
        ) {
          const result = await supabase.from("sensor_minute_aggregates")
            .select(
              "id,sensor_id,greenhouse_id,bucket_start,phase_type,sample_count,avg_lux,min_lux,max_lux,safe_count,warning_count,violation_count,updated_at,last_recorded_at,config_version",
            )
            .eq("greenhouse_id", selectedConfig.id).eq("phase_type", windowPhase).gte("bucket_start", start).lt("bucket_start", end)
            .order("bucket_start", { ascending: true }).order("id", {
              ascending: true,
            }).range(offset, offset + 999).abortSignal(
              AbortSignal.timeout(10_000),
            );
          if (result.error) throw new Error(result.error.message);
          const page = (result.data ?? []) as MinuteAggregate[];
          rows.push(...page);
          if (page.length < 1000) break;
        }
        if (active) {
          setHistory(rows);
          setHistoryError(null);
        }
      } catch (e) {
        if (active) {
          setHistoryError(
            e instanceof Error ? e.message : "History unavailable",
          );
        }
      } finally {
        fetching = false;
      }
    }
    setHistory([]);
    loadHistory();
    const interval = setInterval(loadHistory, 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedGreenhouse, assignedIds.join(","), windowStart, windowEnd, windowPhase]);

  const chartData = useMemo(() => {
    const now = monitoring.now || Date.now();
    const inWindow = (stamp: string, phase: string) => windowContains(chartWindow, stamp, phase, now);
    return minuteHistoryPoints(
      history.filter(row => inWindow(row.bucket_start, row.phase_type)),
      readings.filter(row => inWindow(row.recorded_at, row.phase_type)),
      selectedGreenhouse, assignedIds,
    );
  }, [history, readings, selectedGreenhouse, assignedIds.join(","), windowStart, windowEnd, windowPhase, monitoring.now]);
  const logarithmic = chartScale === "log";
  const plottedData = useMemo(() => plotLuxPoints(chartData, logarithmic), [chartData, logarithmic]);
  const peakLux = Math.max(selectedPhase === "dark" ? 30 : 50, ...chartData.flatMap(point => assignedIds.map(id => point[id] ?? 0)));
  const logTicks = (peakLux < 100 ? [0, 1, 5, 15, 30, 50] : [0, 10, 100, 1000, 10000, 100000])
    .filter(value => value <= peakLux + 10).map(value => value + 1);
  const chartAsOf = chartData.length ? chartData[chartData.length - 1].time : null;
  const displayTime = (time: number) => new Date(time).toLocaleString([], { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  async function refreshReport() {
    setReportRefreshing(true);
    try {
      await monitoring.refresh();
    } finally {
      setReportRefreshing(false);
    }
  }

  return (
    <div className="dashboard-content space-y-4">
      <header className="dashboard-heading flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">
            Monitor Overview
          </h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Real-time greenhouse monitoring and system status.
          </p>
        </div>
      </header>
      <MonitoringStatus compact />

      <label className="flex flex-wrap items-center gap-3 text-sm text-theme-text">
        Greenhouse
        <select
          value={selectedGreenhouse}
          onChange={(e) => setSelectedGreenhouse(e.target.value)}
          disabled={!greenhouseConfigs.length}
          aria-label="Select greenhouse"
          className="min-w-0 w-full sm:w-64 rounded-lg border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-3 py-2 text-xs font-medium text-[var(--foreground)] outline-none backdrop-blur-xl disabled:cursor-not-allowed disabled:opacity-70"
        >
          {greenhouseConfigs.length
            ? greenhouseConfigs.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))
            : <option value="">No Greenhouse Configured</option>}
        </select>
      </label>

      <div className="manager-kpis grid grid-cols-3 gap-3 sm:grid-cols-3">
        <SummaryCard
          icon={<Radio size={18} />}
          label="Sensors Reporting"
          value={onlineSensorCount}
        />
        <SummaryCard
          icon={<CircleAlert size={18} />}
          label="Open Incidents"
          value={openIncidents}
          danger={openIncidents > 0}
        />
        <SummaryCard
          icon={<Gauge size={18} />}
          label="Active Phases"
          value={selectedPhase ? 1 : 0}
        />
      </div>

      <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="font-bold text-[var(--foreground)]">
                  Minute-average lux history
                </h2>
                {chartAsOf && (
                  <span className="text-xs text-[var(--muted-foreground)]">
                    as of {new Date(chartAsOf).toLocaleString()}
                  </span>
                )}
              </div>

              <p className="mt-1 text-xs text-theme-muted">{chartWindow ? `${chartWindow.active ? "Current" : "Latest"} ${chartWindow.phase} window: ${displayTime(chartWindow.start)} – ${displayTime(chartWindow.end - 60_000)} (Asia/Manila)` : "No monitoring window available for the active phase."}</p>
            </div>
            <label className="flex items-center gap-2 text-sm text-theme-text">
              Scale
              <select aria-label="Lux chart scale" value={chartScale} onChange={e => setChartScale(e.target.value as "log" | "linear")} className="min-h-11 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
                <option value="log">Logarithmic</option>
                <option value="linear">Linear</option>
              </select>
            </label>
          </div>
          {historyError && (
            <p role="status" className="mt-2 text-xs text-theme-danger">
              History unavailable; retained points may be stale.
            </p>
          )}
          <div className="chart-frame mt-3">
            {chartData.length
              ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart accessibilityLayer data={plottedData} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
                    <defs>
                      <linearGradient
                        id="overviewLuxGradient"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor="var(--accent)"
                          stopOpacity={0.3}
                        />
                        <stop
                          offset="95%"
                          stopColor="var(--accent)"
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="var(--surface-border)"
                    />
                    <XAxis
                      dataKey="time"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(value) =>
                        new Date(value).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      tick={{ fontSize: 12, fill: "var(--text-muted)" }}
                      interval="preserveStartEnd"
                      minTickGap={40}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 12, fill: "var(--text-muted)" }}
                      width={44}
                      tickLine={false}
                      axisLine={false}
                      scale={logarithmic ? "log" : "linear"}
                      ticks={logarithmic ? logTicks : undefined}
                      domain={[logarithmic ? 1 : 0, (max: number) => Math.max(max, (selectedPhase === "dark" ? 30 : 50) + (logarithmic ? 1 : 0)) + 10]}
                      allowDecimals={false}
                      tickFormatter={value => (logarithmic ? Number(value) - 1 : Number(value)).toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })}
                    />
                    <Tooltip position={{ x: 12, y: 8 }}
                      labelFormatter={value => new Date(Number(value)).toLocaleString()}
                      formatter={(value: number, name: string) => [`${(logarithmic ? value - 1 : value).toFixed(2)} lux`, name]}
                      contentStyle={{
                        borderRadius: 12,
                        background: "var(--surface-solid)",
                        border: "1px solid var(--surface-border)",
                        color: "var(--foreground)",
                      }}
                    />
                    <Legend />
                    {selectedPhase && <ReferenceLine
                      y={(selectedPhase === "dark" ? 15 : 50) + (logarithmic ? 1 : 0)}
                      stroke="var(--success)"
                      strokeDasharray="4 4"
                    />}
                    {selectedPhase && <ReferenceLine
                      y={30 + (logarithmic ? 1 : 0)}
                      stroke="var(--danger)"
                      strokeDasharray="4 4"
                    />}
                    {assignedIds.map((id, index) => (
                      <Area
                        key={id}
                        data={sensorSeries(
                          plottedData,
                          id,
                          90_000,
                        )}
                        isAnimationActive={false}
                        type="linear"
                        dataKey={id}
                        name={id}
                        stroke={[
                          "var(--accent)",
                          "var(--warning)",
                          "var(--success)",
                        ][index % 3]}
                        strokeWidth={2.5}
                        strokeDasharray={[undefined, "8 4", "2 4"][index % 3]}
                        fillOpacity={0.05}
                        connectNulls
                        dot={{ r: 2 }}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              )
              : (
                <div className="grid h-full place-items-center text-sm text-[var(--muted-foreground)]">
                  {!greenhouseConfigs.length
                    ? "No Greenhouse Configured"
                    : "No readings in this monitoring window"}
                </div>
              )}
          </div>
          <p className="mt-3 text-xs text-theme-muted">Current or latest monitoring window only. One point per minute, refreshed every 10 seconds.</p>
          <p className="mt-3 text-xs text-theme-muted">Actual intensity in lux · dashed lines show safe and violation boundaries. {logarithmic ? "Logarithmic spacing keeps low readings visible alongside spikes, including zero-lux readings." : "Linear spacing shows absolute lux differences."}</p>
        </Card>

        <Card className="flex flex-col">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-bold text-[var(--foreground)]">
                System Report
              </h2>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                Current system-wide monitoring status.
              </p>
            </div>
            <button
              aria-label="Refresh report"
              onClick={refreshReport}
              disabled={reportRefreshing}
              className="rounded-lg p-2 text-[var(--muted-foreground)] transition hover:bg-white/[0.05] hover:text-[var(--foreground)] disabled:opacity-50"
            >
              <RefreshCw
                aria-label="Refresh report"
                size={18}
                className={reportRefreshing ? "animate-spin" : ""}
              />
            </button>
          </div>
          <div className="mt-4 flex flex-1 flex-col justify-between gap-3">
            <ReportRow
              label="Sensors Detected"
              value={latestBySensor.size.toString()}
            />
            <ReportRow
              label="Available Sensors"
              value={availableSensors.length.toString()}
            />
            <ReportRow
              label="Online Sensors"
              value={onlineSensorCount.toString()}
            />
            <ReportRow label="Warning" value={warningReads.toString()} />
            <ReportRow
              label="Open Incidents"
              value={openIncidents.toString()}
              danger={openIncidents > 0}
            />
          </div>
        </Card>
      </div>

      <div className="grid items-stretch gap-4 xl:grid-cols-3">
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-bold text-[var(--foreground)]">
              Recent Activities
            </h2>
            <Activity size={17} className="text-[var(--muted-foreground)]" />
          </div>
          <div className="max-h-56 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-metal-700 text-metal-400">
                <tr>
                  <th className="p-3">Greenhouse</th>
                  <th className="p-3">Sensor</th>
                  <th className="p-3">Average lux</th>
                </tr>
              </thead>
              <tbody>
                {recentActivities.length
                  ? recentActivities.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-metal-700 last:border-0"
                    >
                      <td className="p-3 text-metal-300">
                        {greenhouseConfigs.find((g) =>
                          g.sensorIds.includes(r.sensor_id)
                        )?.name ?? "—"}
                      </td>
                      <td className="p-3 font-mono text-metal-400">
                        {r.sensor_id}
                      </td>
                      <td className="p-3 font-mono font-semibold text-metal-100">
                        {r.lux.toFixed(2)}
                      </td>
                    </tr>
                  ))
                  : <EmptyRow colSpan={3} text="No recent activities" />}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-bold text-[var(--foreground)]">
              Sensor Status Summary
            </h2>
            <Wifi size={17} className="text-[var(--muted-foreground)]" />
          </div>
          <div className="max-h-56 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-metal-700 text-metal-400">
                <tr>
                  <th className="p-3">Sensor ID</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {sensors.length
                  ? sensors.map((r) => (
                    <tr
                      key={r.sensor_id}
                      className="border-b border-metal-700 last:border-0"
                    >
                      <td className="p-3 font-mono text-metal-400">
                        {r.sensor_id}
                      </td>
                      <td className="p-3">
                        <Badge
                          tone={healthTone(monitoring.sensorHealthById[r.sensor_id] ?? "Unknown")}
                        >
                          {monitoring.sensorHealthById[r.sensor_id] ?? "Unknown"}
                        </Badge>
                      </td>
                    </tr>
                  ))
                  : <EmptyRow colSpan={2} text="No sensors detected" />}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-bold text-[var(--foreground)]">Warnings</h2>
            <AlertTriangle
              size={17}
              className="text-[var(--muted-foreground)]"
            />
          </div>
          <div className="max-h-56 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-metal-700 text-metal-400">
                <tr>
                  <th className="p-3">Greenhouse</th>
                  <th className="p-3">Sensor</th>
                  <th className="p-3">Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {warnings.length
                  ? warnings.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-metal-700 last:border-0"
                    >
                      <td className="p-3 text-metal-300">
                        {greenhouseConfigs.find((g) =>
                          g.sensorIds.includes(r.sensor_id)
                        )?.name ?? "—"}
                      </td>
                      <td className="p-3 font-mono text-metal-400">
                        {r.sensor_id}
                      </td>
                      <td className="p-3 text-metal-400">
                        {new Date(r.recorded_at).toLocaleString()}
                      </td>
                    </tr>
                  ))
                  : <EmptyRow colSpan={3} text="No warnings" />}
              </tbody>
            </table>
          </div>
        </Card>

      </div>
      <IncidentList greenhouseId={selectedGreenhouse} />
    </div>
  );
}

function SummaryCard(
  { icon, label, value, danger = false }: {
    icon: React.ReactNode;
    label: string;
    value: number;
    danger?: boolean;
  },
) {
  return (
    <Card compact className="min-h-0">
      <div className="flex items-center gap-2 sm:gap-3">
        <span className="hidden rounded-xl bg-white/[0.04] p-2 sm:inline-flex text-[var(--muted-foreground)]">
          {icon}
        </span>
        <div>
          <p className="text-sm text-[var(--muted-foreground)]">{label}</p>
          <p
            className={`mt-0.5 text-2xl font-bold tabular-nums ${
              danger ? "text-theme-danger" : "text-[var(--foreground)]"
            }`}
          >
            {value}
          </p>
        </div>
      </div>
    </Card>
  );
}

function ReportRow(
  { label, value, danger = false }: {
    label: string;
    value: string;
    danger?: boolean;
  },
) {
  return (
    <div className="flex items-center justify-between border-b border-metal-700 pb-3 last:border-0 last:pb-0">
      <span className="text-sm text-[var(--muted-foreground)]">{label}</span>
      <span
        className={`max-w-[65%] text-right font-mono text-sm font-semibold ${
          danger ? "text-theme-danger" : "text-[var(--foreground)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
