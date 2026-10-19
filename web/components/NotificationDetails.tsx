"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
export type NotificationJob = {
  id:string;source?:string;send_number?:number;greenhouse_alert_uid:string;event:string;channel:string;
  recipient:string|null;attempted_at:string|null;status:string;attempts:number;detail:string|null;
};
type Retry = {id:string;original_job_id:string;source:string;status:string;detail:string;recipient:string;created_at:string;requested_by:string};
export function NotificationDetails({episodeId,jobs}: {episodeId:string;jobs:NotificationJob[]}) {
  const container=useRef<HTMLDivElement>(null);
  const [retries,setRetries]=useState<Retry[]>([]);
  const [busy,setBusy]=useState<string|null>(null);
  const [historyError,setHistoryError]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [ready,setReady]=useState(false);
  const [now,setNow]=useState(Date.now());
  const load=useCallback(async () => {
    if(!supabase) {setHistoryError("Notification history is unavailable.");return;}
    const result=await supabase.from("notification_manual_retries").select("id,original_job_id,source,status,detail,recipient,created_at,requested_by")
      .eq("greenhouse_alert_uid",episodeId).order("created_at",{ascending:false}).abortSignal(AbortSignal.timeout(10_000));
    if(result.error) {setReady(false);setHistoryError("Manual retry history is unavailable. Check that the notification retry migration is installed.");}
    else {setRetries(result.data ?? []);setReady(true);setHistoryError(null);}
  },[episodeId]);
  useEffect(() => {
    let active=true;
    const refresh=() => {if(active) void load().catch(() => {if(active) {setReady(false);setHistoryError("Notification history could not be refreshed.");}});};
    refresh();
    const timer=setInterval(() => {setNow(Date.now());refresh();},5_000);
    return () => {active=false;clearInterval(timer);};
  },[load]);
  async function retry(job:NotificationJob) {
    if(busy || !ready) return;
    setBusy(job.id);setError(null);setNotice(null);
    try {
      const response=await fetch("/api/notifications/retry",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({job_id:job.id,source:job.source === "local" ? "local" : "cloud",request_id:crypto.randomUUID()}),signal:AbortSignal.timeout(45_000)});
      const body=await response.json();
      if(!response.ok) throw new Error(body.error ?? body.message ?? "Manual resend could not be completed. Refresh the outcomes before retrying.");
      setNotice(body.message ?? "Manual resend completed. Check the delivery outcome below.");
    } catch(e) {
      setError(e instanceof Error && e.name !== "TimeoutError" ? e.message : "Resend acceptance is unconfirmed. Refresh notification details before trying again.");
    } finally {await load().catch(() => setReady(false));setNow(Date.now());setBusy(null);container.current?.focus();}
  }
  return <div ref={container} tabIndex={-1} role="group" aria-label="Notification resend outcomes" className="space-y-4 focus-visible:ring-2 focus-visible:ring-theme-accent">
    <p className="text-xs text-theme-muted">Retry resends the original incident notice. Email uses the currently saved manager recipient. Only confirmed failures can be retried; accepted or unconfirmed sends are not resent.</p>
    {historyError && <p role="alert" className="text-sm text-theme-danger">{historyError}</p>}
    {error && <p role="alert" className="text-sm text-theme-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-theme-text">{notice}</p>}
    {jobs.map(job => {
      const source=job.source === "local" ? "local" : "cloud";
      const history=retries.filter(r => r.original_job_id === job.id && r.source === source);
      const latest=history[0];
      const currentStatus=latest?.status ?? job.status;
      const cooldown=latest ? Math.max(0,Math.ceil((Date.parse(latest.created_at)+30_000-now)/1000)) : 0;
      const eligible=job.status === "failed" && (!latest || latest.status === "failed");
      return <div key={`${source}-${job.id}`} className="border-b border-theme-border pb-4 text-sm">
        <p className="font-semibold">{job.event === "closed" ? "Closure" : job.event === "recovered" ? "Recovery" : "Opening"} {source === "local" ? "local " : ""}{job.channel.toUpperCase()}{job.send_number ? ` #${job.send_number}` : ""}: {currentStatus === "accepted" ? "Accepted by provider; recipient delivery unconfirmed" : currentStatus}</p>
        <p className="mt-1 break-words">{latest ? `Original attempt: ${job.status} · ` : ""}{job.recipient || "Recipient unavailable"}{job.attempted_at ? ` · ${new Date(job.attempted_at).toLocaleString()}` : ""} · {job.attempts} sending attempt{job.attempts === 1 ? "" : "s"}</p>
        {job.detail && <p className="mt-1 text-theme-muted">{job.detail}</p>}
        {history.length>0 && <div className="mt-3 space-y-2 border-l-2 border-theme-border pl-3"><p className="font-semibold">Manual resends</p>{history.map(r => <div key={r.id}><p className="capitalize">{r.status} · {new Date(r.created_at).toLocaleString()}</p><p className="break-words text-xs text-theme-muted">{r.recipient} · {r.detail}</p></div>)}</div>}
        {eligible && <button type="button" disabled={busy !== null || !ready || cooldown>0} onClick={() => void retry(job)} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-theme-accent px-3 py-2 font-semibold text-theme-accent hover:bg-theme-accent-soft focus-visible:ring-2 focus-visible:ring-theme-accent disabled:opacity-50"><RefreshCw size={16} aria-hidden="true"/>{busy === job.id ? "Retrying…" : cooldown>0 ? `Retry in ${cooldown}s` : `Retry ${job.channel.toUpperCase()}`}</button>}
      </div>;
    })}
    {!jobs.length && <p>No notification outcomes recorded.</p>}
  </div>;
}
