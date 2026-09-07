// Maps the physical sensors (sensor1/2/3, as reported by the Pi) to the
// greenhouse each one is installed in. Only "sensor1" (Greenhouse 3 / ICS Lab)
// has a real physical device today — sensor2/3 are simulated ahead of rollout.
export const GREENHOUSE_BY_SENSOR: Record<string, string> = {
  sensor2: "Greenhouse 1",
  sensor3: "Greenhouse 2"
};

export const mockKPIs = {
  greenhousesActive: 3,
  sensorsOnline: 3,
  openIncidents: 1,
  currentPhase: "Illumination — Day 12 of 30"
};

export const mockActivityLog = [
  { time: "9:15 PM", text: "Sensor 2 lux dropped below minimum" },
  { time: "8:40 PM", text: "Technician acknowledged incident #4" },
  { time: "6:30 PM", text: "Illumination window started" },
  { time: "5:58 PM", text: "Greenhouse 2 phase config updated by RJ Bernales" },
  { time: "3:12 PM", text: "Sensor 3 reconnected after 2 minutes offline" }
];

export const mockGreenhouses = [
  { id: 1, name: "Greenhouse 1", crop: "Chrysanthemum", phase: "Illumination", startedOn: "2026-08-11", status: "active" },
  { id: 2, name: "Greenhouse 2", crop: "Anthurium", phase: "Dark", startedOn: "2026-07-28", status: "active" },
  { id: 3, name: "Greenhouse 3", crop: "Chrysanthemum", phase: "Illumination", startedOn: "2026-08-11", status: "active" }
];

export const mockRecycleBin = [
  { id: 1, type: "Greenhouse entry", name: "Greenhouse 1 — trial batch", deletedOn: "2026-08-02", deletedBy: "R. Bernales" }
];

// Time, greenhouse, and the lux value that tripped a soft (non-incident) alert.
export const mockSoftAlerts = [
  { id: 1, time: "2026-08-24 21:15:03", greenhouse: "Greenhouse 1", lux: 71.4 },
  { id: 2, time: "2026-08-24 18:47:21", greenhouse: "Greenhouse 2", lux: 96.8 },
  { id: 3, time: "2026-08-23 22:03:55", greenhouse: "Greenhouse 3", lux: 69.9 }
];

// Read-only sensor configuration shown in System settings; edited via the
// shared modal, not inline.
export const mockSensorConfig = [
  { id: "sensor1", greenhouse: "Greenhouse 3", reportingIntervalSec: 5, luxMin: 70, luxMax: 100, calibrationOffset: 0.0, updatedAt: "2026-08-20" },
  { id: "sensor2", greenhouse: "Greenhouse 1", reportingIntervalSec: 5, luxMin: 70, luxMax: 100, calibrationOffset: -1.2, updatedAt: "2026-08-14" },
  { id: "sensor3", greenhouse: "Greenhouse 2", reportingIntervalSec: 5, luxMin: 65, luxMax: 95, calibrationOffset: 0.5, updatedAt: "2026-08-14" }
];

export const mockPhaseConfig = {
  illuminationDays: 30,
  darkDays: 60,
  alertChannel: "Dashboard (email planned)",
  timezone: "Asia/Manila"
};
