"use client";
import { useState } from "react";
import { useDashboardData } from "@/lib/useDashboardData";

export function MonitoringStatus() {
  const { loading, aggregateError, incidentError, sensorError, configError,
    sensorsFetchedAt, lastFetchedAt, sensorHealthById, refresh } = useDashboardData();
  const [refreshing, setRefreshing] = useState(false);
  const health = Object.values(sensorHealthById);
  const reporting = health.filter(status => status === "Online").length;
  const stale = health.some(status => status === "Data stale");
  const title = loading ? "Checking current readings…"
    : sensorError || stale ? "Current readings cannot be confirmed"
    : reporting ? `Receiving data from ${reporting} sensor${reporting === 1 ? "" : "s"}`
    : health.some(status => status === "Offline") ? "No sensors reporting recent readings"
    : "Waiting for sensor readings";
  async function refreshNow() {
    if (refreshing) return;
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  }
  return <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-theme-border bg-theme-surface px-4 py-3 text-sm text-theme-text">
    <div className="min-w-0 flex-1">
      <p role="status" aria-atomic="true" className="font-semibold">{title}</p>
      <p className="mt-1 text-xs text-theme-muted">Current readings check every 10 seconds. Charts and history show minute averages.</p>
      <details className="mt-1 text-xs text-theme-muted">
        <summary className="cursor-pointer py-2 font-medium">Refresh details</summary>
        <p className="max-w-3xl leading-6">Current readings last checked: {sensorsFetchedAt ? new Date(sensorsFetchedAt).toLocaleTimeString() : "not yet"}.
          {" "}Minute averages last checked: {lastFetchedAt ? new Date(lastFetchedAt).toLocaleTimeString() : "not yet"}.
          {" "}Each reading card shows when its measurement was taken. A successful check does not make an old measurement current.</p>
      </details>
      {sensorError && <p className="mt-1 text-xs text-theme-danger">Current readings unavailable; retained values may be outdated.</p>}
      {aggregateError && <p className="mt-1 text-xs text-theme-danger">History unavailable; retained chart points may be outdated.</p>}
      {incidentError && <p className="mt-1 text-xs text-theme-danger">Incident history could not be refreshed.</p>}
      {configError && <p className="mt-1 text-xs text-theme-danger">Configuration unavailable; retained assignments may be outdated.</p>}
    </div>
    <button onClick={() => void refreshNow()} disabled={refreshing} className="rounded-lg border border-theme-border px-3 py-2 font-semibold disabled:opacity-60">{refreshing ? "Refreshing…" : "Refresh"}</button>
  </div>;
}
