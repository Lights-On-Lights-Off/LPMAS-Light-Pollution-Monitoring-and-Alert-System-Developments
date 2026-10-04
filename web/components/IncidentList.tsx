"use client";
import { useEffect, useState } from "react";
import { Badge, Card } from "./ui";
import { acknowledgeIncident, type Reading } from "@/lib/api";
import { useDashboardData } from "@/lib/useDashboardData";
import { supabase } from "@/lib/supabase";
import { incidentOutcome } from "@/lib/monitoring-state";
type Job = {
  id: string;
  greenhouse_alert_uid: string;
  event: string;
  channel: string;
  recipient: string | null;
  attempted_at: string | null;
  status: string;
  attempts: number;
  detail: string | null;
};
export function IncidentList({ greenhouseId }: { greenhouseId: string }) {
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
      if (!active) return;
      if (result.error) setError("Notification outcomes unavailable.");
      else {
        setJobs(result.data ?? []);
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
        Three consecutive violation samples under the same configuration confirm
        a greenhouse alert. Recovery requires three fresh safe readings from every affected sensor. Sensor reports below keep their existing Pi lifecycle.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-theme-danger">{error}</p>
      )}
      <div className="mt-4 space-y-3">
        {episodes.map(episode => <article key={episode.incident_uid} className="rounded-xl border border-theme-border p-4">
          <p className="font-semibold text-theme-text">Greenhouse incident {episode.incident_uid.slice(0, 12)} · {episode.status}</p>
          <p className="mt-1 text-xs text-theme-muted">Opened {new Date(episode.opened_at).toLocaleString()}</p>
          {jobs.filter(job => job.greenhouse_alert_uid === episode.incident_uid).map(job => <div key={job.id} className="mt-2 text-sm text-theme-muted">
            <p>{job.event === "recovered" ? "Recovery" : "Opening"} {job.channel.toUpperCase()}: {job.status === "accepted" ? "Accepted by provider; recipient delivery unconfirmed" : job.status}</p>
            <p className="text-xs">{job.recipient || "Recipient unavailable"}{job.attempted_at ? ` · ${new Date(job.attempted_at).toLocaleString()}` : ""} · {job.attempts} sending attempt</p>
            {job.detail && <p className="text-xs">{job.detail}</p>}
          </div>)}
        </article>)}
        <p className="text-xs text-theme-muted">Opening and recovery attempts are recorded separately for SMS and email. Consumed attempts are never retried.</p>
      </div>
      <div className="mt-4 space-y-3">
        {incidents.slice(0, 30).map((i) => {
          const outcome = incidentOutcome(i);
          let trigger: Reading[] = [];
          try {
            trigger = typeof i.triggering_readings === "string"
              ? JSON.parse(i.triggering_readings)
              : i.triggering_readings ?? [];
          } catch {}
          return (
            <article
              key={i.incident_uid ?? i.id}
              className="rounded-xl border border-theme-border p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-theme-text">
                  {i.sensor_id} · {i.phase_type}
                </p>
                <Badge
                  tone={outcome.label === "closed" ? "amber" : i.status === "resolved"
                    ? "green"
                    : i.status === "acknowledged"
                    ? "amber"
                    : "red"}
                >
                  {outcome.label}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-theme-muted">
                Opened {new Date(i.opened_at).toLocaleString()}
                {i.resolved_at &&
                  ` · ${outcome.label === "closed" ? "Closed" : "Resolved"} ${new Date(i.resolved_at).toLocaleString()}`} ·
                {" "}
                {i.lowest_lux}–{i.peak_lux} lux
              </p>
              {outcome.detail && <p className="mt-1 text-sm text-theme-muted">{outcome.detail}</p>}
              {!!trigger.length && (
                <details className="mt-3 text-sm text-theme-muted">
                  <summary className="cursor-pointer">
                    Triggering samples
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {trigger.map((r, index) => (
                      <li key={index}>
                        {new Date(r.recorded_at).toLocaleTimeString()} · {r.lux}
                        {" "}
                        lux
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {i.status === "open" && (
                <button
                  disabled={busy !== null}
                  onClick={() => void acknowledge(i.id, i.incident_uid)}
                  className="mt-3 rounded-lg border border-theme-border px-3 py-2 text-sm font-semibold text-theme-text disabled:opacity-50"
                >
                  {busy === i.id ? "Acknowledging…" : "Acknowledge incident"}
                </button>
              )}
            </article>
          );
        })}
        {!incidents.length && (
          <p className="py-4 text-sm text-theme-muted">
            No incidents recorded for this greenhouse.
          </p>
        )}
      </div>
    </Card>
  );
}
