"use client";
import { useEffect, useState } from "react";
import { Badge, Card } from "./ui";
import { acknowledgeIncident, type Reading } from "@/lib/api";
import { useDashboardData } from "@/lib/useDashboardData";
import { supabase } from "@/lib/supabase";
import { incidentOutcome } from "@/lib/monitoring-state";
type Job = {
  incident_uid: string;
  status: string;
  attempts: number;
  detail: string | null;
};
export function IncidentList({ greenhouseId }: { greenhouseId: string }) {
  const { data, refresh } = useDashboardData();
  const [jobs, setJobs] = useState<Job[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      if (!supabase) return;
      const result = await supabase.from("notification_jobs").select(
        "incident_uid,status,attempts,detail",
      ).order("updated_at", { ascending: false }).limit(100).abortSignal(
        AbortSignal.timeout(10_000),
      );
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
  }, []);
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
  async function retry(uid: string) {
    if (!supabase) return;
    const result = await supabase.rpc("retry_notification", {
      p_incident_uid: uid,
    });
    if (result.error) setError(result.error.message);
    else {
      setError(null);
      setJobs((current) =>
        current.map((j) =>
          j.incident_uid === uid
            ? {
              ...j,
              status: "pending",
              attempts: 0,
              detail: "Retry requested",
            }
            : j
        )
      );
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
        an incident. A safe reading resolves it; an ended monitoring context closes it.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-theme-danger">{error}</p>
      )}
      <div className="mt-4 space-y-3">
        {incidents.slice(0, 30).map((i) => {
          const outcome = incidentOutcome(i);
          const job = jobs.find((j) => j.incident_uid === i.incident_uid);
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
              <p className="mt-2 text-sm text-theme-muted">
                SMS: {job?.status === "accepted"
                  ? "Accepted by provider; handset delivery unconfirmed"
                  : job
                  ? `${job.status} (${job.attempts} attempts)`
                  : "Awaiting cloud synchronization"}
              </p>
              {job?.detail && job.status !== "accepted" && (
                <p className="mt-1 text-xs text-theme-muted">{job.detail}</p>
              )}
              {job?.status === "failed" && i.incident_uid && (
                <button
                  onClick={() => void retry(i.incident_uid!)}
                  className="mt-2 rounded-lg border border-theme-border px-3 py-2 text-sm font-semibold text-theme-text"
                >
                  Retry failed notification
                </button>
              )}
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
