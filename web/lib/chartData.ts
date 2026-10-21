import type { Reading } from "./monitoring-types.ts";

export type PivotedPoint = { time: string; [seriesLabel: string]: number | string };

/**
 * Groups readings by sensor and lines them up into a single array recharts
 * can plot as one line per sensor (or per greenhouse, if a label map is given).
 */
export function pivotReadingsBySensor(readings: Reading[], labelBySensor: Record<string, string> = {}): PivotedPoint[] {
  const buckets = new Map<number, PivotedPoint>();
  for (const reading of readings) {
    const time = Date.parse(reading.recorded_at);
    const row = buckets.get(time) ?? { time: String(time) };
    row[labelBySensor[reading.sensor_id] ?? reading.sensor_id] = reading.lux;
    buckets.set(time,row);
  }
  const rows = [...buckets.entries()].sort(([a],[b]) => a-b).map(([,row]) => row);
  return rows;
}

export const STATUS_COLORS = { safe: "#3fae64", warning: "#d9a441", violation: "#e5484d" } as const;

export function statusDistribution(readings: Reading[]) {
  const counts = { safe: 0, warning: 0, violation: 0 };
  for (const r of readings) if (r.classification !== "unclassified") counts[r.classification]++;
  return [
    { name: "Normal", key: "safe" as const, value: counts.safe },
    { name: "Warning", key: "warning" as const, value: counts.warning },
    { name: "Violation", key: "violation" as const, value: counts.violation }
  ];
}

/** Latest reading per sensor, most-recent-first source order assumed. */
export function latestBySensor(readings: Reading[]) {
  const map = new Map<string, Reading>();
  for (const r of readings) if (!map.has(r.sensor_id)) map.set(r.sensor_id, r);
  return map;
}

/** Each sensor keeps its own real timestamps. Explicit nulls break long gaps
 * without treating another sensor's asynchronous sample as missing data. */
export function sensorSeries(points: Record<string,number>[],id: string,maxGapMs: number): Record<string,number|null>[] {
  const samples=points.filter(row => typeof row[id] === "number").sort((a,b) => a.time-b.time);
  const result: Record<string,number|null>[]=[];
  let previous: number|null=null;
  for(const row of samples) {
    if(previous !== null && row.time-previous > maxGapMs) result.push({time:previous+maxGapMs,[id]:null});
    result.push({time:row.time,[id]:row[id]});previous=row.time;
  }
  return result;
}

/** Choose the newest observation of each minute, regardless of which fetch finished last. */
export function minuteHistoryPoints(
  history: import("./monitoring-types.ts").MinuteAggregate[], readings: Reading[],
  greenhouseId: string, sensorIds: readonly string[],
): Record<string, number>[] {
  const samples = [
    ...history.filter(row => row.greenhouse_id === greenhouseId).map(row => ({
      time: Date.parse(row.bucket_start), observed: Date.parse(row.last_recorded_at ?? row.updated_at), sensor: row.sensor_id, lux: row.avg_lux,
    })),
    ...readings.filter(row => row.greenhouse_id === greenhouseId).map(row => ({
      time: Math.floor(Date.parse(row.recorded_at) / 60_000) * 60_000,
      observed: Date.parse(row.recorded_at), sensor: row.sensor_id, lux: row.lux,
    })),
  ];
  const newest = new Map<string, typeof samples[number]>();
  for (const sample of samples) {
    if (!sensorIds.includes(sample.sensor) || !Number.isFinite(sample.time) || !Number.isFinite(sample.observed) || !Number.isFinite(sample.lux)) continue;
    const key = `${sample.time}|${sample.sensor}`;
    if (!newest.has(key) || sample.observed > newest.get(key)!.observed) newest.set(key, sample);
  }
  const points = new Map<number, Record<string, number>>();
  for (const sample of newest.values()) {
    const point = points.get(sample.time) ?? { time: sample.time };
    point[sample.sensor] = sample.lux;
    points.set(sample.time, point);
  }
  return [...points.values()].sort((a,b) => a.time - b.time);
}
