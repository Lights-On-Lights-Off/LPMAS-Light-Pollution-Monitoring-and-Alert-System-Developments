import type { DashboardSummary, Phase, Reading, Incident } from "./api";

const now = Date.now();

const activePhase: Phase = {
  id: 1,
  phase_type: "illumination",
  starts_on: "2026-08-01",
  ends_on: "2026-08-31",
  window_start: "18:30",
  window_end: "23:00",
  lux_min: 70,
  lux_max: 100,
  lux_ceiling: null,
  is_active: 1
};

const sensors = ["sensor1", "sensor2", "sensor3"];

const readings: Reading[] = Array.from({ length: 60 }, (_, i) => {
  const sensor_id = sensors[i % 3];
  // sensor2 trends downward mid-session to demonstrate a violation
  const base = sensor_id === "sensor2" ? 140 - i * 1.6 : 90 + Math.sin(i / 4) * 12;
  const lux = Math.max(0, +base.toFixed(1));
  const classification: Reading["classification"] =
    lux < 70 ? "violation" : lux < 79.5 ? "warning" : lux > 100 ? "violation" : "safe";

  return {
    id: i + 1,
    sensor_id,
    lux,
    recorded_at: new Date(now - (59 - i) * 5 * 60_000).toISOString(),
    classification,
    phase_type: "illumination"
  };
});

const incidents: Incident[] = [
  {
    id: 1,
    sensor_id: "sensor2",
    phase_type: "illumination",
    opened_at: new Date(now - 42 * 60_000).toISOString(),
    resolved_at: null,
    status: "open",
    peak_lux: 68.2,
    lowest_lux: 64.7,
    reason: "below_minimum"
  }
];

export const demoData: DashboardSummary = {
  phase: activePhase,
  readings,
  incidents,
  generatedAt: new Date(now).toISOString()
};
