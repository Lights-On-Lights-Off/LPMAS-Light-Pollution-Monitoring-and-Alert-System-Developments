import type { MinuteAggregate, Reading } from "./monitoring-types.ts";
import type { SensorListEntry } from "./sensor-list.ts";
export type SensorHealth = "Online" | "Offline" | "Unknown" | "Data stale";
export function sensorHealth(
  sensor: SensorListEntry | undefined,
  fetchedAt: number | null,
  now = Date.now(),
  offlineThresholdSeconds = 15,
): SensorHealth {
  if (!sensor || fetchedAt === null) return "Unknown";
  if (now - fetchedAt > 30_000) return "Data stale";
  return sensor.status === "online" && sensor.last_reading_at !== null &&
      now - Date.parse(sensor.last_reading_at) <= offlineThresholdSeconds * 1000
    ? "Online"
    : "Offline";
}
export function freshestReadings(
  raw: Reading[],
  aggregates: MinuteAggregate[],
): { readings: Reading[]; sources: Record<string, "raw" | "minute"> } {
  const rawTimes = new Map<string, number>();
  const cloudTimes = new Map<string, number>();
  for (const r of raw) {
    rawTimes.set(
      r.sensor_id,
      Math.max(rawTimes.get(r.sensor_id) ?? 0, Date.parse(r.recorded_at)),
    );
  }
  for (const r of aggregates) {
    cloudTimes.set(
      r.sensor_id,
      Math.max(
        cloudTimes.get(r.sensor_id) ?? 0,
        Date.parse(r.last_recorded_at ?? r.bucket_start),
      ),
    );
  }
  const sources: Record<string, "raw" | "minute"> = {};
  for (const id of new Set([...rawTimes.keys(), ...cloudTimes.keys()])) {
    sources[id] = (rawTimes.get(id) ?? 0) >= (cloudTimes.get(id) ?? 0)
      ? "raw"
      : "minute";
  }
  return {
    sources,
    readings: [
      ...raw.filter((r) => sources[r.sensor_id] === "raw"),
      ...aggregates.filter((r) => sources[r.sensor_id] === "minute").map(
        (r) => ({
          id: r.id,
          sensor_id: r.sensor_id,
          greenhouse_id: r.greenhouse_id,
          lux: r.avg_lux,
          recorded_at: r.last_recorded_at ?? r.bucket_start,
          phase_type: r.phase_type,
          classification:
            (r.violation_count > 0
              ? "violation"
              : r.warning_count > 0
              ? "warning"
              : "safe") as Reading["classification"],
        }),
      ),
    ].sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at)),
  };
}

export function phaseForGreenhouse(
  greenhouse: { phase_start: string; phase_end: string } | undefined,
  darkDays = 60,
  now = new Date(),
): "illumination" | "dark" | null {
  if (!greenhouse) return null;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  if (today >= greenhouse.phase_start && today <= greenhouse.phase_end) {
    return "illumination";
  }
  const daysSinceEnd = (Date.parse(today + "T00:00:00Z") -
    Date.parse(greenhouse.phase_end + "T00:00:00Z")) / 86400000;
  return daysSinceEnd >= 1 && daysSinceEnd <= darkDays ? "dark" : null;
}
