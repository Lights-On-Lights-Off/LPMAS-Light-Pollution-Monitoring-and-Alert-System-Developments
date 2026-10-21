"use client";
import { useDashboardData } from "@/lib/useDashboardData";
import { currentReadingFreshness } from "@/lib/reading-freshness";
import { formatLastSeen } from "@/lib/sensor-list";
import { Badge, Card } from "./ui";

export function CurrentReadings({ sensorIds, greenhouseName }: { sensorIds: readonly string[]; greenhouseName?: string }) {
  const monitoring = useDashboardData();
  return <section aria-label="Current sensor readings" className="space-y-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="font-semibold text-theme-text">Current readings{greenhouseName ? ` · ${greenhouseName}` : ""}</h2>
      <p className="text-xs text-theme-muted">Latest measured lux · checks every 10 seconds</p>
    </div>
    {!sensorIds.length ? <Card><p className="text-sm text-theme-muted">Select a configured greenhouse to see current sensor readings.</p></Card> :
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{sensorIds.map(id => {
        const sensor = monitoring.sensors.find(row => row.sensor_id === id);
        const measuredAt = sensor?.last_reading_at ?? null;
        const status = currentReadingFreshness(measuredAt, monitoring.sensorsFetchedAt, monitoring.now,
          monitoring.policy.offline_threshold_seconds, monitoring.sensorError);
        const valid = measuredAt && Number.isFinite(Date.parse(measuredAt)) && Date.parse(measuredAt) <= monitoring.now && Number.isFinite(sensor?.lux);
        return <Card key={id}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="min-w-0 break-all text-sm font-semibold text-theme-text">{id}</h3>
            <Badge tone={status === "Receiving data" ? "green" : status === "Offline" ? "red" : status === "Data stale" ? "amber" : "slate"}>{status === "Unknown" ? "No current reading" : status}</Badge>
          </div>
          <p className="mt-4 font-mono text-3xl font-semibold tabular-nums text-theme-text">{valid ? sensor!.lux.toFixed(2) : "—"} <span className="text-sm font-normal text-theme-muted">lux</span></p>
          <p className="mt-3 text-sm text-theme-secondary-text">Last reading: {valid ? formatLastSeen(measuredAt, monitoring.now) : "unavailable"}</p>
          {valid && <time dateTime={measuredAt} className="mt-1 block text-xs text-theme-muted">Measured {new Date(measuredAt).toLocaleString()}</time>}
          {(status === "Offline" || status === "Data stale") && <p className="mt-2 text-xs text-theme-muted">Last known value · {status === "Offline" ? "no recent measurement received" : "current data cannot be confirmed"}</p>}
        </Card>;
      })}</div>}
  </section>;
}
