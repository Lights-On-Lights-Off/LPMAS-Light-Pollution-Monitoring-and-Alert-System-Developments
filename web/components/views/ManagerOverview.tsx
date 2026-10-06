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
import { Badge, Card, EmptyRow } from "../ui";
import { MonitoringStatus } from "../MonitoringStatus";
import { IncidentList } from "../IncidentList";
import { useDashboardData } from "@/lib/useDashboardData";
import { type MinuteAggregate } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { type GreenhouseConfig, toLocalConfig } from "@/lib/greenhouse-config";
import { phaseForGreenhouse } from "@/lib/monitoring-state";
import { sensorSeries } from "@/lib/chartData";

export function ManagerOverview(
  { data, loading, error }: {
    data: ReturnType<typeof useDashboardData>["data"];
    loading: boolean;
    error: string | null;
  },
) {
  const monitoring = useDashboardData();
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
  const warnings = [...scopedReadings].reverse().filter((r) =>
    r.classification === "warning"
  ).slice(0, 5);

  useEffect(() => {
    const configs = monitoring.greenhouses.map(toLocalConfig);
    setGreenhouseConfigs(configs);
    setSelectedGreenhouse((current) =>
      configs.some((g) => g.id === current) ? current : configs[0]?.id ?? ""
    );
  }, [monitoring.greenhouses]);

  useEffect(() => {
    let active = true;
    async function loadHistory() {
      if (!selectedConfig || !supabase || !assignedIds.length) {
        setHistoryError(null);
        setHistory([]);
        return;
      }
      const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const rows: MinuteAggregate[] = [];
      try {
        for (
          let offset = 0;
          offset < 1440 * assignedIds.length;
          offset += 1000
        ) {
          const result = await supabase.from("sensor_minute_aggregates")
            .select(
              "id,sensor_id,greenhouse_id,bucket_start,phase_type,sample_count,avg_lux,min_lux,max_lux,safe_count,warning_count,violation_count,updated_at",
            )
            .eq("greenhouse_id", selectedConfig.id).gte("bucket_start", start)
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
      }
    }
    setHistory([]);
    loadHistory();
    const interval = setInterval(loadHistory, 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedConfig, assignedIds.join(",")]);

  const chartData = useMemo(() => {
    const rows = history.length
      ? history.map((r) => ({
        time: Date.parse(r.bucket_start),
        sensor_id: r.sensor_id,
        lux: r.avg_lux,
      }))
      : scopedReadings.slice(-100).map((r) => ({
        time: Date.parse(r.recorded_at),
        sensor_id: r.sensor_id,
        lux: r.lux,
      }));
    const buckets = new Map<number, Record<string, number>>();
    for (const r of rows) {
      const row = buckets.get(r.time) ?? { time: r.time };
      row[r.sensor_id] = r.lux;
      buckets.set(r.time, row);
    }
    return [...buckets.values()].sort((a, b) => a.time - b.time);
  }, [history, data.readings, selectedGreenhouse]);

  // Newest timestamp behind whatever the chart is currently showing, so a
  // stale Supabase fallback is never presented as if it were live.
  const chartAsOf = useMemo(() => {
    if (!selectedConfig) return null;
    const source = history.length
      ? history.map((row) => row.bucket_start)
      : readings.filter((r) => r.greenhouse_id === selectedGreenhouse).map(
        (r) => r.recorded_at,
      );
    if (!source.length) return null;
    return source.reduce((newest, value) => {
      const time = new Date(value).getTime();
      return time > newest ? time : newest;
    }, 0);
  }, [history, readings, selectedConfig, assignedIds.join(",")]);

  async function refreshReport() {
    setReportRefreshing(true);
    try {
      await monitoring.refresh();
    } finally {
      setReportRefreshing(false);
    }
  }

  return (
    <div className="space-y-6 p-6 md:p-8">
      <MonitoringStatus />
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">
            Monitor Overview
          </h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Real-time greenhouse monitoring and system status.
          </p>
        </div>
      </div>

      <label className="flex flex-wrap items-center gap-3 text-sm text-theme-text">
        Greenhouse
        <select
          value={selectedGreenhouse}
          onChange={(e) => setSelectedGreenhouse(e.target.value)}
          disabled={!greenhouseConfigs.length}
          aria-label="Select greenhouse"
          className="min-w-[150px] max-w-[190px] rounded-lg border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-3 py-2 text-xs font-medium text-[var(--foreground)] outline-none backdrop-blur-xl disabled:cursor-not-allowed disabled:opacity-70"
        >
          {greenhouseConfigs.length
            ? greenhouseConfigs.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))
            : <option value="">No Greenhouse Configured</option>}
        </select>
      </label>

      <div className="grid gap-5 md:grid-cols-3">
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

      <div className="grid items-stretch gap-5 xl:grid-cols-[1.7fr_1fr]">
        <Card className="min-h-[340px]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="font-bold text-[var(--foreground)]">
                  Lux Intensity Trend
                </h2>
                {chartAsOf && (
                  <span className="text-xs text-[var(--muted-foreground)]">
                    as of {new Date(chartAsOf).toLocaleString()}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                One-minute averages from Supabase; raw samples when history is
                unavailable.
              </p>
            </div>
          </div>
          {historyError && (
            <p role="status" className="mt-2 text-xs text-theme-danger">
              History unavailable; retained points may be stale.
            </p>
          )}
          <div className="mt-6 h-[255px]">
            {chartData.length
              ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
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
                      tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                      width={40}
                    />
                    <Tooltip
                      contentStyle={{
                        borderRadius: 12,
                        background: "var(--surface-solid)",
                        border: "1px solid var(--surface-border)",
                        color: "var(--foreground)",
                      }}
                    />
                    <Legend />
                    <ReferenceLine
                      y={selectedPhase === "dark" ? 15 : 50}
                      stroke="var(--success)"
                      strokeDasharray="4 4"
                    />
                    <ReferenceLine
                      y={selectedPhase === "dark" ? 29 : 30}
                      stroke="var(--danger)"
                      strokeDasharray="4 4"
                    />
                    {assignedIds.map((id, index) => (
                      <Area
                        key={id}
                        data={sensorSeries(
                          chartData,
                          id,
                          history.length ? 90_000 : 15_000,
                        )}
                        isAnimationActive={false}
                        type="linear"
                        dataKey={id}
                        name={`${id} (${
                          history.length ? "minute avg" : "raw"
                        })`}
                        stroke={[
                          "var(--accent)",
                          "var(--warning)",
                          "var(--success)",
                        ][index % 3]}
                        strokeWidth={2}
                        fillOpacity={0.05}
                        connectNulls={false}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              )
              : (
                <div className="grid h-full place-items-center text-sm text-[var(--muted-foreground)]">
                  {!greenhouseConfigs.length
                    ? "No Greenhouse Configured"
                    : "No readings recorded yet"}
                </div>
              )}
          </div>
        </Card>

        <Card className="min-h-[340px]">
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
          <div className="mt-6 space-y-5">
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

      <div className="grid gap-5 xl:grid-cols-3">
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-bold text-[var(--foreground)]">
              Recent Activities
            </h2>
            <Activity size={17} className="text-[var(--muted-foreground)]" />
          </div>
          <div className="max-h-44 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-metal-700 text-metal-400">
                <tr>
                  <th className="p-3">Greenhouse</th>
                  <th className="p-3">Sensor</th>
                  <th className="p-3">Lux</th>
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
          <div className="max-h-44 overflow-y-auto">
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
                          tone={monitoring.sensorHealthById[r.sensor_id] === "Online" ? "green" : monitoring.sensorHealthById[r.sensor_id] === "Offline" ? "red" : "slate"}
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
          <div className="max-h-44 overflow-y-auto">
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
    <Card className="min-h-0">
      <div className="flex items-center gap-3">
        <span className="rounded-xl bg-white/[0.04] p-2 text-[var(--muted-foreground)]">
          {icon}
        </span>
        <div>
          <p className="text-sm text-[var(--muted-foreground)]">{label}</p>
          <p
            className={`mt-1 font-mono text-2xl font-bold ${
              danger ? "text-red-400" : "text-[var(--foreground)]"
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
          danger ? "text-red-400" : "text-[var(--foreground)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
