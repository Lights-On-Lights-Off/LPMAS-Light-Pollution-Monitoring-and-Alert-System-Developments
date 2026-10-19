"use client";
import { useEffect, useState } from "react";
import { Badge, Card } from "./ui";
import { acknowledgeIncident, type Reading } from "@/lib/api";
import { useDashboardData } from "@/lib/useDashboardData";
import { supabase } from "@/lib/supabase";
import { Modal } from "./Modal";
import { NotificationDetails, type NotificationJob as Job } from "./NotificationDetails";
import { averageReadings } from "@/lib/monitoring-state";
import { incidentOutcome } from "@/lib/monitoring-state";
export function IncidentList({ greenhouseId }: { greenhouseId: string }) {
  const [details, setDetails] = useState<{title: string; body: React.ReactNode} | null>(null);
  const [notificationEpisode,setNotificationEpisode]=useState<string|null>(null);
  const { data, refresh } = useDashboardData();
  const [episodes, setEpisodes] = useState<{incident_uid: string; status: string; opened_at: string}[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      if (!supabase) return;
      const alerts = await supabase.from("greenhouse_alerts").select("incident_uid,status,opened_at")
        .eq("greenhouse_id", greenhouseId).order("opened_at", {ascending: false}).limit(30);
      if (!active) return;
      if (alerts.error) { setError("Greenhouse alert outcomes unavailable."); return; }
      setEpisodes(alerts.data ?? []);
      const ids = (alerts.data ?? []).map(row => row.incident_uid);
      if (!ids.length) { setJobs([]); setError(null); return; }
      const result = await supabase.from("greenhouse_notification_jobs").select(
        "id,greenhouse_alert_uid,event,channel,status,attempts,recipient,attempted_at,detail",
      ).in("greenhouse_alert_uid", ids).order("created_at", {ascending: false}).limit(120).abortSignal(AbortSignal.timeout(10_000));
      const local = await supabase.from("local_sms_outcomes").select(
        "id,greenhouse_alert_uid,event,status,attempts,recipient,attempted_at,detail,send_number",
      ).in("greenhouse_alert_uid", ids).order("created_at", {ascending:false}).limit(120).abortSignal(AbortSignal.timeout(10_000));
      if (!active) return;
      if (result.error || local.error) setError("Notification outcomes unavailable.");
      else {
        setJobs([...(result.data ?? []), ...(local.data ?? []).map(row => ({...row, channel:"sms", source:"local"}))]);
        setError(null);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [greenhouseId]);
  async function acknowledge(id: number, uid?: string) {
    setBusy(id);
    setError(null);
    try {
      await acknowledgeIncident(id, uid);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Acknowledgement failed");
    } finally {
      setBusy(null);
    }
  }
  const incidents = data.incidents.filter((i) =>
    i.greenhouse_id === greenhouseId
  ).sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at));
  return (
    <Card>
      <h2 className="font-bold text-theme-text">Incidents and notifications</h2>
      <p className="mt-1 text-sm text-theme-muted">
        Review greenhouse alerts and sensor incidents. Select View Details for notification outcomes and incident history.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-theme-danger">{error}</p>
      )}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[700px] text-left text-sm">
          <thead className="border-b border-theme-border text-theme-muted"><tr>
            <th className="p-3">Greenhouse incident</th><th className="p-3">Opened</th><th className="p-3">Status</th><th className="p-3">Notifications</th>
          </tr></thead>
          <tbody>{episodes.map(episode => <tr key={episode.incident_uid} className="border-b border-theme-border">
            <td className="p-3 font-mono text-xs">{episode.incident_uid.slice(0,12)}</td>
            <td className="p-3">{new Date(episode.opened_at).toLocaleString()}</td>
            <td className="p-3 capitalize">{episode.status}</td>
            <td className="p-3"><button className="rounded-lg border border-theme-border px-3 py-2 font-semibold focus-visible:ring-2 focus-visible:ring-theme-accent" onClick={() => setNotificationEpisode(episode.incident_uid)}>View Details</button></td>
          </tr>)}{!episodes.length && <tr><td colSpan={4} className="p-5 text-center text-theme-muted">No greenhouse alerts recorded.</td></tr>}</tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-theme-muted">SMS and email outcomes are recorded separately. Pending emails remain queued after closure. Failed notifications can be resent manually from View Details.</p>
      <h3 className="mt-5 font-semibold text-theme-text">Sensor incidents</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="border-b border-theme-border text-theme-muted"><tr>
            <th className="p-3">Sensor</th><th className="p-3">Phase</th><th className="p-3">Opened</th><th className="p-3">Closed / resolved</th><th className="p-3">Status</th><th className="p-3">Actions</th>
          </tr></thead>
          <tbody>{incidents.slice(0,30).map(i => {
            const outcome = incidentOutcome(i);
            let trigger: Reading[] = [];
            try { trigger = averageReadings(typeof i.triggering_readings === "string" ? JSON.parse(i.triggering_readings) : i.triggering_readings ?? []); } catch {}
            return <tr key={i.incident_uid ?? i.id} className="border-b border-theme-border">
              <td className="p-3 font-mono text-xs">{i.sensor_id}</td><td className="p-3 capitalize">{i.phase_type}</td>
              <td className="p-3">{new Date(i.opened_at).toLocaleString()}</td><td className="p-3">{i.resolved_at ? new Date(i.resolved_at).toLocaleString() : "—"}</td>
              <td className="p-3"><Badge tone={i.status === "resolved" ? "green" : "amber"}>{outcome.label}</Badge></td>
              <td className="p-3"><div className="flex items-center gap-2">
                <button className="whitespace-nowrap rounded-lg border border-theme-border px-3 py-2 font-semibold focus-visible:ring-2 focus-visible:ring-theme-accent" onClick={() => setDetails({title: "Incident details", body: <div className="space-y-3 text-sm"><p>{i.reason || "Sensor incident"}</p>{outcome.detail && <p>{outcome.detail}</p>}{trigger.length > 0 && <div><p className="font-semibold">Triggering minute averages</p>{trigger.map((r,index) => <p key={index}>{new Date(r.recorded_at).toLocaleString()} · {r.lux.toFixed(2)} lux</p>)}</div>}</div>})}>View Details</button>
                {i.status === "open" && <button disabled={busy !== null} onClick={() => void acknowledge(i.id,i.incident_uid)} className="rounded-lg border border-theme-border px-3 py-2 font-semibold disabled:opacity-50">{busy === i.id ? "Acknowledging…" : "Acknowledge"}</button>}
              </div></td>
            </tr>;
          })}{!incidents.length && <tr><td colSpan={6} className="p-5 text-center text-theme-muted">No incidents recorded for this greenhouse.</td></tr>}</tbody>
        </table>
      </div>
      <Modal open={details !== null || notificationEpisode !== null} title={notificationEpisode ? "Notification details" : details?.title ?? "Incident details"} onClose={() => {setDetails(null);setNotificationEpisode(null);}} footer={<button className="rounded-lg border border-theme-border px-4 py-2" onClick={() => {setDetails(null);setNotificationEpisode(null);}}>Close</button>}>
        {notificationEpisode ? <NotificationDetails key={notificationEpisode} episodeId={notificationEpisode} jobs={jobs.filter(job => job.greenhouse_alert_uid === notificationEpisode)}/> : details?.body}
      </Modal>
    </Card>
  );
}
