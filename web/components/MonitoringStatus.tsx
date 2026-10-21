"use client";
import { useDashboardData } from "@/lib/useDashboardData";
export function MonitoringStatus() {
  const {
    loading,
    piError,
    cloudError,
    sensorError,
    configError,
    sensorsFetchedAt,
    sensorHealthById,
    data,
    refresh,
  } = useDashboardData();
  const degraded = !!(piError || cloudError || sensorError || configError);
  const health = Object.values(sensorHealthById);
  const stale = health.length === 0 || health.every(status => status === "Unknown" || status === "Data stale");
  return (
    <div
      role="status"
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-theme-border bg-theme-surface px-4 py-3 text-sm text-theme-text"
    >
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {loading
            ? "Checking monitoring connections…"
            : stale
            ? "Sensor health unknown or stale"
            : degraded
            ? "Monitoring connection degraded"
            : "Monitoring connected"}
        </p>
        <details className="mt-1 text-xs text-theme-muted">
          <summary className="cursor-pointer py-2 font-medium">Connection details</summary>
          <p className="max-w-3xl leading-6">
          Pi: {loading ? "checking" : piError ? "unavailable" : "connected"}
          {" "}
          · Cloud: {sensorsFetchedAt === null
            ? "unknown"
            : cloudError || sensorError
            ? "unavailable"
            : "connected"} · Sensor registry checked: {sensorsFetchedAt
            ? new Date(sensorsFetchedAt).toLocaleTimeString()
            : "never"}. Lux displays use per-minute averages. Status reflects
          average intensity for the recorded phase; alerts follow the configured monitoring window.
        </p>
        </details>
        {configError && (
          <p className="mt-1 text-xs text-theme-danger">
            Configuration unavailable; retained configuration may be outdated.
          </p>
        )}
        {data.deliveryHealth && (
          <p className="mt-1 text-xs text-theme-muted">
            Cloud queue: {data.deliveryHealth.pending} pending ·{" "}
            {data.deliveryHealth.failedAttempts}{" "}
            awaiting retry{!data.deliveryHealth.configured &&
              " · Pi cloud credentials missing"}
            {piError && " · last known queue state"}
          </p>
        )}
      </div>
      <button
        onClick={() => void refresh()}
        className="rounded-lg border border-theme-border px-3 py-2 font-semibold"
      >
        Refresh
      </button>
    </div>
  );
}
