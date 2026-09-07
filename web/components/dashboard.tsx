"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BellRing, Clock3, CloudSun, Radio, Settings, Activity, Users, CheckCircle2 } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { format, formatDistanceToNow } from "date-fns";
import { getDashboardSummary, acknowledgeIncident, type DashboardSummary, type Reading } from "@/lib/api";
import { demoData } from "@/lib/demo";
import { isConfigured, supabase } from "@/lib/supabase";
import { Badge, Card } from "./ui";
import { Sidebar } from "./sidebar";

const SENSOR_IDS = ["sensor1", "sensor2", "sensor3"];

export function Dashboard() {
  const [data, setData] = useState<DashboardSummary>(demoData);
  const [demo, setDemo] = useState(true);
  const [selectedSensor, setSelectedSensor] = useState("all");
  const [page, setPage] = useState("Dashboard");

  const refresh = () => getDashboardSummary().then(v => { setData(v); setDemo(false); });

  useEffect(() => {
    refresh().catch(() => setDemo(true));
    const interval = setInterval(() => refresh().catch(() => {}), 10_000); // poll the Pi every 10s
    return () => clearInterval(interval);
  }, []);

  const readings = useMemo(
    () => data.readings.filter(r => selectedSensor === "all" || r.sensor_id === selectedSensor),
    [data, selectedSensor]
  );

  const latestBySensor = useMemo(() => {
    const map = new Map<string, Reading>();
    for (const r of data.readings) {
      if (!map.has(r.sensor_id)) map.set(r.sensor_id, r);
    }
    return map;
  }, [data]);

  const chart = readings.slice().reverse().map(r => ({
    time: format(new Date(r.recorded_at), "HH:mm"),
    lux: Number(r.lux.toFixed(2))
  }));

  const open = data.incidents.filter(i => i.status !== "resolved");
  const phase = data.phase;

  return <div className="flex min-h-screen">
    <Sidebar active={page} onNavigate={setPage} />
    <main className="min-w-0 flex-1">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 md:px-8">
        <div>
          <p className="text-sm text-slate-500">Controlled environment monitoring</p>
          <h1 className="text-2xl font-bold">{page === "Dashboard" ? "Good evening, Flowerland" : page}</h1>
        </div>
        <div className="flex items-center gap-3">
          {demo && <Badge tone="amber">Demo data — Pi not reachable</Badge>}
          <select value={selectedSensor} onChange={e => setSelectedSensor(e.target.value)} className="text-sm">
            <option value="all">All sensors</option>
            {SENSOR_IDS.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
          <button className="relative rounded-xl border border-slate-200 p-2.5">
            <BellRing size={19}/>
            {open.length > 0 && <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-red-500 ring-2 ring-white"/>}
          </button>
        </div>
      </header>

      {page === "Dashboard" ? <div className="space-y-6 p-5 md:p-8">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={<CloudSun/>} label="Current light" value={`${readings.at(0)?.lux.toFixed(1) ?? "—"} lux`} note={phase ? phase.phase_type : "No active phase"} tone="green"/>
          <Metric icon={<Radio/>} label="Sensors reporting" value={String(latestBySensor.size)} note={`of ${SENSOR_IDS.length} configured`} tone="green"/>
          <Metric icon={<AlertTriangle/>} label="Open incidents" value={String(open.length)} note={open.length ? "Requires attention" : "All clear"} tone={open.length ? "red" : "green"}/>
          <Metric icon={<Clock3/>} label="Phase window" value={phase?.window_start ? `${phase.window_start}–${phase.window_end}` : "All night"} note={phase ? `${phase.starts_on} → ${phase.ends_on}` : "—"} tone="green"/>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
          <Card>
            <div className="mb-5 flex items-start justify-between">
              <div><h2 className="font-bold">Light intensity</h2><p className="mt-1 text-sm text-slate-500">Recent BH1750 readings{selectedSensor !== "all" ? ` · ${selectedSensor}` : ""}</p></div>
              <PhaseBadge lux={readings.at(0)?.lux} phase={phase}/>
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart}>
                  <defs><linearGradient id="lux" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#26a269" stopOpacity={.35}/><stop offset="95%" stopColor="#26a269" stopOpacity={0}/></linearGradient></defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0"/>
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} interval="preserveStartEnd"/>
                  <YAxis tick={{ fontSize: 11 }} width={35}/>
                  <Tooltip contentStyle={{ borderRadius: 12, borderColor: "#d8f3e3" }}/>
                  {phase?.phase_type === "illumination" && phase.lux_min != null && phase.lux_max != null &&
                    <ReferenceArea y1={phase.lux_min} y2={phase.lux_max} fill="#f59e0b" fillOpacity={0.08} />}
                  <Area type="monotone" dataKey="lux" stroke="#168454" strokeWidth={2.5} fill="url(#lux)"/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card>
            <h2 className="font-bold">Current phase</h2>
            {phase ? <div className="mt-6">
              <div className="mb-5 flex items-center gap-3">
                <span className="rounded-2xl bg-leaf-50 p-3 text-leaf-600"><CloudSun/></span>
                <div><p className="font-semibold capitalize">{phase.phase_type} phase</p><p className="text-sm text-slate-500">Greenhouse 3 · Chrysanthemum</p></div>
              </div>
              <div className="space-y-4 text-sm">
                <Row icon={<Clock3/>} label="Runs" value={`${phase.starts_on} → ${phase.ends_on}`}/>
                {phase.phase_type === "illumination"
                  ? <>
                      <Row icon={<CloudSun/>} label="Nightly window" value={`${phase.window_start} — ${phase.window_end}`}/>
                      <Row icon={<AlertTriangle/>} label="Target range" value={`${phase.lux_min} – ${phase.lux_max} lux`}/>
                    </>
                  : <Row icon={<AlertTriangle/>} label="Lux ceiling" value={`${phase.lux_ceiling ?? "—"} lux`}/>}
              </div>
            </div> : <p className="mt-6 text-sm text-slate-500">No phase currently configured.</p>}
          </Card>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
          <Card>
            <div className="mb-5 flex items-center justify-between"><div><h2 className="font-bold">Recent incidents</h2><p className="text-sm text-slate-500">Lux range / ceiling violations</p></div></div>
            <div className="space-y-3">
              {data.incidents.length === 0 && <p className="text-sm text-slate-500">No incidents recorded.</p>}
              {data.incidents.map(i => <div key={i.id} className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-100 p-4">
                <span className="rounded-xl bg-red-50 p-2.5 text-red-600"><AlertTriangle size={20}/></span>
                <div className="min-w-[180px] flex-1">
                  <p className="font-semibold">{i.sensor_id} · {reasonLabel(i.reason)}</p>
                  <p className="text-xs text-slate-500">{formatDistanceToNow(new Date(i.opened_at), { addSuffix: true })}</p>
                </div>
                <div className="text-right"><p className="font-semibold">{i.lowest_lux ?? i.peak_lux} lux</p><Badge tone={i.status === "acknowledged" ? "amber" : i.status === "resolved" ? "green" : "red"}>{i.status}</Badge></div>
                {i.status === "open" && <button onClick={() => acknowledgeIncident(i.id).then(refresh)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold">Acknowledge</button>}
              </div>)}
            </div>
          </Card>
          <Card>
            <h2 className="font-bold">Sensor status</h2>
            <div className="mt-5 space-y-3">
              {SENSOR_IDS.map(id => {
                const reading = latestBySensor.get(id);
                const online = reading && Date.now() - new Date(reading.recorded_at).getTime() < 60_000;
                return <div key={id} className="flex items-center gap-3 rounded-xl bg-slate-50 p-4">
                  <span className={`grid h-10 w-10 place-items-center rounded-xl ${online ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"}`}>{online ? <CheckCircle2 size={20}/> : <Radio size={20}/>}</span>
                  <div className="flex-1"><p className="font-semibold">{id}</p><p className="text-xs text-slate-500">{reading ? `${reading.lux.toFixed(1)} lux · ${reading.classification}` : "No data yet"}</p></div>
                  <Badge tone={online ? "green" : "slate"}>{online ? "Online" : "Offline"}</Badge>
                </div>;
              })}
            </div>
          </Card>
        </div>
      </div> : <SectionPage page={page} data={data} onAcknowledge={id => acknowledgeIncident(id).then(refresh)} />}
    </main>
  </div>;
}

function reasonLabel(reason: string) {
  if (reason === "below_minimum") return "below minimum lux";
  if (reason === "above_maximum") return "above maximum lux";
  if (reason === "ceiling_exceeded") return "ceiling exceeded";
  return reason;
}

function PhaseBadge({ lux, phase }: { lux?: number; phase: DashboardSummary["phase"] }) {
  if (lux == null || !phase) return <Badge tone="slate">No data</Badge>;
  if (phase.phase_type === "illumination") {
    const inRange = phase.lux_min != null && phase.lux_max != null && lux >= phase.lux_min && lux <= phase.lux_max;
    return <Badge tone={inRange ? "green" : "red"}>{inRange ? "Within target range" : "Out of range"}</Badge>;
  }
  const overCeiling = phase.lux_ceiling != null && lux > phase.lux_ceiling;
  return <Badge tone={overCeiling ? "red" : "green"}>{overCeiling ? "Ceiling exceeded" : "Within safe range"}</Badge>;
}

function SectionPage({ page, data, onAcknowledge }: { page: string; data: DashboardSummary; onAcknowledge: (id: number) => void }) {
  if (page === "Sensor readings") return <PageWrap title="Sensor readings" description="Latest measurements received from greenhouse devices.">
    <Card><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b text-slate-500"><tr><th className="p-3">Recorded</th><th className="p-3">Sensor</th><th className="p-3">Lux</th><th className="p-3">Classification</th></tr></thead><tbody>{data.readings.slice(0, 30).map(r => <tr key={r.id} className="border-b last:border-0"><td className="p-3">{format(new Date(r.recorded_at), "MMM d, HH:mm:ss")}</td><td className="p-3">{r.sensor_id}</td><td className="p-3 font-semibold">{r.lux.toFixed(2)}</td><td className="p-3"><Badge tone={r.classification === "violation" ? "red" : r.classification === "warning" ? "amber" : "green"}>{r.classification}</Badge></td></tr>)}</tbody></table></div></Card>
  </PageWrap>;

  if (page === "Incidents") return <PageWrap title="Incidents" description="Review and respond to detected lux violations.">
    <div className="grid gap-4">{data.incidents.map(i => <Card key={i.id} className="flex flex-wrap items-center gap-4"><span className="rounded-xl bg-red-50 p-3 text-red-600"><AlertTriangle/></span><div className="flex-1"><p className="font-bold">{i.sensor_id} · {reasonLabel(i.reason)}</p><p className="text-sm text-slate-500">{format(new Date(i.opened_at), "MMM d, yyyy · HH:mm:ss")} · {i.lowest_lux ?? i.peak_lux} lux</p></div><Badge tone={i.status === "acknowledged" ? "amber" : i.status === "resolved" ? "green" : "red"}>{i.status}</Badge>{i.status === "open" && <button onClick={() => onAcknowledge(i.id)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold">Acknowledge</button>}</Card>)}</div>
  </PageWrap>;

  if (page === "Team & roles") return <PageWrap title="Team & roles" description="Invite-based access is managed through Supabase Auth.">
    <div className="grid gap-4 md:grid-cols-3"><RoleCard icon={<Users/>} name="Admin" text="Manages users, phases, and all settings."/><RoleCard icon={<Activity/>} name="Manager" text="Manages phases, incidents, reports and monitoring rules."/><RoleCard icon={<CheckCircle2/>} name="Technician" text="Monitors readings and acknowledges or resolves incidents."/></div>
  </PageWrap>;

  return <PageWrap title="Settings" description="System defaults used by LPMAS monitoring.">
    <Card className="max-w-2xl"><div className="space-y-5"><Setting icon={<Clock3/>} label="Sensor reporting interval" value="5 seconds"/><Setting icon={<CloudSun/>} label="Active phase config" value={data.phase ? `${data.phase.phase_type} phase` : "None"}/><Setting icon={<BellRing/>} label="Alert channel" value="Dashboard (email planned)"/><Setting icon={<Settings/>} label="Timezone" value="Asia/Manila"/></div></Card>
  </PageWrap>;
}

function PageWrap({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="space-y-5 p-5 md:p-8"><div><h2 className="text-xl font-bold">{title}</h2><p className="mt-1 text-sm text-slate-500">{description}</p></div>{children}</div>;
}
function RoleCard({ icon, name, text }: { icon: React.ReactNode; name: string; text: string }) {
  return <Card><span className="inline-flex rounded-xl bg-leaf-50 p-3 text-leaf-600">{icon}</span><h3 className="mt-4 font-bold">{name}</h3><p className="mt-2 text-sm text-slate-500">{text}</p></Card>;
}
function Setting({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="flex items-center gap-3 border-b pb-4 last:border-0 last:pb-0"><span className="text-leaf-600">{icon}</span><span className="text-sm text-slate-500">{label}</span><span className="ml-auto text-sm font-semibold">{value}</span></div>;
}
function Metric({ icon, label, value, note, tone }: { icon: React.ReactNode; label: string; value: string; note: string; tone: "green" | "red" }) {
  return <Card className="flex items-start gap-4"><span className={`rounded-2xl p-3 ${tone === "red" ? "bg-red-50 text-red-600" : "bg-leaf-50 text-leaf-600"}`}>{icon}</span><div><p className="text-sm text-slate-500">{label}</p><p className="mt-1 text-2xl font-bold">{value}</p><p className="mt-1 text-xs text-slate-400">{note}</p></div></Card>;
}
function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="flex items-center gap-3 text-slate-500"><span className="text-leaf-600">{icon}</span><span>{label}</span><span className="ml-auto font-semibold text-ink">{value}</span></div>;
}
