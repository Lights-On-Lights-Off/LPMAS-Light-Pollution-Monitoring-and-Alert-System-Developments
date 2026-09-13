"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CircleAlert, Download, Gauge, Radio, Recycle, RefreshCw, Sprout, Wifi, X } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { Card, Badge } from "../ui";
import { useDashboardData } from "@/lib/useDashboardData";
import { getDashboardSummary, getGreenhouses, getHardwareActivity, saveGreenhouse, type Greenhouse, type MinuteAggregate } from "@/lib/api";
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

function OverviewView({ data, loading, error }: { data: ReturnType<typeof useDashboardData>["data"]; loading: boolean; error: string | null }) {
  const [reportRefreshing, setReportRefreshing] = useState(false);
  const [greenhouseConfigs, setGreenhouseConfigs] = useState<GreenhouseConfig[]>([]);
  const [selectedGreenhouse, setSelectedGreenhouse] = useState("");
  const [history, setHistory] = useState<MinuteAggregate[]>([]);

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
  const availableSensors = Array.from(latestBySensor.keys()).filter(id => !greenhouseConfigs.some(g => g.sensorIds.includes(id)));
  const selectedConfig = greenhouseConfigs.find(g => g.id === selectedGreenhouse);
  const assignedIds = selectedConfig?.sensorIds ?? [];
  const onlineSensorCount = assignedIds.filter(id => {
    const reading = latestBySensor.get(id);
    return !!reading && Date.now() - new Date(reading.recorded_at).getTime() < 60_000;
  }).length;
  const openIncidents = data.incidents.filter(i => i.status !== "resolved" && (!selectedConfig || assignedIds.includes(i.sensor_id))).length;
  const warningReads = readings.filter(r => r.classification === "warning").length;
  const systemOnline = !error && !loading;
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
        <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <span className={`h-2.5 w-2.5 rounded-full ${systemOnline ? "bg-leaf-500 shadow-glow" : "bg-red-400"}`} />
          {systemOnline ? "System online" : "System unavailable"}
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
              <h2 className="font-bold text-[var(--foreground)]">Lux Intensity Trend</h2>
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
                {!greenhouseConfigs.length ? "No Greenhouse Configured" : loading ? "Waiting for live sensor data..." : "No sensor data available"}
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

  useEffect(() => {
    const load = async () => {
      try {
        const remote = await getGreenhouses();
        const configs = remote.map(toLocalConfig);
        setGreenhouses(configs);
        setDetectedSensors(Array.from(new Set(data.readings.map(r => r.sensor_id).filter(Boolean))));
        if (remote.length) localStorage.setItem(CONFIG_KEY, JSON.stringify(configs));
      } catch {
        const local = readLocalConfigs();
        setGreenhouses(local);
        setDetectedSensors(Array.from(new Set(data.readings.map(r => r.sensor_id).filter(Boolean))));
      }
    };
    load();
  }, [data.readings]);

  const availableSensors = detectedSensors.filter(id => !greenhouses.some(g => g.sensorIds.includes(id) && g.id !== editingId) || selectedSensors.includes(id));

  function openAddModal() {
    setEditingId(null);
    setName("");
    setPhaseStart("");
    setPhaseEnd("");
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
      const latest = await getDashboardSummary();
      setDetectedSensors(Array.from(new Set(latest.readings.map(r => r.sensor_id).filter(Boolean))));
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

  function deleteGreenhouseLocal(id: string) {
    const greenhouse = greenhouses.find(item => item.id === id);
    if (!greenhouse) return;

    const confirmed = window.confirm(
      `Remove "${greenhouse.name}" from this browser's configured greenhouse list?\n\nThe current backend does not expose a DELETE greenhouse endpoint, so this does not delete the Raspberry Pi configuration.`
    );
    if (!confirmed) return;

    const next = greenhouses.filter(item => item.id !== id);
    setGreenhouses(next);
    localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event("lpmas-greenhouse-config-updated"));
    void logActivity("REMOVE_GREENHOUSE_FROM_LOCAL_LIST", "greenhouses", id, { name: greenhouse.name });
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
                  <button onClick={() => deleteGreenhouseLocal(g.id)} type="button" className="border-l border-white/[0.07] px-4 py-3 text-sm font-semibold text-red-400 transition hover:bg-red-500/[0.05]">
                    DELETE
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
                        <div className="px-3 py-4 text-sm text-[var(--muted-foreground)]">Sensor unavailable</div>
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
  const { data, loading: hardwareLoading, error: hardwareError } = useDashboardData();
  const [userLogs, setUserLogs] = useState<ActivityLog[]>([]);
  const [userLoading, setUserLoading] = useState(true);
  const [userError, setUserError] = useState<string | null>(null);
  const [greenhouses, setGreenhouses] = useState<GreenhouseConfig[]>([]);
  const [selectedGreenhouse, setSelectedGreenhouse] = useState("");
  const [range, setRange] = useState("24h");
  const [hardwareLogs, setHardwareLogs] = useState(data.readings);
  const [hardwareBusy, setHardwareBusy] = useState(false);
  const firstLoad = useRef(true);

  const [aggregates, setAggregates] = useState<MinuteAggregate[]>([]);

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
        setSelectedGreenhouse(configs[0]?.id ?? "");
        localStorage.setItem(CONFIG_KEY, JSON.stringify(configs));
      })
      .catch(() => {
        const configs = readLocalConfigs();
        setGreenhouses(configs);
        setSelectedGreenhouse(configs[0]?.id ?? "");
      });
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

  const selected = greenhouses.find(g => g.id === selectedGreenhouse);
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

  useEffect(() => {
    let active = true;
    async function loadHardware() {
      if (!selected) {
        setHardwareLogs([]);
        return;
      }
      setHardwareBusy(true);
      try {
        const result = await getHardwareActivity(selected.id, selected.sensorIds, rangeStart, new Date().toISOString());
        if (active) setHardwareLogs(result.readings);
      } catch {
        if (active) setHardwareLogs([]);
      } finally {
        if (active) setHardwareBusy(false);
      }
    }
    loadHardware();
    return () => {
      active = false;
    };
  }, [selectedGreenhouse, rangeStart, selected?.sensorIds.join(",")]);

  useEffect(() => {
    let active = true;
    async function loadAggregates() {
      if (!supabase || !selected) {
        setAggregates([]);
        return;
      }
      const { data: rows, error } = await supabase
        .from("sensor_minute_aggregates")
        .select("id, sensor_id, greenhouse_id, bucket_start, phase_type, sample_count, avg_lux, min_lux, max_lux, safe_count, warning_count, violation_count, updated_at")
        .eq("greenhouse_id", selected.id)
        .gte("bucket_start", rangeStart)
        .order("bucket_start", { ascending: true });
      if (!active) return;
      setAggregates(error ? [] : ((rows ?? []) as MinuteAggregate[]));
    }
    loadAggregates();
    return () => {
      active = false;
    };
  }, [selectedGreenhouse, rangeStart, selected?.id]);

  function aggregateFor(sensorId: string, recordedAt: string) {
    const minute = new Date(recordedAt);
    minute.setSeconds(0, 0);
    const match = aggregates.find(a => a.sensor_id === sensorId && new Date(a.bucket_start).getTime() === minute.getTime());
    return match ? match.avg_lux.toFixed(2) : "—";
  }



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
    if (!selected || !exportStart || !exportEnd || exportBusy) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const startISO = new Date(exportStart).toISOString();
      const endISO = new Date(exportEnd).toISOString();
      const result = await getHardwareActivity(selected.id, selected.sensorIds, startISO, endISO);
      const headers = ["Timestamp", "Greenhouse", "Sensor ID", "Lux", "Phase", "Classification"];
      const rows = result.readings.map(r => [new Date(r.recorded_at).toLocaleString(), selected.name, r.sensor_id, r.lux.toFixed(2), r.phase_type, r.classification]);
      if (exportFormat === "csv") downloadCSV(`system-hardware-logs-${selected.name}.csv`, headers, rows);
      else downloadPDF(`system-hardware-logs-${selected.name}.pdf`, headers, rows, `System Hardware Logs — ${selected.name}`);
      await logActivity("EXPORT_HARDWARE_ACTIVITY_LOG", "activity_logs", undefined, {
        greenhouse_id: selected.id,
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
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">Raw 10-second readings from SQLite, matched against 1-minute Supabase aggregates, for the selected greenhouse and time range.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={selectedGreenhouse} onChange={e => setSelectedGreenhouse(e.target.value)} className="min-w-[150px] rounded-xl border border-[color-mix(in_srgb,var(--accent)_32%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))] px-3 py-2 text-sm font-medium text-[var(--foreground)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)]">
              <option value="">No Greenhouse</option>
              {greenhouses.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
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
                <th className="w-[16%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Timestamp</th>
                <th className="w-[14%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Greenhouse</th>
                <th className="w-[13%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Sensor ID</th>
                <th className="w-[10%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Lux</th>
                <th className="w-[19%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Avg Lux</th>
                <th className="w-[14%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Phase</th>
                <th className="w-[14%] px-4 py-3.5 text-center align-middle text-xs font-semibold tracking-wide text-metal-300">Classification</th>
              </tr>
            </thead>
            <tbody>
              {hardwareLogs.length ? hardwareLogs.map(r => (
                <tr key={r.id} className="border-b border-metal-700 last:border-0">
                  <td className="px-4 py-3.5 text-center align-middle text-sm text-metal-400">{new Date(r.recorded_at).toLocaleString()}</td>
                  <td className="px-4 py-3.5 text-center align-middle text-sm text-metal-300">{selected?.name ?? "—"}</td>
                  <td className="px-4 py-3.5 text-center align-middle font-mono text-xs text-metal-400">{r.sensor_id}</td>
                  <td className="px-4 py-3.5 text-center align-middle font-mono text-sm font-semibold text-metal-100">{r.lux.toFixed(2)}</td>
                  <td className="px-4 py-3.5 text-center align-middle font-mono text-xs text-metal-400">{aggregateFor(r.sensor_id, r.recorded_at)}</td>
                  <td className="px-4 py-3.5 text-center align-middle text-sm text-metal-400">{r.phase_type}</td>
                  <td className="px-4 py-3.5 text-center align-middle">
                    <Badge tone={r.classification === "safe" ? "green" : r.classification === "warning" ? "amber" : "red"}>{r.classification}</Badge>
                  </td>
                </tr>
              )) : (
                <EmptyRow colSpan={7} text={hardwareLoading || hardwareBusy ? "Waiting for real hardware readings..." : hardwareError ? "Unable to load hardware logs" : "No hardware logs available"} />
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
              {!selected && <p className="text-sm text-amber-400">Select a greenhouse above first.</p>}
              {exportError && <p className="text-sm text-red-400">{exportError}</p>}
            </div>
            <div className="mt-7 flex justify-end gap-3">
              <button onClick={closeExportModal} className="rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-2.5 text-sm font-medium text-[var(--muted-foreground)]">Cancel</button>
              <button
                onClick={runExport}
                disabled={!selected || !exportStart || !exportEnd || exportBusy}
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

function downloadPDF(filename: string, headers: string[], rows: string[][], title: string) {
  const doc = new jsPDF();
  doc.setFontSize(13);
  doc.text(title, 14, 15);
  autoTable(doc, { head: [headers], body: rows, startY: 20, styles: { fontSize: 8 } });
  doc.save(filename);
}

function toDatetimeLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function RecycleBinView() {
  return (
    <div className="space-y-6 p-6 md:p-8">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Recycle bin</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">Recently deleted greenhouse records.</p>
      </div>
      <Card>
        <div className="flex min-h-56 flex-col items-center justify-center text-center">
          <Recycle size={32} className="text-[var(--muted-foreground)]" />
          <p className="mt-3 text-sm text-[var(--muted-foreground)]">Recycle bin is empty.</p>
        </div>
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