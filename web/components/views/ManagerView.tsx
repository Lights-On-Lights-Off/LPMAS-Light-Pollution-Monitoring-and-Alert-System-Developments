"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CircleAlert, Download, Gauge, Radio, Recycle, RefreshCw, Sprout, Trash2, Wifi, X } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { Card, Badge } from "../ui";
import { useDashboardData } from "@/lib/useDashboardData";
import { getDashboardSummary, getGreenhouses, getHardwareActivity, saveGreenhouse, deleteGreenhouse, type Greenhouse, type MinuteAggregate, type Reading } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { logActivity } from "@/lib/activityLog";

type ManagerSection = "Overview" | "Greenhouses" | "Activity Logs" | "Recycle bin" | "Recycle Bin";

type ActivityLog = {
  id: number;
  username: string | null;
  action: string;
  resource: string | null;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

type GreenhouseConfig = {
  id: string;
  name: string;
  sensorIds: string[];
  phaseStart: string;
  phaseEnd: string;
  windowStart: string;
  windowEnd: string;
};

const CONFIG_KEY = "lpmas-greenhouse-config";

function actionBadge(action: string) {
  const tone = action === "SIGN_IN" || action === "SIGN_OUT" ? "green" : action.startsWith("EXPORT_") ? "purple" : "accent";
  const background =
    tone === "green" ? "color-mix(in_srgb,#22c55e_12%,transparent)"
    : tone === "purple" ? "color-mix(in_srgb,#a855f7_12%,transparent)"
    : "color-mix(in_srgb,var(--accent)_12%,transparent)";
  const border =
    tone === "green" ? "color-mix(in_srgb,#22c55e_25%,transparent)"
    : tone === "purple" ? "color-mix(in_srgb,#a855f7_25%,transparent)"
    : "color-mix(in_srgb,var(--accent)_25%,transparent)";
  const color = tone === "green" ? "#4ade80" : tone === "purple" ? "#c084fc" : "var(--accent)";

  return (
    <span
      className="inline-flex items-center justify-center rounded-full px-2.5 py-1 text-[11px] font-bold leading-none tracking-[0.04em]"
      style={{ background, border: `1px solid ${border}`, color }}
    >
      {action}
    </span>
  );
}

export function ManagerView({ section = "Overview" }: { section?: ManagerSection }) {
  const { data, loading, error } = useDashboardData();
  if (section === "Greenhouses") return <GreenhousesView />;
  if (section === "Activity Logs") return <ActivityLogsView />;
  if (section === "Recycle bin" || section === "Recycle Bin") return <RecycleBinView />;
  return <OverviewView data={data} loading={loading} error={error} />;
}

function readLocalConfigs() {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "[]");
    return Array.isArray(value) ? (value as GreenhouseConfig[]) : [];
  } catch {
    return [];
  }
}

function toLocalConfig(g: Greenhouse): GreenhouseConfig {
  return {
    id: g.id,
    name: g.name,
    sensorIds: g.sensor_ids ?? [],
    phaseStart: g.phase_start,
    phaseEnd: g.phase_end,
    windowStart: g.window_start,
    windowEnd: g.window_end
  };
}

// Sensor IDs seen by the system, live or not. Live Pi readings are preferred,
// but sensors that have ever reported into Supabase remain visible/assignable
// so the Overview and Greenhouses pages stay accurate while the Pi is quiet.
async function knownSensorIds(): Promise<string[]> {
  if (!supabase) return [];
  const [aggregateResult, assignedResult] = await Promise.all([
    supabase.from("sensor_minute_aggregates").select("sensor_id").order("bucket_start", { ascending: false }).limit(1000),
    supabase.from("greenhouse_sensors").select("sensor_id")
  ]);
  const ids = new Set<string>();
  if (!aggregateResult.error) (aggregateResult.data ?? []).forEach(row => row.sensor_id && ids.add(row.sensor_id));
  if (!assignedResult.error) (assignedResult.data ?? []).forEach(row => row.sensor_id && ids.add(row.sensor_id));
  return Array.from(ids);
}

function mergeSensorIds(live: string[], known: string[]) {
  return Array.from(new Set([...live, ...known])).sort();
}

