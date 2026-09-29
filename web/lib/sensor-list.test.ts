/**
 * Tests for the sensor_list filtering logic.
 *
 * The filter is the security-relevant part of this endpoint: a mistake here
 * shows a manager another greenhouse's sensors. It is a pure module so these
 * run with no Next server and no Supabase project.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  buildSensorList,
  filterSensors,
  normalizeSensorRow,
  normalizeSensorRows,
  parseQuery,
  sortSensors,
  type SensorListEntry,
} from "./sensor-list.ts";

function entry(overrides: Partial<SensorListEntry> = {}): SensorListEntry {
  return {
    sensor_id: "ESP32-001",
    lux: 12,
    status: "online",
    last_reading_at: "2026-09-29T10:30:00.000Z",
    greenhouse_id: "gh-001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeSensorRow
// ---------------------------------------------------------------------------

Deno.test("a well-formed row is preserved", () => {
  const row = {
    sensor_id: "ESP32-001",
    lux: 45.2,
    status: "online" as const,
    last_reading_at: "2026-09-29T10:30:00.000Z",
    greenhouse_id: "gh-001",
  };
  assertEquals(normalizeSensorRow(row), { ...row, created_at: undefined, updated_at: undefined });
});

Deno.test("a row without a usable sensor_id is rejected", () => {
  assertEquals(normalizeSensorRow({ lux: 1, status: "online" }), null);
  assertEquals(normalizeSensorRow({ sensor_id: "   ", lux: 1 }), null);
  assertEquals(normalizeSensorRow({ sensor_id: 42, lux: 1 }), null);
});

Deno.test("a non-object row is rejected rather than throwing", () => {
  for (const value of [null, undefined, "ESP32-001", 7, true]) {
    assertEquals(normalizeSensorRow(value), null);
  }
});

Deno.test("an unrecognized status becomes offline, never online", () => {
  // "online" is the claim the dashboard acts on, so anything unrecognized
  // must fail closed.
  for (const status of ["ONLINE", "Online", "unknown", "pending", null, undefined, 1]) {
    assertEquals(normalizeSensorRow({ sensor_id: "ESP32-001", status })?.status, "offline");
  }
});

Deno.test("a non-numeric lux becomes 0 rather than NaN", () => {
  assertEquals(normalizeSensorRow({ sensor_id: "ESP32-001", lux: "bright" })?.lux, 0);
  assertEquals(normalizeSensorRow({ sensor_id: "ESP32-001", lux: null })?.lux, 0);
});

Deno.test("a blank greenhouse_id becomes null, meaning unassigned", () => {
  assertEquals(normalizeSensorRow({ sensor_id: "ESP32-001", greenhouse_id: "  " })?.greenhouse_id, null);
  assertEquals(normalizeSensorRow({ sensor_id: "ESP32-001", greenhouse_id: 5 })?.greenhouse_id, null);
});

Deno.test("sensor_id is trimmed", () => {
  assertEquals(normalizeSensorRow({ sensor_id: "  ESP32-001  " })?.sensor_id, "ESP32-001");
});

Deno.test("normalizeSensorRows drops bad rows and keeps good ones", () => {
  const rows = normalizeSensorRows([
    { sensor_id: "ESP32-001", status: "online" },
    null,
    { lux: 1 },
    { sensor_id: "ESP32-002", status: "offline" },
  ]);
  assertEquals(rows.length, 2);
  assertEquals(rows.map(r => r.sensor_id), ["ESP32-001", "ESP32-002"]);
});

Deno.test("normalizeSensorRows returns an empty array for non-array input", () => {
  assertEquals(normalizeSensorRows(null), []);
  assertEquals(normalizeSensorRows({ sensor_id: "ESP32-001" }), []);
});

// ---------------------------------------------------------------------------
// filterSensors
// ---------------------------------------------------------------------------

Deno.test("a greenhouse filter returns only that greenhouse's sensors", () => {
  const sensors = [
    entry({ sensor_id: "A", greenhouse_id: "gh-001" }),
    entry({ sensor_id: "B", greenhouse_id: "gh-002" }),
    entry({ sensor_id: "C", greenhouse_id: null }),
  ];
  assertEquals(
    filterSensors(sensors, { greenhouse_id: "gh-001" }).map(s => s.sensor_id),
    ["A"],
  );
});

Deno.test("an unassigned sensor is not returned by a greenhouse filter", () => {
  const sensors = [entry({ sensor_id: "C", greenhouse_id: null })];
  assertEquals(filterSensors(sensors, { greenhouse_id: "gh-001" }), []);
});

Deno.test("a blank greenhouse_id means no filter, not match-nothing", () => {
  const sensors = [
    entry({ sensor_id: "A", greenhouse_id: "gh-001" }),
    entry({ sensor_id: "B", greenhouse_id: "gh-002" }),
  ];
  assertEquals(filterSensors(sensors, { greenhouse_id: "" }).length, 2);
  assertEquals(filterSensors(sensors, { greenhouse_id: "   " }).length, 2);
  assertEquals(filterSensors(sensors, { greenhouse_id: null }).length, 2);
});

Deno.test("a status filter narrows to that status", () => {
  const sensors = [
    entry({ sensor_id: "A", status: "online" }),
    entry({ sensor_id: "B", status: "offline" }),
  ];
  assertEquals(filterSensors(sensors, { status: "online" }).map(s => s.sensor_id), ["A"]);
  assertEquals(filterSensors(sensors, { status: "offline" }).map(s => s.sensor_id), ["B"]);
});

Deno.test("greenhouse and status filters combine", () => {
  const sensors = [
    entry({ sensor_id: "A", greenhouse_id: "gh-001", status: "online" }),
    entry({ sensor_id: "B", greenhouse_id: "gh-001", status: "offline" }),
    entry({ sensor_id: "C", greenhouse_id: "gh-002", status: "online" }),
  ];
  assertEquals(
    filterSensors(sensors, { greenhouse_id: "gh-001", status: "online" }).map(s => s.sensor_id),
    ["A"],
  );
});

// ---------------------------------------------------------------------------
// sortSensors
// ---------------------------------------------------------------------------

Deno.test("sensors sort most-recently-seen first", () => {
  const sensors = [
    entry({ sensor_id: "OLD", last_reading_at: "2026-09-29T10:00:00.000Z" }),
    entry({ sensor_id: "NEW", last_reading_at: "2026-09-29T10:30:00.000Z" }),
    entry({ sensor_id: "MID", last_reading_at: "2026-09-29T10:15:00.000Z" }),
  ];
  assertEquals(sortSensors(sensors).map(s => s.sensor_id), ["NEW", "MID", "OLD"]);
});

Deno.test("a sensor that has never reported sorts last", () => {
  const sensors = [
    entry({ sensor_id: "NEVER", last_reading_at: null }),
    entry({ sensor_id: "LIVE", last_reading_at: "2020-01-01T00:00:00.000Z" }),
  ];
  assertEquals(sortSensors(sensors).map(s => s.sensor_id), ["LIVE", "NEVER"]);
});

Deno.test("ties break on sensor_id so the order is stable across polls", () => {
  const same = "2026-09-29T10:30:00.000Z";
  const sensors = [
    entry({ sensor_id: "ESP32-002", last_reading_at: same }),
    entry({ sensor_id: "ESP32-001", last_reading_at: same }),
  ];
  assertEquals(sortSensors(sensors).map(s => s.sensor_id), ["ESP32-001", "ESP32-002"]);
  // Sorting must not mutate the caller's array.
  assertEquals(sensors[0].sensor_id, "ESP32-002");
});

// ---------------------------------------------------------------------------
// parseQuery
// ---------------------------------------------------------------------------

Deno.test("parseQuery reads the greenhouse and status filters", () => {
  const query = parseQuery(new URLSearchParams("greenhouse_id=gh-001&status=online"));
  assertEquals(query, { greenhouse_id: "gh-001", status: "online" });
});

Deno.test("parseQuery treats an unrecognized status as no filter", () => {
  assertEquals(parseQuery(new URLSearchParams("status=bogus")).status, null);
  assertEquals(parseQuery(new URLSearchParams("status=")).status, null);
});

Deno.test("parseQuery tolerates missing parameters", () => {
  assertEquals(parseQuery(new URLSearchParams()), { greenhouse_id: null, status: null });
});

// ---------------------------------------------------------------------------
// buildSensorList
// ---------------------------------------------------------------------------

Deno.test("buildSensorList normalizes, filters and orders in one pass", () => {
  const rows = [
    { sensor_id: "B", lux: 5, status: "online", greenhouse_id: "gh-001", last_reading_at: "2026-09-29T10:00:00.000Z" },
    { sensor_id: "A", lux: 6, status: "ONLINE", greenhouse_id: "gh-001", last_reading_at: "2026-09-29T10:30:00.000Z" },
    { sensor_id: "C", lux: 7, status: "online", greenhouse_id: "gh-002", last_reading_at: "2026-09-29T11:00:00.000Z" },
    { sensor_id: "", status: "online", greenhouse_id: "gh-001" },
  ];
  const result = buildSensorList(rows, { greenhouse_id: "gh-001" });
  assertEquals(result.map(s => s.sensor_id), ["A", "B"]);
  // The bad-cased "ONLINE" was normalized to offline rather than trusted; the
  // genuinely-online row is untouched.
  assertEquals(result.find(s => s.sensor_id === "A")?.status, "offline");
  assertEquals(result.find(s => s.sensor_id === "B")?.status, "online");
});

Deno.test("buildSensorList returns an empty array for no rows", () => {
  assertEquals(buildSensorList(null, {}), []);
  assertEquals(buildSensorList([], {}), []);
});
