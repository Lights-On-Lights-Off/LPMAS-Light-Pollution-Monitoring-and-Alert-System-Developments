import type { Greenhouse } from "./monitoring-types.ts";
import { phaseForGreenhouse } from "./monitoring-state.ts";

const DAY = 86_400_000;
export type MonitoringWindow = { start: number; end: number; phase: "illumination" | "dark"; active: boolean };

/** Current session, or the latest completed session during a daily pause.
 * End is exclusive, including every second of the configured end minute. */
export function greenhouseMonitoringWindow(g: Greenhouse | undefined, darkDays: number, now: number): MonitoringWindow | null {
  const phase = phaseForGreenhouse(g, darkDays, new Date(now));
  if (!g || !phase || !g.is_active) return null;
  const from = (phase === "dark" ? g.dark_window_start ?? "00:00" : g.window_start).slice(0, 5);
  const to = (phase === "dark" ? g.dark_window_end ?? "23:59" : g.window_end).slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) return null;
  const midnight = Math.floor((now + 8 * 3_600_000) / DAY) * DAY - 8 * 3_600_000;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  let start = midnight + minutes(from) * 60_000;
  if (now < start) start -= DAY;
  let end = start + ((minutes(to) - minutes(from) + 1440) % 1440 + 1) * 60_000;
  const illuminationEnd = Date.parse(`${g.phase_end}T00:00:00+08:00`) + DAY;
  const phaseStart = phase === "illumination" ? Date.parse(`${g.phase_start}T00:00:00+08:00`) : illuminationEnd;
  const phaseEnd = phase === "illumination" ? illuminationEnd : illuminationEnd + darkDays * DAY;
  start = Math.max(start, phaseStart);
  end = Math.min(end, phaseEnd);
  return start < end ? { start, end, phase, active: now >= start && now < end } : null;
}

export function windowContains(window: MonitoringWindow | null, stamp: string, phase: string, now: number): boolean {
  const time = Date.parse(stamp);
  return !!window && phase === window.phase && time >= window.start && time < window.end && time <= now;
}

/** Shift lux by one only for plotting on a log axis, retaining zero and all spikes. */
export function plotLuxPoints(points: Record<string, number>[], logarithmic: boolean): Record<string, number>[] {
  return logarithmic ? points.map(point => Object.fromEntries(Object.entries(point).map(([key, value]) => [key, key === "time" ? value : value + 1]))) : points;
}