function OverviewView({ data, loading, error }: { data: ReturnType<typeof useDashboardData>["data"]; loading: boolean; error: string | null }) {
  const [reportRefreshing, setReportRefreshing] = useState(false);
  const [greenhouseConfigs, setGreenhouseConfigs] = useState<GreenhouseConfig[]>([]);
  const [selectedGreenhouse, setSelectedGreenhouse] = useState("");
  const [history, setHistory] = useState<MinuteAggregate[]>([]);
  const [knownSensors, setKnownSensors] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    knownSensorIds().then(ids => {
      if (active) setKnownSensors(ids);
    });
    return () => {
      active = false;
    };
  }, []);

  const readings = useMemo(
    () => [...data.readings].sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()),
    [data.readings]
  );

  const latestBySensor = useMemo(() => {
    const map = new Map<string, (typeof data.readings)[number]>();
    for (const reading of readings) {
      const current = map.get(reading.sensor_id);
      if (!current || new Date(reading.recorded_at).getTime() > new Date(current.recorded_at).getTime()) {
        map.set(reading.sensor_id, reading);
      }
    }
    return map;
  }, [readings]);

  const sensors = Array.from(latestBySensor.values());
  const allKnownSensorIds = useMemo(() => mergeSensorIds(Array.from(latestBySensor.keys()), knownSensors), [latestBySensor, knownSensors]);
  const availableSensors = allKnownSensorIds.filter(id => !greenhouseConfigs.some(g => g.sensorIds.includes(id)));
  const selectedConfig = greenhouseConfigs.find(g => g.id === selectedGreenhouse);
  const assignedIds = selectedConfig?.sensorIds ?? [];
  const onlineSensorCount = assignedIds.filter(id => {
    const reading = latestBySensor.get(id);
    return !!reading && Date.now() - new Date(reading.recorded_at).getTime() < 60_000;
  }).length;
  const openIncidents = data.incidents.filter(i => i.status !== "resolved" && (!selectedConfig || assignedIds.includes(i.sensor_id))).length;
  const warningReads = readings.filter(r => r.classification === "warning").length;
  const recentActivities = [...readings].reverse().slice(0, 3);
  const warnings = [...readings].reverse().filter(r => r.classification === "warning").slice(0, 5);

  useEffect(() => {
    const load = async () => {
      const local = readLocalConfigs();
      try {
        const remote = await getGreenhouses();
        const configs = remote.length ? remote.map(toLocalConfig) : local;
        setGreenhouseConfigs(configs);
        setSelectedGreenhouse(current => (current && configs.some(g => g.id === current) ? current : configs[0]?.id ?? ""));
        if (remote.length) localStorage.setItem(CONFIG_KEY, JSON.stringify(configs));
      } catch {
        setGreenhouseConfigs(local);
        setSelectedGreenhouse(current => (current && local.some(g => g.id === current) ? current : local[0]?.id ?? ""));
      }
    };
    load();
    window.addEventListener("lpmas-greenhouse-config-updated", load);
    return () => window.removeEventListener("lpmas-greenhouse-config-updated", load);
  }, []);

  useEffect(() => {
    let active = true;
    async function loadHistory() {
      if (!selectedConfig || !supabase || !assignedIds.length) {
        setHistory([]);
        return;
      }
      const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: rows, error: historyError } = await supabase
        .from("sensor_minute_aggregates")
        .select("id,sensor_id,greenhouse_id,bucket_start,phase_type,sample_count,avg_lux,min_lux,max_lux,safe_count,warning_count,violation_count,updated_at")
        .in("sensor_id", assignedIds)
        .gte("bucket_start", start)
        .order("bucket_start", { ascending: true })
        .limit(1440);
      if (active && !historyError) setHistory((rows ?? []) as MinuteAggregate[]);
    }
    loadHistory();
    const interval = setInterval(loadHistory, 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedConfig, assignedIds.join(",")]);

  const chartData = useMemo(() => {
    if (!selectedConfig) return [];
    if (history.length) {
      return history.map(row => ({ time: new Date(row.bucket_start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), lux: row.avg_lux }));
    }
    return readings
      .filter(r => assignedIds.includes(r.sensor_id))
      .slice(-30)
      .map(r => ({ time: new Date(r.recorded_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), lux: r.lux }));
  }, [history, readings, selectedConfig, assignedIds.join(",")]);

  // Newest timestamp behind whatever the chart is currently showing, so a
  // stale Supabase fallback is never presented as if it were live.
  const chartAsOf = useMemo(() => {
    if (!selectedConfig) return null;
    const source = history.length
      ? history.map(row => row.bucket_start)
      : readings.filter(r => assignedIds.includes(r.sensor_id)).map(r => r.recorded_at);
    if (!source.length) return null;
    return source.reduce((newest, value) => {
      const time = new Date(value).getTime();
      return time > newest ? time : newest;
    }, 0);
  }, [history, readings, selectedConfig, assignedIds.join(",")]);

  async function refreshReport() {
    setReportRefreshing(true);
    try {
      const latest = await getDashboardSummary();
      window.dispatchEvent(new CustomEvent("lpmas-dashboard-data-refreshed", { detail: latest }));
    } finally {
      setReportRefreshing(false);
    }
  }

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Monitor Overview</h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">Real-time greenhouse monitoring and system status.</p>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-3">
        <SummaryCard icon={<Radio size={18} />} label="Sensors Reporting" value={onlineSensorCount} />
        <SummaryCard icon={<CircleAlert size={18} />} label="Open Incidents" value={openIncidents} danger={openIncidents > 0} />
        <SummaryCard icon={<Gauge size={18} />} label="Active Phases" value={data.phase?.is_active ? 1 : 0} />
      </div>

      <div className="grid items-stretch gap-5 xl:grid-cols-[1.7fr_1fr]">
        <Card className="min-h-[340px]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="font-bold text-[var(--foreground)]">Lux Intensity Trend</h2>
                {chartAsOf && <span className="text-xs text-[var(--muted-foreground)]">as of {new Date(chartAsOf).toLocaleString()}</span>}
              </div>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">Minute history from Supabase with live readings as fallback.</p>
            </div>
            <select
              value={selectedGreenhouse}
              onChange={e => setSelectedGreenhouse(e.target.value)}
              disabled={!greenhouseConfigs.length}
              aria-label="Select greenhouse"
              className="min-w-[150px] max-w-[190px] rounded-lg border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-3 py-2 text-xs font-medium text-[var(--foreground)] outline-none backdrop-blur-xl disabled:cursor-not-allowed disabled:opacity-70"
            >
              {greenhouseConfigs.length ? greenhouseConfigs.map(g => <option key={g.id} value={g.id}>{g.name}</option>) : <option value="">No Greenhouse Configured</option>}
            </select>
          </div>
          <div className="mt-6 h-[255px]">
            {chartData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="overviewLuxGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#232427" />
                  <XAxis dataKey="time" tick={{ fontSize: 11, fill: "#6f7278" }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11, fill: "#6f7278" }} width={40} />
                  <Tooltip contentStyle={{ borderRadius: 12, background: "#18191b", border: "1px solid #34363b", color: "#e3e4e7" }} />
                  <Area type="monotone" dataKey="lux" stroke="var(--accent)" strokeWidth={2} fill="url(#overviewLuxGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="grid h-full place-items-center text-sm text-[var(--muted-foreground)]">
                {!greenhouseConfigs.length ? "No Greenhouse Configured" : "No readings recorded yet"}
              </div>
            )}
          </div>
        </Card>

        <Card className="min-h-[340px]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-bold text-[var(--foreground)]">System Report</h2>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">Current system-wide monitoring status.</p>
            </div>
            <button onClick={refreshReport} disabled={reportRefreshing} className="rounded-lg p-2 text-[var(--muted-foreground)] transition hover:bg-white/[0.05] hover:text-[var(--foreground)] disabled:opacity-50">
              <RefreshCw size={18} className={reportRefreshing ? "animate-spin" : ""} />
            </button>
          </div>
          <div className="mt-6 space-y-5">
            <ReportRow label="Sensors Detected" value={latestBySensor.size.toString()} />
            <ReportRow label="Available Sensors" value={availableSensors.length.toString()} />
            <ReportRow label="Online Sensors" value={onlineSensorCount.toString()} />
            <ReportRow label="Warning" value={warningReads.toString()} />
            <ReportRow label="Open Incidents" value={openIncidents.toString()} danger={openIncidents > 0} />
          </div>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-bold text-[var(--foreground)]">Recent Activities</h2>
            <Activity size={17} className="text-[var(--muted-foreground)]" />
          </div>
          <div className="max-h-44 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-metal-700 text-metal-400">
                <tr><th className="p-3">Greenhouse</th><th className="p-3">Sensor</th><th className="p-3">Lux</th></tr>
              </thead>
              <tbody>
                {recentActivities.length ? recentActivities.map(r => (
                  <tr key={r.id} className="border-b border-metal-700 last:border-0">
                    <td className="p-3 text-metal-300">{greenhouseConfigs.find(g => g.sensorIds.includes(r.sensor_id))?.name ?? "—"}</td>
                    <td className="p-3 font-mono text-metal-400">{r.sensor_id}</td>
                    <td className="p-3 font-mono font-semibold text-metal-100">{r.lux.toFixed(2)}</td>
                  </tr>
                )) : <EmptyRow colSpan={3} text="No recent activities" />}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-bold text-[var(--foreground)]">Sensor Status Summary</h2>
            <Wifi size={17} className="text-[var(--muted-foreground)]" />
          </div>
          <div className="max-h-44 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-metal-700 text-metal-400">
                <tr><th className="p-3">Sensor ID</th><th className="p-3">Status</th></tr>
              </thead>
              <tbody>
                {sensors.length ? sensors.map(r => (
                  <tr key={r.sensor_id} className="border-b border-metal-700 last:border-0">
                    <td className="p-3 font-mono text-metal-400">{r.sensor_id}</td>
                    <td className="p-3">
                      <Badge tone={Date.now() - new Date(r.recorded_at).getTime() < 60_000 ? "green" : "red"}>
                        {Date.now() - new Date(r.recorded_at).getTime() < 60_000 ? "Online" : "Offline"}
                      </Badge>
                    </td>
                  </tr>
                )) : <EmptyRow colSpan={2} text="No sensors detected" />}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-bold text-[var(--foreground)]">Warnings</h2>
            <AlertTriangle size={17} className="text-[var(--muted-foreground)]" />
          </div>
          <div className="max-h-44 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-metal-700 text-metal-400">
                <tr><th className="p-3">Greenhouse</th><th className="p-3">Sensor</th><th className="p-3">Timestamp</th></tr>
              </thead>
              <tbody>
                {warnings.length ? warnings.map(r => (
                  <tr key={r.id} className="border-b border-metal-700 last:border-0">
                    <td className="p-3 text-metal-300">{greenhouseConfigs.find(g => g.sensorIds.includes(r.sensor_id))?.name ?? "—"}</td>
                    <td className="p-3 font-mono text-metal-400">{r.sensor_id}</td>
                    <td className="p-3 text-metal-400">{new Date(r.recorded_at).toLocaleString()}</td>
                  </tr>
                )) : <EmptyRow colSpan={3} text="No warnings" />}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

