"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, CircleAlert, Download, Gauge, Radio, Recycle, Sprout, Wifi, X } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import DataTable from "../DataTableClient";
import { Card, Badge } from "../ui";
import { useDashboardData } from "@/lib/useDashboardData";
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

function escapeHTML(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function actionBadge(action: string) {
  const value = escapeHTML(action);
  const tone = action === "SIGN_IN" || action === "SIGN_OUT" ? "green" : action.startsWith("EXPORT_") ? "purple" : action === "NAVIGATE" ? "blue" : "accent";
  const background = tone === "green" ? "color-mix(in_srgb,#22c55e_12%,transparent)" : tone === "purple" ? "color-mix(in_srgb,#a855f7_12%,transparent)" : tone === "blue" ? "color-mix(in_srgb,#3b82f6_12%,transparent)" : "color-mix(in_srgb,var(--accent)_12%,transparent)";
  const border = tone === "green" ? "color-mix(in_srgb,#22c55e_25%,transparent)" : tone === "purple" ? "color-mix(in_srgb,#a855f7_25%,transparent)" : tone === "blue" ? "color-mix(in_srgb,#3b82f6_25%,transparent)" : "color-mix(in_srgb,var(--accent)_25%,transparent)";
  const color = tone === "green" ? "#4ade80" : tone === "purple" ? "#c084fc" : tone === "blue" ? "#60a5fa" : "var(--accent)";
  return `<span style="display:inline-flex;align-items:center;gap:7px;border-radius:9999px;padding:5px 10px;background:${background};border:1px solid ${border};color:${color};font-size:11px;font-weight:700;letter-spacing:.04em;line-height:1">${value}</span>`;
}

export function ManagerView({ section = "Overview" }: { section?: ManagerSection }) {
  const { data, loading, error } = useDashboardData();

  if (section === "Greenhouses") return <GreenhousesView />;
  if (section === "Activity Logs") return <ActivityLogsView />;
  if (section === "Recycle bin" || section === "Recycle Bin") return <RecycleBinView />;

  return <OverviewView data={data} loading={loading} error={error} />;
}

function OverviewView({ data, loading, error }: { data: ReturnType<typeof useDashboardData>["data"]; loading: boolean; error: string | null }) {
  const readings = useMemo(() => [...data.readings].sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()), [data.readings]);

  const latestBySensor = useMemo(() => {
    const map = new Map<string, typeof data.readings[number]>();
    for (const reading of readings) {
      const current = map.get(reading.sensor_id);
      if (!current || new Date(reading.recorded_at).getTime() > new Date(current.recorded_at).getTime()) map.set(reading.sensor_id, reading);
    }
    return map;
  }, [readings]);

  const sensors = Array.from(latestBySensor.values());
  const onlineSensors = sensors.filter(reading => Date.now() - new Date(reading.recorded_at).getTime() < 60_000).length;
  const openIncidents = data.incidents.filter(incident => incident.status !== "resolved").length;
  const activePhases = data.phase?.is_active ? 1 : 0;

  const chartData = useMemo(() => readings.slice(-30).map(reading => ({
    time: new Date(reading.recorded_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    lux: reading.lux
  })), [readings]);

  const recentActivities = [...readings].reverse().slice(0, 5);
  const warnings = [...readings].reverse().filter(reading => reading.classification !== "safe").slice(0, 5);
  const systemOnline = !error && !loading;

  return <div className="space-y-6 p-6 md:p-8">
    <div className="flex items-center justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold text-metal-50">Monitor Overview</h1>
        <p className="mt-1 text-sm text-metal-400">Real-time greenhouse monitoring and system status.</p>
      </div>
      <div className="flex items-center gap-2 text-xs text-metal-400">
        <span className={`h-2.5 w-2.5 rounded-full ${systemOnline ? "bg-leaf-500 shadow-glow" : "bg-red-400"}`} />
        {systemOnline ? "System online" : "System unavailable"}
      </div>
    </div>

    <div className="grid gap-5 md:grid-cols-3">
      <SummaryCard icon={<Radio size={18} />} label="Sensors Reporting" value={onlineSensors} />
      <SummaryCard icon={<CircleAlert size={18} />} label="Open Incidents" value={openIncidents} danger={openIncidents > 0} />
      <SummaryCard icon={<Gauge size={18} />} label="Active Phases" value={activePhases} />
    </div>

    <div className="grid items-stretch gap-5 xl:grid-cols-[1.7fr_1fr]">
      <Card className="min-h-[28rem]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-bold text-metal-50">Lux Intensity Trend</h2>
            <p className="mt-1 text-sm text-metal-400">Recent readings from connected sensors.</p>
          </div>
          <Activity size={19} className="text-metal-500" />
        </div>
        <div className="mt-6 h-80">
          {chartData.length ? <ResponsiveContainer width="100%" height="100%">
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
          </ResponsiveContainer> : <div className="grid h-full place-items-center text-sm text-metal-500">{loading ? "Waiting for live sensor data..." : "No sensor data available"}</div>}
        </div>
      </Card>

      <Card className="min-h-[28rem]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-bold text-metal-50">Weekly Report</h2>
            <p className="mt-1 text-sm text-metal-400">Current monitoring summary.</p>
          </div>
          <CheckCircle2 size={19} className="text-metal-500" />
        </div>
        <div className="mt-6 space-y-5">
          <ReportRow label="Total readings" value={readings.length.toString()} />
          <ReportRow label="Sensors detected" value={latestBySensor.size.toString()} />
          <ReportRow label="Online sensors" value={onlineSensors.toString()} />
          <ReportRow label="Warnings" value={readings.filter(reading => reading.classification === "warning").length.toString()} />
          <ReportRow label="Violations" value={readings.filter(reading => reading.classification === "violation").length.toString()} />
          <ReportRow label="Open incidents" value={openIncidents.toString()} danger={openIncidents > 0} />
        </div>
        {data.phase && <div className="mt-6 rounded-xl border border-metal-700 bg-white/[0.02] p-4">
          <p className="text-xs text-metal-500">Current phase</p>
          <p className="mt-1 font-semibold text-metal-100">{data.phase.phase_type === "illumination" ? "Illumination" : "Dark"}</p>
          {data.phase.window_start && data.phase.window_end && <p className="mt-1 text-xs text-metal-400">{data.phase.window_start} - {data.phase.window_end}</p>}
        </div>}
      </Card>
    </div>

    <div className="grid gap-5 xl:grid-cols-3">
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-bold text-metal-50">Recent Activities</h2>
          <Activity size={17} className="text-metal-500" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-metal-700 text-metal-400">
              <tr><th className="p-3">Greenhouse</th><th className="p-3">Sensor</th><th className="p-3">Lux</th></tr>
            </thead>
            <tbody>
              {recentActivities.length ? recentActivities.map(reading => <tr key={reading.id} className="border-b border-metal-700 last:border-0">
                <td className="p-3 text-metal-300">—</td>
                <td className="p-3 font-mono text-metal-400">{reading.sensor_id}</td>
                <td className="p-3 font-mono font-semibold text-metal-100">{reading.lux.toFixed(2)}</td>
              </tr>) : <EmptyRow colSpan={3} text="No recent activities" />}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-bold text-metal-50">Sensor Status Summary</h2>
          <Wifi size={17} className="text-metal-500" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-metal-700 text-metal-400">
              <tr><th className="p-3">Sensor ID</th><th className="p-3">Status</th></tr>
            </thead>
            <tbody>
              {sensors.length ? sensors.map(reading => {
                const online = Date.now() - new Date(reading.recorded_at).getTime() < 60_000;
                return <tr key={reading.sensor_id} className="border-b border-metal-700 last:border-0">
                  <td className="p-3 font-mono text-metal-400">{reading.sensor_id}</td>
                  <td className="p-3"><Badge tone={online ? "green" : "red"}>{online ? "Online" : "Offline"}</Badge></td>
                </tr>;
              }) : <EmptyRow colSpan={2} text="No sensors detected" />}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-bold text-metal-50">Warnings</h2>
          <AlertTriangle size={17} className="text-metal-500" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-metal-700 text-metal-400">
              <tr><th className="p-3">Greenhouse</th><th className="p-3">Sensor</th><th className="p-3">Timestamp</th></tr>
            </thead>
            <tbody>
              {warnings.length ? warnings.map(reading => <tr key={reading.id} className="border-b border-metal-700 last:border-0">
                <td className="p-3 text-metal-300">—</td>
                <td className="p-3 font-mono text-metal-400">{reading.sensor_id}</td>
                <td className="p-3 text-metal-400">{new Date(reading.recorded_at).toLocaleString()}</td>
              </tr>) : <EmptyRow colSpan={3} text="No warnings" />}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  </div>;
}

function GreenhousesView() {
  const { data, loading } = useDashboardData();
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [phaseStart, setPhaseStart] = useState("");
  const [phaseEnd, setPhaseEnd] = useState("");
  const [selectedSensors, setSelectedSensors] = useState<string[]>([]);
  const [sensorPickerOpen, setSensorPickerOpen] = useState(false);

  const detectedSensors = useMemo(() => Array.from(new Set(data.readings.map(reading => reading.sensor_id).filter(Boolean))), [data.readings]);

  function toggleSensor(sensorId: string) {
    setSelectedSensors(current => current.includes(sensorId) ? current.filter(id => id !== sensorId) : [...current, sensorId]);
  }

  function closeModal() {
    setModalOpen(false);
    setSensorPickerOpen(false);
    setName("");
    setPhaseStart("");
    setPhaseEnd("");
    setSelectedSensors([]);
  }

  function confirmGreenhouse() {
    closeModal();
  }

  return <div className="space-y-6 p-6 md:p-8">
    <div className="flex items-center justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">GREENHOUSE MANAGEMENT</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">Manage greenhouses under monitoring.</p>
      </div>
      <button onClick={() => setModalOpen(true)} className="rounded-xl bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] px-4 py-2.5 text-sm font-semibold text-[var(--foreground)] ring-1 ring-[color-mix(in_srgb,var(--accent)_28%,transparent)] shadow-lg backdrop-blur-xl transition hover:bg-[color-mix(in_srgb,var(--accent)_24%,transparent)] hover:ring-[color-mix(in_srgb,var(--accent)_38%,transparent)]">
        + Add Greenhouse
      </button>
    </div>

    <Card>
      <div className="flex items-center gap-3">
        <Sprout size={20} className="text-[var(--accent)]" />
        <h2 className="font-bold text-[var(--foreground)]">GREENHOUSES UNDER MONITORING</h2>
      </div>
      <div className="mt-5 rounded-xl border border-dashed border-metal-700 p-10 text-center text-sm text-metal-500">No greenhouse records available.</div>
    </Card>

    {modalOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] p-6 text-[var(--foreground)] shadow-2xl ring-1 ring-[color-mix(in_srgb,var(--accent)_12%,transparent)] backdrop-blur-3xl backdrop-saturate-150">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[var(--accent)]/[0.06] via-transparent to-[var(--accent)]/[0.02]" />

        <div className="relative flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">CONFIGURE GREENHOUSE</h2>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">Set the greenhouse monitoring configuration.</p>
          </div>
          <button onClick={closeModal} className="rounded-lg p-2 text-[var(--muted-foreground)] transition hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] hover:text-[var(--foreground)]">
            <X size={19} />
          </button>
        </div>

        <div className="relative mt-6 space-y-5">
          <div>
            <label className="mb-2 block text-sm font-medium text-[var(--foreground)]">Greenhouse Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Enter greenhouse name" className="w-full rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-3 text-sm text-[var(--foreground)] outline-none ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,var(--border))] backdrop-blur-xl transition placeholder:text-[var(--muted-foreground)] focus:bg-[color-mix(in_srgb,var(--accent)_7%,var(--surface))] focus:ring-2 focus:ring-[var(--accent)]/35" />
          </div>

          <div>
            <p className="mb-2 block text-sm font-medium text-[var(--foreground)]">Date: Phase 1</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-2 block text-xs text-[var(--muted-foreground)]">Start</label>
                <input type="datetime-local" value={phaseStart} onChange={e => setPhaseStart(e.target.value)} className="w-full rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-3 text-sm text-[var(--foreground)] outline-none ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,var(--border))] backdrop-blur-xl transition focus:bg-[color-mix(in_srgb,var(--accent)_7%,var(--surface))] focus:ring-2 focus:ring-[var(--accent)]/35" />
              </div>
              <div>
                <label className="mb-2 block text-xs text-[var(--muted-foreground)]">End</label>
                <input type="datetime-local" value={phaseEnd} onChange={e => setPhaseEnd(e.target.value)} className="w-full rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-3 text-sm text-[var(--foreground)] outline-none ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,var(--border))] backdrop-blur-xl transition focus:bg-[color-mix(in_srgb,var(--accent)_7%,var(--surface))] focus:ring-2 focus:ring-[var(--accent)]/35" />
              </div>
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-[var(--foreground)]">Illumination Phase</p>
            <div className="rounded-xl bg-[color-mix(in_srgb,var(--surface)_45%,transparent)] p-4 text-sm text-[var(--muted-foreground)] ring-1 ring-[color-mix(in_srgb,var(--accent)_10%,var(--border))] backdrop-blur-xl">Phase 1 configuration</div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-[var(--foreground)]">Sensor</p>
            <div className="relative">
              <button onClick={() => setSensorPickerOpen(current => !current)} className="flex w-full items-center justify-between rounded-xl bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-4 py-3 text-left text-sm text-[var(--foreground)] ring-1 ring-[color-mix(in_srgb,var(--accent)_18%,transparent)] backdrop-blur-xl transition hover:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]">
                <span>{selectedSensors.length ? `${selectedSensors.length} sensor${selectedSensors.length > 1 ? "s" : ""} selected` : "See Available Sensors"}</span>
                <span className="text-[var(--accent)]">{sensorPickerOpen ? "▲" : "▼"}</span>
              </button>

              <div className={`absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-xl bg-[color-mix(in_srgb,var(--surface)_88%,transparent)] shadow-2xl ring-1 ring-[color-mix(in_srgb,var(--accent)_18%,transparent)] backdrop-blur-3xl backdrop-saturate-150 transition ${sensorPickerOpen ? "visible opacity-100" : "invisible opacity-0"}`}>
                <div className="max-h-44 overflow-y-auto p-2">
                  {loading ? <div className="px-3 py-4 text-sm text-[var(--muted-foreground)]">Checking detected sensors...</div> : detectedSensors.length ? detectedSensors.map(sensorId => <label key={sensorId} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-sm text-[var(--foreground)] transition hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]">
                    <input type="checkbox" checked={selectedSensors.includes(sensorId)} onChange={() => toggleSensor(sensorId)} className="h-4 w-4 accent-[var(--accent)]" />
                    <span className="font-mono">{sensorId}</span>
                  </label>) : <div className="px-3 py-4 text-sm text-[var(--muted-foreground)]">Sensor unavailable</div>}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="relative mt-7 flex justify-end gap-3">
          <button onClick={closeModal} className="rounded-xl bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] px-4 py-2.5 text-sm font-medium text-[var(--muted-foreground)] ring-1 ring-[color-mix(in_srgb,var(--accent)_12%,var(--border))] backdrop-blur-xl transition hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] hover:text-[var(--foreground)]">
            Cancel
          </button>
          <button onClick={confirmGreenhouse} className="rounded-xl bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] px-5 py-2.5 text-sm font-semibold text-[var(--foreground)] ring-1 ring-[color-mix(in_srgb,var(--accent)_28%,transparent)] shadow-lg backdrop-blur-xl transition hover:bg-[color-mix(in_srgb,var(--accent)_24%,transparent)]">
            Confirm
          </button>
        </div>
      </div>
    </div>}
  </div>;
}

