"use client";
import { Badge, Card } from "@/components/ui";
import { useDashboardData } from "@/lib/useDashboardData";
import { sensorHealth } from "@/lib/monitoring-state";
import { formatLastSeen,formatLux } from "@/lib/sensor-list";
export function AvailableSensors({greenhouseId}: {greenhouseId: string; intervalMs?: number}) {
  const {sensors,sensorsFetchedAt,sensorError,greenhouses,loading,policy} = useDashboardData();
  const greenhouse = greenhouses.find(g => g.id === greenhouseId);
  const ids = [...new Set([...(greenhouse?.sensor_ids ?? []),...sensors.filter(s => s.greenhouse_id === greenhouseId).map(s => s.sensor_id)])];
  if (!greenhouseId) return null;
  return <Card className="mt-5">
    <h2 className="font-bold text-theme-text">Assigned sensors</h2>
    <p className="mt-1 text-xs text-theme-muted">{sensorsFetchedAt ? `Registry checked ${new Date(sensorsFetchedAt).toLocaleTimeString()}` : "Registry has not been fetched"}</p>
    {sensorError && <p role="status" className="mt-2 text-sm text-theme-danger">Sensor registry unavailable. Retained measurements may be stale.</p>}
    <div className="mt-4 space-y-2">
      {ids.map(id => {
        const sensor = sensors.find(s => s.sensor_id === id);
        const status = sensorError ? (sensor ? "Data stale" : "Unknown") : sensorHealth(sensor,sensorsFetchedAt,Date.now(),policy.offline_threshold_seconds);
        return <div key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-theme-border p-3">
          <div><p className="font-mono text-sm text-theme-text">{id}</p><p className="mt-1 text-xs text-theme-muted">{sensor ? `${formatLux(sensor.lux)} · last reading ${formatLastSeen(sensor.last_reading_at,Date.now())}` : "No recorded measurement"}</p></div>
          <Badge tone={status === "Online" ? "green" : status === "Offline" ? "red" : "slate"}>{status}</Badge>
        </div>;
      })}
      {!ids.length && <p className="py-4 text-sm text-theme-muted">{loading ? "Checking sensors…" : "No sensors assigned to this greenhouse."}</p>}
    </div>
  </Card>;
}