function GreenhousesView() {
  const { data, loading } = useDashboardData();
  const [greenhouses, setGreenhouses] = useState<GreenhouseConfig[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phaseStart, setPhaseStart] = useState("");
  const [phaseEnd, setPhaseEnd] = useState("");
  const [windowStart, setWindowStart] = useState("18:30");
  const [windowEnd, setWindowEnd] = useState("23:00");
  const [selectedSensors, setSelectedSensors] = useState<string[]>([]);
  const [sensorPickerOpen, setSensorPickerOpen] = useState(false);
  const [detectedSensors, setDetectedSensors] = useState<string[]>([]);
  const [sensorRefreshing, setSensorRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [defaultPhase, setDefaultPhase] = useState({ start: "", end: "" });

  useEffect(() => {
    fetch("/api/admin/settings", { cache: "no-store" })
      .then(res => (res.ok ? res.json() : null))
      .then(body => {
        if (body) setDefaultPhase({ start: body.default_illumination_start ?? "", end: body.default_illumination_end ?? "" });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const load = async () => {
      const live = Array.from(new Set(data.readings.map(r => r.sensor_id).filter(Boolean)));
      const known = await knownSensorIds();
      try {
        const remote = await getGreenhouses();
        const configs = remote.map(toLocalConfig);
        setGreenhouses(configs);
        setDetectedSensors(mergeSensorIds(live, known));
        if (remote.length) localStorage.setItem(CONFIG_KEY, JSON.stringify(configs));
      } catch {
        const local = readLocalConfigs();
        setGreenhouses(local);
        setDetectedSensors(mergeSensorIds(live, known));
      }
    };
    load();
  }, [data.readings]);

  const availableSensors = detectedSensors.filter(id => !greenhouses.some(g => g.sensorIds.includes(id) && g.id !== editingId) || selectedSensors.includes(id));

  function openAddModal() {
    setEditingId(null);
    setName("");
    setPhaseStart(defaultPhase.start);
    setPhaseEnd(defaultPhase.end);
    setWindowStart("18:30");
    setWindowEnd("23:00");
    setSelectedSensors([]);
    setSensorPickerOpen(false);
    setSaveError(null);
    setModalOpen(true);
  }

  function openEditModal(greenhouse: GreenhouseConfig) {
    setEditingId(greenhouse.id);
    setName(greenhouse.name);
    setPhaseStart(greenhouse.phaseStart);
    setPhaseEnd(greenhouse.phaseEnd);
    setWindowStart(greenhouse.windowStart);
    setWindowEnd(greenhouse.windowEnd);
    setSelectedSensors(greenhouse.sensorIds);
    setSensorPickerOpen(false);
    setSaveError(null);
    setModalOpen(true);
  }

  function toggleSensor(id: string) {
    setSelectedSensors(current => (current.includes(id) ? current.filter(value => value !== id) : [...current, id]));
  }

  function closeModal() {
    if (saving) return;
    setModalOpen(false);
    setSensorPickerOpen(false);
    setEditingId(null);
    setName("");
    setPhaseStart("");
    setPhaseEnd("");
    setWindowStart("18:30");
    setWindowEnd("23:00");
    setSelectedSensors([]);
    setSaveError(null);
  }

  async function refreshSensors() {
    if (sensorRefreshing) return;
    setSensorRefreshing(true);
    try {
      const known = await knownSensorIds();
      let live: string[] = [];
      try {
        const latest = await getDashboardSummary();
        live = Array.from(new Set(latest.readings.map(r => r.sensor_id).filter(Boolean)));
      } catch {
        // Pi unreachable: fall back to sensors Supabase already knows about.
      }
      setDetectedSensors(mergeSensorIds(live, known));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to refresh sensors");
    } finally {
      setSensorRefreshing(false);
    }
  }

  async function confirmGreenhouse() {
    if (!name.trim() || !selectedSensors.length || !phaseStart || !phaseEnd || !windowStart || !windowEnd || saving) return;
    setSaving(true);
    setSaveError(null);
    const id = editingId ?? `greenhouse-${Date.now()}`;
    const config = {
      id,
      name: name.trim(),
      sensor_ids: selectedSensors,
      phase_start: phaseStart,
      phase_end: phaseEnd,
      window_start: windowStart,
      window_end: windowEnd
    };

    try {
      const saved = await saveGreenhouse(config);
      const current = readLocalConfigs();
      const next = editingId
        ? current.map(item => item.id === saved.id ? toLocalConfig(saved) : item)
        : [...current.filter(item => item.id !== saved.id), toLocalConfig(saved)];
      localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
      setGreenhouses(next);
      window.dispatchEvent(new Event("lpmas-greenhouse-config-updated"));
      await logActivity(editingId ? "UPDATE_GREENHOUSE" : "CREATE_GREENHOUSE", "greenhouses", saved.id, {
        name: saved.name,
        sensor_count: selectedSensors.length,
        phase_start: phaseStart,
        phase_end: phaseEnd,
        window_start: windowStart,
        window_end: windowEnd
      });
      setModalOpen(false);
      setSensorPickerOpen(false);
      setEditingId(null);
      setName("");
      setPhaseStart("");
      setPhaseEnd("");
      setWindowStart("18:30");
      setWindowEnd("23:00");
      setSelectedSensors([]);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save greenhouse configuration");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteGreenhouse(id: string) {
    const greenhouse = greenhouses.find(item => item.id === id);
    if (!greenhouse || deletingId) return;

    const confirmed = window.confirm(
      `Delete "${greenhouse.name}"? Its configuration will be moved to the Recycle Bin and its sensors freed for reassignment.`
    );
    if (!confirmed) return;

    setDeletingId(id);
    try {
      await deleteGreenhouse(id);
      const next = greenhouses.filter(item => item.id !== id);
      setGreenhouses(next);
      localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event("lpmas-greenhouse-config-updated"));
      await logActivity("DELETE_GREENHOUSE", "greenhouses", id, { name: greenhouse.name });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to delete greenhouse");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">GREENHOUSE MANAGEMENT</h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">Manage greenhouses, real sensors and illumination monitoring windows.</p>
        </div>
        <button onClick={openAddModal} className="rounded-xl bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] px-4 py-2.5 text-sm font-semibold text-[var(--foreground)] ring-1 ring-[color-mix(in_srgb,var(--accent)_28%,transparent)]">
          + Add Greenhouse
        </button>
      </div>

      <Card>
        <div className="flex items-center gap-3">
          <Sprout size={20} className="text-[var(--accent)]" />
          <h2 className="font-bold text-[var(--foreground)]">GREENHOUSE UNDER MONITORING</h2>
        </div>
        {greenhouses.length ? (
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {greenhouses.map(g => (
              <div key={g.id} className="overflow-hidden rounded-xl border border-white/[0.07] bg-black/[0.08]">
                <div className="p-4">
                  <p className="font-semibold text-[var(--foreground)]">{g.name}</p>
                  <div className="mt-3 space-y-1.5 text-xs text-[var(--muted-foreground)]">
                    <p>Illumination: {g.phaseStart} → {g.phaseEnd}</p>
                    <p>Window: {g.windowStart} → {g.windowEnd}</p>
                    <p>Sensors: {g.sensorIds.length ? g.sensorIds.join(", ") : "—"}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 border-t border-white/[0.07]">
                  <button onClick={() => openEditModal(g)} type="button" className="px-4 py-3 text-sm font-semibold text-[var(--accent)] transition hover:bg-white/[0.04]">
                    EDIT
                  </button>
                  <button onClick={() => handleDeleteGreenhouse(g.id)} type="button" disabled={deletingId === g.id} className="border-l border-white/[0.07] px-4 py-3 text-sm font-semibold text-red-400 transition hover:bg-red-500/[0.05] disabled:opacity-50">
                    {deletingId === g.id ? "DELETING..." : "DELETE"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-5 rounded-xl border border-dashed border-metal-700 p-10 text-center text-sm text-[var(--muted-foreground)]">No greenhouse records available.</div>
        )}
      </Card>

      {modalOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4 backdrop-blur-sm">
          <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] p-6 text-[var(--foreground)] shadow-2xl ring-1 ring-[color-mix(in_srgb,var(--accent)_12%,transparent)] backdrop-blur-3xl">
            <div className="relative flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">{editingId ? "EDIT CONFIGURATION" : "CONFIGURE GREENHOUSE"}</h2>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">Set dates, monitoring time and assign real detected sensors.</p>
              </div>
              <button onClick={closeModal} disabled={saving} className="rounded-lg p-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-50"><X size={19} /></button>
            </div>
            <div className="relative mt-6 space-y-5">
              <label className="block">
                <span className="mb-2 block text-sm font-medium">Greenhouse Name</span>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Enter greenhouse name"
                  className="w-full rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-3 text-sm outline-none ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,var(--border))]"
                />
              </label>

              <div>
                <p className="mb-2 text-sm font-medium">Illumination Phase Dates</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label>
                    <span className="mb-2 block text-xs text-[var(--muted-foreground)]">Start date</span>
                    <input type="date" value={phaseStart} onChange={e => setPhaseStart(e.target.value)} className="w-full rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-3 text-sm outline-none ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,var(--border))]" />
                  </label>
                  <label>
                    <span className="mb-2 block text-xs text-[var(--muted-foreground)]">End date</span>
                    <input type="date" value={phaseEnd} onChange={e => setPhaseEnd(e.target.value)} className="w-full rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-3 text-sm outline-none ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,var(--border))]" />
                  </label>
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">Monitoring Time Window</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label>
                    <span className="mb-2 block text-xs text-[var(--muted-foreground)]">Start</span>
                    <input type="time" value={windowStart} onChange={e => setWindowStart(e.target.value)} className="w-full rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-3 text-sm outline-none ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,var(--border))]" />
                  </label>
                  <label>
                    <span className="mb-2 block text-xs text-[var(--muted-foreground)]">End</span>
                    <input type="time" value={windowEnd} onChange={e => setWindowEnd(e.target.value)} className="w-full rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-3 text-sm outline-none ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,var(--border))]" />
                  </label>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">Sensor</p>
                  <button onClick={refreshSensors} disabled={sensorRefreshing} type="button" className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-[var(--accent)] ring-1 ring-[color-mix(in_srgb,var(--accent)_22%,transparent)]">
                    <RefreshCw size={13} className={sensorRefreshing ? "animate-spin" : ""} />
                    Refresh
                  </button>
                </div>
                <div className="relative">
                  <button onClick={() => setSensorPickerOpen(v => !v)} type="button" className="flex w-full items-center justify-between rounded-xl bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-4 py-3 text-left text-sm ring-1 ring-[color-mix(in_srgb,var(--accent)_18%,transparent)]">
                    <span>{selectedSensors.length ? `${selectedSensors.length} sensor${selectedSensors.length > 1 ? "s" : ""} selected` : "See Available Sensors"}</span>
                    <span className="text-[var(--accent)]">{sensorPickerOpen ? "▲" : "▼"}</span>
                  </button>
                  <div className={`absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-xl bg-[color-mix(in_srgb,var(--surface)_88%,transparent)] shadow-2xl ring-1 ring-[color-mix(in_srgb,var(--accent)_18%,transparent)] ${sensorPickerOpen ? "visible opacity-100" : "invisible opacity-0"}`}>
                    <div className="max-h-44 overflow-y-auto p-2">
                      {loading && !detectedSensors.length ? (
                        <div className="px-3 py-4 text-sm text-[var(--muted-foreground)]">Checking detected sensors...</div>
                      ) : availableSensors.length ? (
                        availableSensors.map(id => (
                          <label key={id} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-sm hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]">
                            <input type="checkbox" checked={selectedSensors.includes(id)} onChange={() => toggleSensor(id)} className="h-4 w-4 accent-[var(--accent)]" />
                            <span className="font-mono">{id}</span>
                          </label>
                        ))
                      ) : (
                        <div className="px-3 py-4 text-sm text-[var(--muted-foreground)]">No sensors have reported to the system yet</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {saveError && <p className="text-sm text-red-400">{saveError}</p>}
            </div>
            <div className="relative mt-7 flex justify-end gap-3">
              <button onClick={closeModal} disabled={saving} className="rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-2.5 text-sm font-medium text-[var(--muted-foreground)] disabled:opacity-50">Cancel</button>
              <button
                onClick={confirmGreenhouse}
                disabled={!name.trim() || !selectedSensors.length || !phaseStart || !phaseEnd || !windowStart || !windowEnd || saving}
                className="rounded-xl bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
              >
                {saving ? "Saving..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityLogsView() {
  const [userLogs, setUserLogs] = useState<ActivityLog[]>([]);
  const [userLoading, setUserLoading] = useState(true);
  const [userError, setUserError] = useState<string | null>(null);
  const [greenhouses, setGreenhouses] = useState<GreenhouseConfig[]>([]);
  const [range, setRange] = useState("24h");
  const firstLoad = useRef(true);

  const [rawLogs, setRawLogs] = useState<Reading[]>([]);
  const [rawLoading, setRawLoading] = useState(true);
  const [rawError, setRawError] = useState<string | null>(null);

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportStart, setExportStart] = useState("");
  const [exportEnd, setExportEnd] = useState("");
  const [exportFormat, setExportFormat] = useState<"csv" | "pdf">("csv");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    getGreenhouses()
      .then(rows => {
        const configs = rows.map(toLocalConfig);
        setGreenhouses(configs);
        localStorage.setItem(CONFIG_KEY, JSON.stringify(configs));
      })
      .catch(() => setGreenhouses(readLocalConfigs()));
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!supabase) {
        setUserError("Supabase is not configured.");
        setUserLoading(false);
        return;
      }
      if (firstLoad.current) setUserLoading(true);
      const { data: logs, error } = await supabase
        .from("activity_logs")
        .select("id, username, action, resource, resource_id, details, created_at")
        .eq("role", "manager")
        .neq("action", "NAVIGATE")
        .order("created_at", { ascending: false });
      if (!active) return;
      if (error) setUserError(error.message);
      else {
        setUserLogs((logs ?? []) as ActivityLog[]);
        setUserError(null);
      }
      setUserLoading(false);
      firstLoad.current = false;
    }
    load();
    const interval = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const rangeStart = useMemo(() => {
    const now = Date.now();
    if (range === "today") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    if (range === "7d") return new Date(now - 7 * 86400000).toISOString();
    return new Date(now - 86400000).toISOString();
  }, [range]);

  const greenhouseNameById = useMemo(() => {
    const map = new Map<string, string>();
    greenhouses.forEach(g => map.set(g.id, g.name));
    return map;
  }, [greenhouses]);

  function greenhouseLabel(id: string | null) {
    if (!id) return "Unassigned";
    return greenhouseNameById.get(id) ?? id;
  }

  // All sensor readings, any greenhouse or none, any active status — this
  // table intentionally shows everything, unlike the aggregates table used
  // to.
  useEffect(() => {
    let active = true;
    async function loadRaw() {
      setRawLoading(true);
      try {
        const result = await getHardwareActivity(undefined, [], rangeStart, new Date().toISOString());
        if (active) {
          setRawLogs(result.readings);
          setRawError(null);
        }
      } catch (error) {
        if (active) setRawError(error instanceof Error ? error.message : "Unable to load hardware logs");
      } finally {
        if (active) setRawLoading(false);
      }
    }
    loadRaw();
    return () => {
      active = false;
    };
  }, [rangeStart]);

  function openExportModal() {
    const now = new Date();
    setExportStart(toDatetimeLocal(rangeStart));
    setExportEnd(toDatetimeLocal(now.toISOString()));
    setExportFormat("csv");
    setExportError(null);
    setExportModalOpen(true);
  }

  function closeExportModal() {
    if (exportBusy) return;
    setExportModalOpen(false);
  }

  async function runExport() {
    if (!exportStart || !exportEnd || exportBusy) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const startISO = new Date(exportStart).toISOString();
      const endISO = new Date(exportEnd).toISOString();
      const result = await getHardwareActivity(undefined, [], startISO, endISO);
      const headers = ["Timestamp", "Greenhouse", "Sensor ID", "Lux", "Phase", "Classification"];
      const rows = result.readings.map(r => [new Date(r.recorded_at).toLocaleString(), greenhouseLabel(r.greenhouse_id), r.sensor_id, r.lux.toFixed(2), r.phase_type, r.classification]);
      if (exportFormat === "csv") downloadCSV("system-hardware-logs.csv", headers, rows);
      else downloadPDF("system-hardware-logs.pdf", headers, rows, "System Hardware Logs", buildLuxTrendChartImage(result.readings));
      await logActivity("EXPORT_HARDWARE_ACTIVITY_LOG", "activity_logs", undefined, {
        start: startISO,
        end: endISO,
        format: exportFormat,
        readings: result.readings.length
      });
      setExportModalOpen(false);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Unable to export hardware logs");
    } finally {
      setExportBusy(false);
    }
  }

  async function downloadUserCSV() {
    const headers = ["Timestamp", "Username", "Action Taken"];
    const rows = userLogs.map(log => [new Date(log.created_at).toLocaleString(), log.username ?? "Unknown", log.action]);
    downloadCSV("manager-user-activity-logs.csv", headers, rows);
    await logActivity("EXPORT_ACTIVITY_LOGS", "activity_logs", undefined, { scope: "manager", format: "csv" });
  }

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">ACTIVITY LOGS</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">Review real hardware readings and manager-level system activity.</p>
      </div>

      <Card>
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-bold text-[var(--foreground)]">SYSTEM HARDWARE LOGS</h2>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">All sensor readings for the selected time range, regardless of greenhouse assignment or active status. Downloads pull the same raw data from the Raspberry Pi's SQLite database for the date range you choose.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={range} onChange={e => setRange(e.target.value)} className="min-w-[150px] rounded-xl border border-[color-mix(in_srgb,var(--accent)_32%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))] px-3 py-2 text-sm font-medium text-[var(--foreground)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)]">
              <option value="today">Today</option>
              <option value="24h">Last 24h</option>
              <option value="7d">Last 7d</option>
            </select>
            <button onClick={openExportModal} type="button" className="flex items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-3.5 py-2 text-sm font-medium">
              <Download size={16} />
              Download
            </button>
          </div>
        </div>

        <div className="max-h-[360px] overflow-y-auto overflow-x-auto">
          <table className="w-full table-fixed text-sm leading-5">
            <thead className="sticky top-0 border-b border-metal-700 bg-[var(--surface)] text-metal-400">
              <tr>
                <th className="w-[18%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Timestamp</th>
                <th className="w-[17%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Greenhouse</th>
                <th className="w-[15%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Sensor ID</th>
                <th className="w-[12%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Lux</th>
                <th className="w-[19%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Phase</th>
                <th className="w-[19%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Classification</th>
              </tr>
            </thead>
            <tbody>
              {rawLogs.length ? rawLogs.map(r => (
                <tr key={r.id} className="border-b border-metal-700 last:border-0">
                  <td className="px-4 py-3.5 text-center align-middle text-sm text-metal-400">{new Date(r.recorded_at).toLocaleString()}</td>
                  <td className="px-4 py-3.5 text-center align-middle text-sm text-metal-300">{greenhouseLabel(r.greenhouse_id)}</td>
                  <td className="px-4 py-3.5 text-center align-middle font-mono text-xs text-metal-400">{r.sensor_id}</td>
                  <td className="px-4 py-3.5 text-center align-middle font-mono text-sm font-semibold text-metal-100">{r.lux.toFixed(2)}</td>
                  <td className="px-4 py-3.5 text-center align-middle text-sm text-metal-400">{r.phase_type}</td>
                  <td className="px-4 py-3.5 text-center align-middle">
                    <Badge tone={r.classification === "safe" ? "green" : r.classification === "warning" ? "amber" : "red"}>{r.classification}</Badge>
                  </td>
                </tr>
              )) : (
                <EmptyRow colSpan={6} text={rawLoading ? "Loading hardware logs..." : rawError ? "Unable to load hardware logs" : "No readings recorded yet for this range"} />
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-bold text-[var(--foreground)]">USER ACTIVITY LOGS</h2>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">Manager-level actions performed in the system.</p>
          </div>
          <button onClick={downloadUserCSV} disabled={userLoading || !userLogs.length} className="flex shrink-0 items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-3.5 py-2 text-sm font-medium disabled:opacity-50">
            <Download size={16} />
            Download CSV
          </button>
        </div>
        {userLoading ? (
          <div className="grid min-h-56 place-items-center text-sm text-[var(--muted-foreground)]">Loading manager activity logs...</div>
        ) : userError && !userLogs.length ? (
          <div className="grid min-h-56 place-items-center text-center text-sm text-red-400">Unable to load user activity logs.<br />{userError}</div>
        ) : userLogs.length ? (
          <div className="w-full overflow-x-auto rounded-2xl border border-white/[0.07] bg-black/[0.08]">
            <table className="w-full table-fixed text-sm leading-5">
              <colgroup>
                <col className="w-[38%]" />
                <col className="w-[25%]" />
                <col className="w-[37%]" />
              </colgroup>
              <thead className="border-b border-metal-700 bg-[var(--surface)]">
                <tr>
                  <th className="px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Timestamp</th>
                  <th className="px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Username</th>
                  <th className="px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Action Taken</th>
                </tr>
              </thead>
              <tbody>
                {userLogs.map(log => (
                  <tr key={log.id} className="border-b border-metal-700 last:border-0">
                    <td className="px-4 py-3.5 text-center align-middle text-sm text-metal-400">{new Date(log.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3.5 text-center align-middle text-sm text-metal-300">{log.username ?? "Unknown"}</td>
                    <td className="px-4 py-3.5 text-center align-middle">{actionBadge(log.action)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid min-h-56 place-items-center text-sm text-[var(--muted-foreground)]">No manager activity logs available.</div>
        )}
      </Card>

      {exportModalOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4 backdrop-blur-sm">
          <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] p-6 text-[var(--foreground)] shadow-2xl ring-1 ring-[color-mix(in_srgb,var(--accent)_12%,transparent)] backdrop-blur-3xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">EXPORT HARDWARE LOGS</h2>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">Pulls raw readings from SQLite on the Raspberry Pi for the chosen date and time range.</p>
              </div>
              <button onClick={closeExportModal} className="rounded-lg p-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"><X size={19} /></button>
            </div>
            <div className="mt-6 space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <label>
                  <span className="mb-2 block text-xs text-[var(--muted-foreground)]">From</span>
                  <input
                    type="datetime-local"
                    value={exportStart}
                    onChange={e => setExportStart(e.target.value)}
                    className="w-full rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-3 text-sm outline-none ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,var(--border))]"
                  />
                </label>
                <label>
                  <span className="mb-2 block text-xs text-[var(--muted-foreground)]">To</span>
                  <input
                    type="datetime-local"
                    value={exportEnd}
                    onChange={e => setExportEnd(e.target.value)}
                    className="w-full rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-3 text-sm outline-none ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,var(--border))]"
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-2 block text-xs text-[var(--muted-foreground)]">Format</span>
                <select
                  value={exportFormat}
                  onChange={e => setExportFormat(e.target.value as "csv" | "pdf")}
                  className="w-full rounded-xl border border-[color-mix(in_srgb,var(--accent)_32%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))] px-4 py-3 text-sm font-medium text-[var(--foreground)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)]"
                >
                  <option value="csv">CSV</option>
                  <option value="pdf">PDF</option>
                </select>
              </label>
              {exportError && <p className="text-sm text-red-400">{exportError}</p>}
            </div>
            <div className="mt-7 flex justify-end gap-3">
              <button onClick={closeExportModal} className="rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-2.5 text-sm font-medium text-[var(--muted-foreground)]">Cancel</button>
              <button
                onClick={runExport}
                disabled={!exportStart || !exportEnd || exportBusy}
                className="rounded-xl bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
              >
                {exportBusy ? "Exporting..." : "Export"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function downloadCSV(filename: string, headers: string[], rows: string[][]) {
  const escapeCSV = (value: string) => `"${String(value).replace(/\r?\n|\r/g, " ").replace(/"/g, '""')}"`;
  const content = [["sep=,", ""], headers, ...rows].map(row => row.map(escapeCSV).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadPDF(filename: string, headers: string[], rows: string[][], title: string, chartDataUrl?: string | null) {
  const doc = new jsPDF();
  doc.setFontSize(13);
  doc.text(title, 14, 15);
  let startY = 22;
  if (chartDataUrl) {
    const imgWidth = 180;
    const imgHeight = (LUX_TREND_CHART_HEIGHT / LUX_TREND_CHART_WIDTH) * imgWidth;
    doc.addImage(chartDataUrl, "PNG", 14, startY, imgWidth, imgHeight);
    startY += imgHeight + 8;
  }
  autoTable(doc, { head: [headers], body: rows, startY, styles: { fontSize: 8 } });
  doc.save(filename);
}

const LUX_TREND_CHART_WIDTH = 900;
const LUX_TREND_CHART_HEIGHT = 300;

// Renders a calculated lux trend (average across all sensors in the export,
// bucketed so it stays readable regardless of how long the chosen date range
// is) to a PNG data URL, so it can be embedded directly as an image in the
// exported PDF rather than just a table of numbers.
function buildLuxTrendChartImage(readings: { recorded_at: string; lux: number }[]): string | null {
  if (!readings.length) return null;

  const canvas = document.createElement("canvas");
  canvas.width = LUX_TREND_CHART_WIDTH;
  canvas.height = LUX_TREND_CHART_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, LUX_TREND_CHART_WIDTH, LUX_TREND_CHART_HEIGHT);

  const sorted = [...readings].sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
  const startTime = new Date(sorted[0].recorded_at).getTime();
  const endTime = new Date(sorted[sorted.length - 1].recorded_at).getTime();
  const span = Math.max(endTime - startTime, 1);

  const bucketCount = Math.max(1, Math.min(60, sorted.length));
  const bucketMs = span / bucketCount;
  const buckets: { sum: number; count: number }[] = Array.from({ length: bucketCount }, () => ({ sum: 0, count: 0 }));

  for (const reading of sorted) {
    const t = new Date(reading.recorded_at).getTime();
    const index = Math.min(bucketCount - 1, Math.floor((t - startTime) / bucketMs));
    buckets[index].sum += reading.lux;
    buckets[index].count += 1;
  }

  const points = buckets.map(b => (b.count ? b.sum / b.count : null));
  const knownPoints = points.filter((p): p is number => p !== null);
  if (!knownPoints.length) return null;

  const maxLux = Math.max(...knownPoints, 1);
  const minLux = Math.min(...knownPoints, 0);
  const paddingLeft = 46;
  const paddingRight = 20;
  const paddingTop = 26;
  const paddingBottom = 34;
  const plotWidth = LUX_TREND_CHART_WIDTH - paddingLeft - paddingRight;
  const plotHeight = LUX_TREND_CHART_HEIGHT - paddingTop - paddingBottom;

  ctx.strokeStyle = "#e5e7eb";
  ctx.fillStyle = "#6b7280";
  ctx.font = "11px sans-serif";
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = paddingTop + (plotHeight * i) / gridLines;
    ctx.beginPath();
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(LUX_TREND_CHART_WIDTH - paddingRight, y);
    ctx.stroke();
    const value = maxLux - ((maxLux - minLux) * i) / gridLines;
    ctx.fillText(value.toFixed(1), 6, y + 4);
  }

  ctx.strokeStyle = "#7c3aed";
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  points.forEach((value, i) => {
    if (value === null) return;
    const x = paddingLeft + (plotWidth * i) / (bucketCount - 1 || 1);
    const y = paddingTop + plotHeight - ((value - minLux) / (maxLux - minLux || 1)) * plotHeight;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  ctx.fillStyle = "#111827";
  ctx.font = "12px sans-serif";
  ctx.fillText("Average lux over time (all sensors)", paddingLeft, 16);
  ctx.fillText(new Date(startTime).toLocaleString(), paddingLeft, LUX_TREND_CHART_HEIGHT - 12);
  const endLabel = new Date(endTime).toLocaleString();
  ctx.fillText(endLabel, LUX_TREND_CHART_WIDTH - paddingRight - ctx.measureText(endLabel).width, LUX_TREND_CHART_HEIGHT - 12);

  return canvas.toDataURL("image/png");
}

function toDatetimeLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type RecycleBinEntry = {
  id: number;
  greenhouse_id: string;
  name: string;
  config: {
    phase_start?: string;
    phase_end?: string;
    window_start?: string;
    window_end?: string;
    sensor_ids?: string[];
  } | null;
  deleted_at: string;
};

function RecycleBinView() {
  const [entries, setEntries] = useState<RecycleBinEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!supabase) {
        if (active) {
          setError("Supabase is not configured.");
          setLoading(false);
        }
        return;
      }
      const { data, error } = await supabase
        .from("greenhouse_recycle_bin")
        .select("id, greenhouse_id, name, config, deleted_at")
        .order("deleted_at", { ascending: false });
      if (!active) return;
      if (error) setError(error.message);
      else {
        setEntries((data ?? []) as RecycleBinEntry[]);
        setError(null);
      }
      setLoading(false);
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  async function handleEmptyTrash() {
    if (!supabase || emptying || !entries.length) return;
    const confirmed = window.confirm(`Permanently delete ${entries.length} recycle bin ${entries.length === 1 ? "entry" : "entries"}? This cannot be undone.`);
    if (!confirmed) return;
    setEmptying(true);
    try {
      const { error } = await supabase.rpc("empty_greenhouse_recycle_bin");
      if (error) throw new Error(error.message);
      setEntries([]);
      await logActivity("EMPTY_RECYCLE_BIN", "greenhouse_recycle_bin");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to empty recycle bin");
    } finally {
      setEmptying(false);
    }
  }

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Recycle bin</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">Recently deleted greenhouse records.</p>
      </div>
      <Card>
        <div className="mb-5 flex items-start justify-end">
          <button
            onClick={handleEmptyTrash}
            type="button"
            disabled={emptying || !entries.length}
            className="flex items-center gap-2 rounded-xl bg-[color-mix(in_srgb,#ef4444_14%,transparent)] px-3.5 py-2 text-sm font-medium text-red-400 transition hover:bg-[color-mix(in_srgb,#ef4444_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={16} />
            {emptying ? "Emptying..." : "Empty Trash"}
          </button>
        </div>
        {loading ? (
          <div className="grid min-h-56 place-items-center text-sm text-[var(--muted-foreground)]">Loading recycle bin...</div>
        ) : error ? (
          <div className="grid min-h-56 place-items-center text-center text-sm text-red-400">Unable to load recycle bin.<br />{error}</div>
        ) : entries.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {entries.map(entry => (
              <div key={entry.id} className="rounded-xl border border-white/[0.07] bg-black/[0.08] p-4">
                <p className="font-semibold text-[var(--foreground)]">{entry.name}</p>
                <div className="mt-3 space-y-1.5 text-xs text-[var(--muted-foreground)]">
                  <p>Deleted: {new Date(entry.deleted_at).toLocaleString()}</p>
                  {entry.config?.phase_start && entry.config?.phase_end && (
                    <p>Illumination: {entry.config.phase_start} → {entry.config.phase_end}</p>
                  )}
                  {entry.config?.window_start && entry.config?.window_end && (
                    <p>Window: {entry.config.window_start} → {entry.config.window_end}</p>
                  )}
                  <p>Sensors: {entry.config?.sensor_ids?.length ? entry.config.sensor_ids.join(", ") : "—"}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex min-h-56 flex-col items-center justify-center text-center">
            <Recycle size={32} className="text-[var(--muted-foreground)]" />
            <p className="mt-3 text-sm text-[var(--muted-foreground)]">Recycle bin is empty.</p>
          </div>
        )}
      </Card>
    </div>
  );
}

function SummaryCard({ icon, label, value, danger = false }: { icon: React.ReactNode; label: string; value: number; danger?: boolean }) {
  return (
    <Card className="min-h-0">
      <div className="flex items-center gap-3">
        <span className="rounded-xl bg-white/[0.04] p-2 text-[var(--muted-foreground)]">{icon}</span>
        <div>
          <p className="text-sm text-[var(--muted-foreground)]">{label}</p>
          <p className={`mt-1 font-mono text-2xl font-bold ${danger ? "text-red-400" : "text-[var(--foreground)]"}`}>{value}</p>
        </div>
      </div>
    </Card>
  );
}

function ReportRow({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-metal-700 pb-3 last:border-0 last:pb-0">
      <span className="text-sm text-[var(--muted-foreground)]">{label}</span>
      <span className={`max-w-[65%] text-right font-mono text-sm font-semibold ${danger ? "text-red-400" : "text-[var(--foreground)]"}`}>{value}</span>
    </div>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-6 text-center text-sm text-[var(--muted-foreground)]">{text}</td>
    </tr>
  );
}