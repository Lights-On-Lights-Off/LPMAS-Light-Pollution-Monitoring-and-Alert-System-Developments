import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  freshestReadings,
  phaseForGreenhouse,
  sensorHealth,
} from "./monitoring-state.ts";
import type { MinuteAggregate, Reading } from "./monitoring-types.ts";
const now = Date.parse("2026-10-01T00:00:30Z");
const sensor = {
  sensor_id: "S1",
  lux: 10,
  status: "online" as const,
  last_reading_at: "2026-10-01T00:00:20Z",
  greenhouse_id: "G1",
};
Deno.test("fetch failures and expiry are distinct from offline hardware", () => {
  assertEquals(sensorHealth(undefined, null, now), "Unknown");
  assertEquals(sensorHealth(sensor, now - 31_000, now), "Data stale");
  assertEquals(sensorHealth(sensor, now, now), "Online");
  assertEquals(
    sensorHealth({ ...sensor, status: "offline" }, now, now),
    "Offline",
  );
  assertEquals(
    sensorHealth(
      { ...sensor, last_reading_at: "2026-09-30T23:59:00Z" },
      now,
      now,
    ),
    "Offline",
  );
  assertEquals(sensorHealth(sensor, now, now, 5), "Offline");
});
Deno.test("newer cloud data replaces stale Pi data per sensor", () => {
  const raw = [{
    id: 1,
    sensor_id: "S1",
    greenhouse_id: "G1",
    lux: 1,
    recorded_at: "2026-10-01T00:00:10Z",
    classification: "safe",
    phase_type: "dark",
  }, {
    id: 2,
    sensor_id: "S2",
    greenhouse_id: "G1",
    lux: 2,
    recorded_at: "2026-10-01T00:00:25Z",
    classification: "safe",
    phase_type: "dark",
  }] as Reading[];
  const aggregates = [{
    id: 3,
    sensor_id: "S1",
    greenhouse_id: "G1",
    avg_lux: 12,
    bucket_start: "2026-10-01T00:00:00Z",
    last_recorded_at: "2026-10-01T00:00:20Z",
    phase_type: "dark",
    safe_count: 1,
    warning_count: 0,
    violation_count: 0,
  }] as MinuteAggregate[];
  const result = freshestReadings(raw, aggregates);
  assertEquals(result.sources, { S1: "minute", S2: "raw" });
  assertEquals(result.readings.find((r) => r.sensor_id === "S1")!.lux, 12);
});
Deno.test("phase derives from the selected greenhouse's Manila date", () => {
  const greenhouse = { phase_start: "2026-09-01", phase_end: "2026-09-30" };
  assertEquals(
    phaseForGreenhouse(greenhouse, 60, new Date("2026-09-30T15:59:59Z")),
    "illumination",
  );
  assertEquals(
    phaseForGreenhouse(greenhouse, 60, new Date("2026-09-30T16:00:00Z")),
    "dark",
  );
  assertEquals(
    phaseForGreenhouse(greenhouse, 1, new Date("2026-10-02T00:00:00Z")),
    null,
  );
});

Deno.test("incident outcomes distinguish measured recovery from context closure", async () => {
  const {incidentOutcome} = await import("./monitoring-state.ts");
  assertEquals(incidentOutcome({status: "open"}), {label: "open", detail: null});
  assertEquals(incidentOutcome({status: "resolved", resolution_reason: "safe_reading"}).label, "resolved");
  assertEquals(incidentOutcome({status: "resolved"}).detail, "Historical resolution; no closure reason was recorded.");
  for (const reason of ["phase_ended", "assignment_changed", "configuration_changed", "monitoring_window_ended"] as const) {
    const result = incidentOutcome({status: "resolved", resolution_reason: reason});
    assertEquals(result.label, "closed");
    assertEquals(result.detail!.includes("recovery was not confirmed"), true);
  }
});
