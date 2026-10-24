"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { incidentTone, Badge, Card } from "./ui";
import { acknowledgeIncident, type Incident, type Reading } from "@/lib/api";
import { useDashboardData } from "@/lib/useDashboardData";
import { supabase } from "@/lib/supabase";
import { Modal, modalButtonClass } from "./Modal";
import { NotificationDetails, type NotificationJob as Job } from "./NotificationDetails";
import { averageReadings } from "@/lib/monitoring-state";
import { incidentOutcome } from "@/lib/monitoring-state";
export function IncidentList({ greenhouseId }: { greenhouseId: string }) {
  const [details, setDetails] = useState<Incident | null>(null);
  const [acknowledgeTarget, setAcknowledgeTarget] = useState<Incident | null>(null);
  const [description, setDescription] = useState("");
  const [acknowledgeError, setAcknowledgeError] = useState<string | null>(null);
  const [savedIncidents, setSavedIncidents] = useState<Record<string, Incident>>({});
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
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
      const ids = notificationEpisode ? [notificationEpisode] : (alerts.data ?? []).map(row => row.incident_uid);
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
  }, [greenhouseId, notificationEpisode]);
  function closeAcknowledge() {
    if (!submitting.current) setAcknowledgeTarget(null);
  }
  async function acknowledge(event: FormEvent) {
    event.preventDefault();
    if (!acknowledgeTarget || submitting.current) return;
    const value = description.trim();
    if (!value || value.length > 2000) {
      setAcknowledgeError("Enter a description of what happened (1–2000 characters).");
      descriptionRef.current?.focus();
      return;
    }
    submitting.current = true;
    setBusy(acknowledgeTarget.id);
    setAcknowledgeError(null);
    try {
      const saved = await acknowledgeIncident(acknowledgeTarget.id, value, acknowledgeTarget.incident_uid);
      setSavedIncidents(current => ({ ...current, [saved.incident_uid ?? String(saved.id)]: saved }));
      setAcknowledgeTarget(null);
      setDescription("");
      await refresh();
    } catch (e) {
      setAcknowledgeError(e instanceof Error ? e.message : "Acknowledgment failed. Please try again.");
      descriptionRef.current?.focus();
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  }
  const incidents = data.incidents.filter(i => i.greenhouse_id === greenhouseId).map(i => {
    const saved = savedIncidents[i.incident_uid ?? String(i.id)];
    return saved && (saved.version ?? 0) >= (i.version ?? i.incident_version ?? 0) ? saved : i;
  }).sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at));
  const selectedIncident = details
    ? incidents.find(i => (i.incident_uid ?? String(i.id)) === (details.incident_uid ?? String(details.id))) ?? details
    : null;
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
        <table role="table" className="responsive-table w-full min-w-[700px] text-left text-sm">
          <thead className="border-b border-theme-border text-theme-muted"><tr>
            <th className="p-3">Greenhouse incident</th><th className="p-3">Opened</th><th className="p-3">Status</th><th className="p-3">Notifications</th>
          </tr></thead>
          <tbody>{episodes.map(episode => <tr key={episode.incident_uid} className="border-b border-theme-border">
            <td data-label="Greenhouse incident" className="p-3 font-mono text-xs">{episode.incident_uid.slice(0,12)}</td>
            <td data-label="Opened" className="p-3">{new Date(episode.opened_at).toLocaleString()}</td>
            <td data-label="Status" className="p-3 capitalize"><Badge tone={episode.status === "open" ? "red" : episode.status === "resolved" ? "green" : "amber"}>{episode.status}</Badge></td>
            <td data-label="Notifications" className="p-3"><button className="rounded-lg border border-theme-border px-3 py-2 font-semibold focus-visible:ring-2 focus-visible:ring-theme-accent" onClick={() => setNotificationEpisode(episode.incident_uid)}>View Details</button></td>
          </tr>)}{!episodes.length && <tr><td colSpan={4} className="p-5 text-center text-theme-muted">No greenhouse alerts recorded.</td></tr>}</tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-theme-muted">SMS and email outcomes are recorded separately. Pending emails remain queued after closure. SMS can be resent manually from View Details; email retries require a confirmed failure.</p>
      <h3 className="mt-5 font-semibold text-theme-text">Sensor incidents</h3>
      <div className="mt-2 overflow-x-auto">
        <table role="table" className="responsive-table w-full min-w-[800px] text-left text-sm">
          <thead className="border-b border-theme-border text-theme-muted"><tr>
            <th className="p-3">Sensor</th><th className="p-3">Phase</th><th className="p-3">Opened</th><th className="p-3">Closed / resolved</th><th className="p-3">Status</th><th className="p-3">Actions</th>
          </tr></thead>
          <tbody>{incidents.slice(0,30).map(i => {
            const outcome = incidentOutcome(i);
            return <tr key={i.incident_uid ?? i.id} className="border-b border-theme-border">
              <td data-label="Sensor" className="p-3 font-mono text-xs">{i.sensor_id}</td><td data-label="Phase" className="p-3 capitalize">{i.phase_type}</td>
              <td data-label="Opened" className="p-3">{new Date(i.opened_at).toLocaleString()}</td><td data-label="Closed / resolved" className="p-3">{i.resolved_at ? new Date(i.resolved_at).toLocaleString() : "—"}</td>
              <td data-label="Status" className="p-3"><Badge tone={incidentTone(i)}>{outcome.label}</Badge></td>
              <td data-label="Actions" className="p-3"><div className="flex items-center gap-2">
                <button className="whitespace-nowrap rounded-lg border border-theme-border px-3 py-2 font-semibold focus-visible:ring-2 focus-visible:ring-theme-accent" onClick={() => setDetails(i)}>View Details</button>
                {i.status === "open" && <button disabled={busy !== null} onClick={() => { setAcknowledgeTarget(i); setDescription(""); setAcknowledgeError(null); }} className="rounded-lg border border-theme-border px-3 py-2 font-semibold disabled:opacity-50">{busy === i.id ? "Acknowledging…" : "Acknowledge"}</button>}
              </div></td>
            </tr>;
          })}{!incidents.length && <tr><td colSpan={6} className="p-5 text-center text-theme-muted">No incidents recorded for this greenhouse.</td></tr>}</tbody>
        </table>
      </div>
      <Modal open={acknowledgeTarget !== null} title="Acknowledge incident" description="Describe what happened and why the light violation occurred. This description will be saved with the incident." onClose={closeAcknowledge} footer={<>
        <button type="button" disabled={busy !== null} className={modalButtonClass.secondary} onClick={closeAcknowledge}>Cancel</button>
        <button type="submit" form="acknowledge-incident-form" disabled={busy !== null} className={modalButtonClass.primary}>{busy !== null ? "Saving…" : "Save and acknowledge"}</button>
      </>}>
        <form id="acknowledge-incident-form" onSubmit={acknowledge} className="space-y-4">
          <p className="text-sm text-theme-muted">Sensor <span className="break-all font-medium text-theme-text">{acknowledgeTarget?.sensor_id}</span> · {acknowledgeTarget?.opened_at ? new Date(acknowledgeTarget.opened_at).toLocaleString() : ""}</p>
          <label htmlFor="incident-description" className="block text-sm font-semibold text-theme-text">Description <span className="font-normal text-theme-muted">(required)</span></label>
          <textarea ref={descriptionRef} id="incident-description" name="description" rows={5} maxLength={2000} required disabled={busy !== null} value={description} onChange={event => setDescription(event.target.value)} aria-invalid={!!acknowledgeError} aria-describedby={`incident-description-hint${acknowledgeError ? " incident-description-error" : ""}`} className="glass-input block w-full resize-y rounded-xl p-3 text-base text-theme-text disabled:opacity-60" />
          <p id="incident-description-hint" className="text-xs text-theme-muted">Record the observed cause, or state that the cause is still under investigation. Up to 2,000 characters.</p>
          {acknowledgeError && <p id="incident-description-error" role="alert" className="text-sm text-theme-danger">{acknowledgeError}</p>}
        </form>
      </Modal>
      <Modal open={details !== null || notificationEpisode !== null} title={notificationEpisode ? "Notification details" : "Incident details"} onClose={() => {setDetails(null);setNotificationEpisode(null);}} footer={<button className="rounded-lg border border-theme-border px-4 py-2" onClick={() => {setDetails(null);setNotificationEpisode(null);}}>Close</button>}>
        {notificationEpisode ? <NotificationDetails key={notificationEpisode} episodeId={notificationEpisode} jobs={jobs.filter(job => job.greenhouse_alert_uid === notificationEpisode)}/> : selectedIncident ? <IncidentDetails incident={selectedIncident} /> : null}
      </Modal>
    </Card>
  );
}

function IncidentDetails({ incident }: { incident: Incident }) {
  const outcome = incidentOutcome(incident);
  let trigger: Reading[] = [];
  try {
    trigger = averageReadings(typeof incident.triggering_readings === "string"
      ? JSON.parse(incident.triggering_readings) : incident.triggering_readings ?? []);
  } catch {}
  return <div className="space-y-4 text-sm text-theme-text">
    <div><p className="font-semibold">Detected violation</p><p className="mt-1">{incident.reason || "Sensor incident"}</p></div>
    <div><p className="font-semibold">Description</p><p className="mt-1 whitespace-pre-wrap break-words">{incident.description || "No description recorded."}</p></div>
    {outcome.detail && <p>{outcome.detail}</p>}
    {trigger.length > 0 && <div><p className="font-semibold">Triggering minute averages</p>{trigger.map((r, index) => <p key={index}>{new Date(r.recorded_at).toLocaleString()} · {r.lux.toFixed(2)} lux</p>)}</div>}
  </div>;
}