function ActivityLogsView() {
  const { data, loading: hardwareLoading, error: hardwareError } = useDashboardData();
  const [userLogs, setUserLogs] = useState<ActivityLog[]>([]);
  const [userLoading, setUserLoading] = useState(true);
  const [userError, setUserError] = useState<string | null>(null);
  const firstLoad = useRef(true);

  const hardwareLogs = useMemo(() => [...data.readings].reverse(), [data.readings]);

  useEffect(() => {
    let active = true;

    async function loadUserLogs() {
      if (!supabase) {
        if (active) {
          setUserError("Supabase is not configured.");
          setUserLoading(false);
        }
        return;
      }

      if (firstLoad.current) {
        setUserLoading(true);
        setUserError(null);
      }

      const { data: logs, error } = await supabase
        .from("activity_logs")
        .select("id, username, action, resource, resource_id, details, created_at")
        .eq("role", "manager")
        .order("created_at", { ascending: false });

      if (!active) return;

      if (error) {
        console.error("[manager activity logs]", error);
        setUserError(error.message);
      } else {
        setUserLogs((logs ?? []) as ActivityLog[]);
        setUserError(null);
      }

      setUserLoading(false);
      firstLoad.current = false;
    }

    loadUserLogs();

    const interval = setInterval(loadUserLogs, 5000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const userTableData = useMemo(() => userLogs.map(log => [
    new Date(log.created_at).toLocaleString(),
    log.username ?? "Unknown",
    log.action
  ]), [userLogs]);

  const userTableOptions = useMemo(() => ({
    pageLength: 10,
    autoWidth: false,
    order: [[0, "desc"]],
    language: {
      search: "Search:",
      searchPlaceholder: "Search username, action or resource..."
    },
    layout: {
      topStart: "search",
      topEnd: null,
      bottomStart: "info",
      bottomEnd: "paging"
    },
    columns: [
      { title: "Timestamp", width: "33.33%" },
      { title: "Username", width: "33.33%" },
      { title: "Action Taken", width: "33.34%", render: (value: string, type: string) => type === "display" ? actionBadge(value) : value }
    ]
  }), []);

  function downloadHardwareCSV() {
    const headers = ["Timestamp", "Greenhouse", "Sensor", "Lux", "Status"];
    const rows = hardwareLogs.map(reading => [
      new Date(reading.recorded_at).toLocaleString(),
      "—",
      reading.sensor_id,
      reading.lux.toFixed(2),
      reading.classification
    ]);
    downloadCSV("system-hardware-logs.csv", headers, rows);
  }

  async function downloadUserCSV() {
    await logActivity("EXPORT_ACTIVITY_LOGS", "activity_logs", undefined, { scope: "manager", format: "csv" });

    const headers = ["Timestamp", "Username", "Action Taken"];
    const rows = userLogs.map(log => [
      new Date(log.created_at).toLocaleString(),
      log.username ?? "Unknown",
      log.action
    ]);

    downloadCSV("manager-user-activity-logs.csv", headers, rows);
  }

  return <div className="space-y-6 p-6 md:p-8">
    <div>
      <h1 className="text-2xl font-bold text-[var(--foreground)]">ACTIVITY LOGS</h1>
      <p className="mt-1 text-sm text-[var(--muted-foreground)]">Review manager-level system activity and user actions.</p>
    </div>

    <Card>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-bold text-[var(--foreground)]">SYSTEM HARDWARE LOGS</h2>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">Lux readings received from connected sensors.</p>
        </div>
        <button onClick={downloadHardwareCSV} className="flex shrink-0 items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-3.5 py-2 text-sm font-medium text-[var(--foreground)] ring-1 ring-[color-mix(in_srgb,var(--accent)_22%,transparent)] backdrop-blur-xl transition hover:bg-[color-mix(in_srgb,var(--accent)_18%,transparent)]">
          <Download size={16} />
          Download CSV
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-metal-700 text-metal-400">
            <tr><th className="p-3">Timestamp</th><th className="p-3">Greenhouse</th><th className="p-3">Sensor</th><th className="p-3">Lux</th><th className="p-3">Status</th></tr>
          </thead>
          <tbody>
            {hardwareLogs.length ? hardwareLogs.map(reading => <tr key={reading.id} className="border-b border-metal-700 last:border-0">
              <td className="p-3 text-metal-400">{new Date(reading.recorded_at).toLocaleString()}</td>
              <td className="p-3 text-metal-300">—</td>
              <td className="p-3 font-mono text-metal-400">{reading.sensor_id}</td>
              <td className="p-3 font-mono font-semibold text-metal-100">{reading.lux.toFixed(2)}</td>
              <td className="p-3"><Badge tone={reading.classification === "safe" ? "green" : "red"}>{reading.classification}</Badge></td>
            </tr>) : <EmptyRow colSpan={5} text={hardwareLoading ? "Waiting for live hardware logs..." : hardwareError ? "Unable to load hardware logs" : "No hardware logs available"} />}
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
        <button onClick={downloadUserCSV} disabled={userLoading || !userLogs.length} className="flex shrink-0 items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-3.5 py-2 text-sm font-medium text-[var(--foreground)] ring-1 ring-[color-mix(in_srgb,var(--accent)_22%,transparent)] backdrop-blur-xl transition hover:bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] disabled:cursor-not-allowed disabled:opacity-50">
          <Download size={16} />
          Download CSV
        </button>
      </div>

      {userLoading ? <div className="grid min-h-56 place-items-center text-sm text-[var(--muted-foreground)]">Loading manager activity logs...</div> : userError && !userLogs.length ? <div className="grid min-h-56 place-items-center text-center text-sm text-red-400">Unable to load user activity logs.<br />{userError}</div> : userLogs.length ? <div className="w-full overflow-x-auto rounded-2xl border border-white/[0.07] bg-black/[0.08] p-1 [&_.dt-container]:w-full [&_.dt-container]:text-[var(--foreground)] [&_.dt-layout-row]:!my-0 [&_.dt-layout-row:first-child]:!mb-4 [&_.dt-layout-row:last-child]:!mt-3 [&_.dt-layout-cell]:!p-0 [&_.dt-search]:!flex [&_.dt-search]:!items-center [&_.dt-search]:!gap-2 [&_.dt-search]:!m-0 [&_.dt-search_label]:!text-xs [&_.dt-search_label]:!font-medium [&_.dt-search_label]:!text-[var(--muted-foreground)] [&_.dt-search_input]:!m-0 [&_.dt-search_input]:!h-10 [&_.dt-search_input]:!w-[min(100%,360px)] [&_.dt-search_input]:!rounded-xl [&_.dt-search_input]:!border [&_.dt-search_input]:!border-white/10 [&_.dt-search_input]:!bg-white/[0.035] [&_.dt-search_input]:!px-3.5 [&_.dt-search_input]:!text-sm [&_.dt-search_input]:!text-[var(--foreground)] [&_.dt-search_input]:!shadow-inner [&_.dt-search_input]:!outline-none [&_.dt-search_input]:!backdrop-blur-xl [&_.dt-search_input]:placeholder:!text-[var(--muted-foreground)] [&_.dt-search_input]:focus:!border-[color-mix(in_srgb,var(--accent)_40%,transparent)] [&_.dt-search_input]:focus:!bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] [&_table]:!m-0 [&_table]:!w-full [&_table]:!table-fixed [&_thead]:!border-0 [&_thead_th]:!border-b [&_thead_th]:!border-white/[0.08] [&_thead_th]:!bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] [&_thead_th]:!px-4 [&_thead_th]:!py-3.5 [&_thead_th]:!text-center [&_thead_th]:!text-[11px] [&_thead_th]:!font-bold [&_thead_th]:!uppercase [&_thead_th]:!tracking-[0.08em] [&_thead_th]:!text-[var(--muted-foreground)] [&_tbody_tr]:!border-b [&_tbody_tr]:!border-white/[0.055] [&_tbody_tr]:!transition-colors [&_tbody_tr:hover]:!bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] [&_tbody_tr:last-child]:!border-b-0 [&_tbody_td]:!border-0 [&_tbody_td]:!px-5 [&_tbody_td]:!py-3.5 [&_tbody_td]:!text-center [&_tbody_td]:!text-[13px] [&_tbody_td]:!leading-5 [&_tbody_td:nth-child(1)]:!font-mono [&_tbody_td:nth-child(1)]:!text-[12px] [&_tbody_td:nth-child(1)]:!text-[var(--muted-foreground)] [&_tbody_td:nth-child(2)]:!font-medium [&_tbody_td:nth-child(2)]:!text-[var(--foreground)] [&_tbody_td:nth-child(3)]:!text-center [&_.dt-info]:!px-2 [&_.dt-info]:!text-xs [&_.dt-info]:!text-[var(--muted-foreground)] [&_.dt-paging]:!px-2 [&_.dt-paging_button]:!m-0 [&_.dt-paging_button]:!rounded-lg [&_.dt-paging_button]:!border-0 [&_.dt-paging_button]:!bg-transparent [&_.dt-paging_button]:!px-2.5 [&_.dt-paging_button]:!py-1.5 [&_.dt-paging_button]:!text-xs [&_.dt-paging_button]:!text-[var(--muted-foreground)] [&_.dt-paging_button:hover]:!bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] [&_.dt-paging_button.current]:!bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] [&_.dt-paging_button.current]:!text-[var(--foreground)] [&_.dt-paging_button.current]:!ring-1 [&_.dt-paging_button.current]:!ring-[color-mix(in_srgb,var(--accent)_28%,transparent)] [&_.dt-paging_button.disabled]:!opacity-30 [&_.dt-paging_button.disabled:hover]:!bg-transparent">
        <DataTable data={userTableData} className="display w-full" options={userTableOptions} />
      </div> : <div className="grid min-h-56 place-items-center text-sm text-[var(--muted-foreground)]">No manager activity logs available.</div>}
    </Card>
  </div>;
}

function downloadCSV(filename: string, headers: string[], rows: string[][]) {
  const escapeCSV = (value: string) => `"${value.replace(/"/g, "\"\"")}"`;
  const content = [headers, ...rows].map(row => row.map(escapeCSV).join(",")).join("\r\n");
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function RecycleBinView() {
  return <div className="space-y-6 p-6 md:p-8">
    <div>
      <h1 className="text-2xl font-bold text-metal-50">Recycle Bin</h1>
      <p className="mt-1 text-sm text-metal-400">Recently deleted greenhouse records.</p>
    </div>
    <Card>
      <div className="flex min-h-56 flex-col items-center justify-center text-center">
        <Recycle size={32} className="text-metal-500" />
        <p className="mt-3 text-sm text-metal-500">Recycle bin is empty.</p>
      </div>
    </Card>
  </div>;
}

function SummaryCard({ icon, label, value, danger = false }: { icon: React.ReactNode; label: string; value: number; danger?: boolean }) {
  return <Card className="min-h-0">
    <div className="flex items-center gap-3">
      <span className="rounded-xl bg-white/[0.04] p-2 text-metal-400">{icon}</span>
      <div>
        <p className="text-sm text-metal-400">{label}</p>
        <p className={`mt-1 font-mono text-2xl font-bold ${danger ? "text-red-400" : "text-metal-50"}`}>{value}</p>
      </div>
    </div>
  </Card>;
}

function ReportRow({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return <div className="flex items-center justify-between border-b border-metal-700 pb-3 last:border-0 last:pb-0">
    <span className="text-sm text-metal-400">{label}</span>
    <span className={`font-mono font-semibold ${danger ? "text-red-400" : "text-metal-100"}`}>{value}</span>
  </div>;
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return <tr><td colSpan={colSpan} className="p-6 text-center text-sm text-metal-500">{text}</td></tr>;
}