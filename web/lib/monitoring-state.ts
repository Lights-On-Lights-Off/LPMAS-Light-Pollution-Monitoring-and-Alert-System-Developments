import type { Greenhouse, Incident, MinuteAggregate, Reading } from "./monitoring-types.ts";
import type { SensorListEntry } from "./sensor-list.ts";
export type SensorHealth = "Online" | "Offline" | "Unknown" | "Data stale";

export function incidentOutcome(incident: Pick<Incident, "status" | "resolution_reason">) {
  if (incident.status !== "resolved") return { label: incident.status, detail: null };
  const reasons = {
    safe_reading: "A safe reading resolved this violation.",
    phase_ended: "Closed because the monitoring phase ended; recovery was not confirmed.",
    assignment_changed: "Closed because the sensor assignment ended or changed; recovery was not confirmed.",
    configuration_changed: "Closed because the monitoring configuration changed; recovery was not confirmed.",
    monitoring_window_ended: "Closed because the monitoring window ended; recovery was not confirmed.",
  };
  return {
    label: incident.resolution_reason && incident.resolution_reason !== "safe_reading" ? "closed" : "resolved",
    detail: incident.resolution_reason ? reasons[incident.resolution_reason] : "Historical resolution; no closure reason was recorded.",
  };
}
export function sensorHealth(
  sensor: SensorListEntry | undefined,
  fetchedAt: number | null,
  now = Date.now(),
  offlineThresholdSeconds = 15,
): SensorHealth {
  if (!sensor || fetchedAt === null) return "Unknown";
  if (now - fetchedAt > 30_000) return "Data stale";
  return sensor.last_reading_at !== null &&
      Date.parse(sensor.last_reading_at) <= now &&
      now - Date.parse(sensor.last_reading_at) <= offlineThresholdSeconds * 1000
    ? "Online"
    : "Offline";
}

// Current assignments come from configuration; historical readings retain their
// original greenhouse. Status depends on measurement time, never lux changes.
export function resolveSensorMonitoring(
  registry: SensorListEntry[],
  readings: Reading[],
  greenhouses: Greenhouse[],
  options: {
    now: number;
    offlineThresholdSeconds: number;
    registryFetchedAt: number | null;
    piFetchedAt: number | null;
    registryError: string | null;
    piError: string | null;
    configurationKnown: boolean;
  },
) {
  const sensors = new Map(registry.map(sensor => [sensor.sensor_id, { ...sensor }]));
  for (const reading of readings) {
    const stamp = Date.parse(reading.recorded_at);
    if (!Number.isFinite(stamp) || stamp > options.now || !Number.isFinite(reading.lux) || reading.lux < 0) continue;
    const previous = sensors.get(reading.sensor_id);
    if (!previous || !previous.last_reading_at || !Number.isFinite(Date.parse(previous.last_reading_at)) || Date.parse(previous.last_reading_at) > options.now || stamp > Date.parse(previous.last_reading_at)) {
      sensors.set(reading.sensor_id, {
        ...previous, sensor_id: reading.sensor_id, lux: reading.lux,
        last_reading_at: reading.recorded_at, greenhouse_id: previous?.greenhouse_id ?? null,
        status: "offline",
      });
    }
  }
  const assignments = new Map(greenhouses.filter(g => g.is_active === 1)
    .flatMap(g => g.sensor_ids.map(id => [id, g.id] as const)));
  for (const [id, greenhouseId] of assignments) {
    if (!sensors.has(id)) sensors.set(id, {
      sensor_id: id, greenhouse_id: greenhouseId, lux: 0, status: "offline", last_reading_at: null,
    });
  }
  const observed = [
    [options.registryFetchedAt, options.registryError],
    [options.piFetchedAt, options.piError],
  ].some(([at, error]) => typeof at === "number" && !error && options.now - at <= 30_000);
  const health: Record<string, SensorHealth> = {};
  for (const [id, sensor] of sensors) {
    if (options.configurationKnown) sensor.greenhouse_id = assignments.get(id) ?? null;
    const stamp = sensor.last_reading_at ? Date.parse(sensor.last_reading_at) : NaN;
    const recent = Number.isFinite(stamp) && stamp <= options.now &&
      options.now - stamp <= options.offlineThresholdSeconds * 1000;
    health[id] = recent ? "Online" : !Number.isFinite(stamp) ? "Unknown" : observed ? "Offline" : "Data stale";
    sensor.status = health[id] === "Online" ? "online" : "offline";
  }
  return { sensors: [...sensors.values()].sort((a, b) => a.sensor_id.localeCompare(b.sensor_id)), health };
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
