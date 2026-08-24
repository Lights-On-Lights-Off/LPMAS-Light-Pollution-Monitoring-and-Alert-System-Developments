import type { Reading } from "./api";

export type PivotedPoint = { time: string; [seriesLabel: string]: number | string };

/**
 * Groups readings by sensor and lines them up into a single array recharts
 * can plot as one line per sensor (or per greenhouse, if a label map is given).
 */
export function pivotReadingsBySensor(readings: Reading[], labelBySensor: Record<string, string> = {}): PivotedPoint[] {
  const bySensor = new Map<string, Reading[]>();
  for (const r of readings) {
    if (!bySensor.has(r.sensor_id)) bySensor.set(r.sensor_id, []);
    bySensor.get(r.sensor_id)!.push(r);
  }
  for (const arr of bySensor.values()) arr.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));

  const sensorIds = Array.from(bySensor.keys());
  const maxLen = Math.max(0, ...sensorIds.map(id => bySensor.get(id)!.length));

  const rows: PivotedPoint[] = [];
  for (let i = 0; i < maxLen; i++) {
    const row: PivotedPoint = { time: "" };
    for (const id of sensorIds) {
      const point = bySensor.get(id)![i];
      if (!point) continue;
      row[labelBySensor[id] ?? id] = point.lux;
      if (!row.time) row.time = new Date(point.recorded_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    rows.push(row);
  }
  return rows;
}

export const STATUS_COLORS = { safe: "#3fae64", warning: "#d9a441", violation: "#e5484d" } as const;

export function statusDistribution(readings: Reading[]) {
  const counts = { safe: 0, warning: 0, violation: 0 };
  for (const r of readings) counts[r.classification]++;
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
