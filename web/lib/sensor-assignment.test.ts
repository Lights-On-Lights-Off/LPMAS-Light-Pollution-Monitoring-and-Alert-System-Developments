/**
 * Tests for sensor assignment planning.
 *
 * The load-bearing detail here is that unassigning uses p_clear_greenhouse.
 * A null p_greenhouse_id means "leave the assignment unchanged" to the RPC,
 * so unassigning that way is a silent no-op that would leave a manager
 * clicking a checkbox forever.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  assignmentRpcArgs,
  buildAssignmentMap,
  partitionSensors,
  planAssignment,
} from "./sensor-assignment.ts";

// ---------------------------------------------------------------------------
// planAssignment
// ---------------------------------------------------------------------------

Deno.test("a sensor that is not assigned is planned as an assign", () => {
  const action = planAssignment({
    sensorId: "ESP32-001",
    greenhouseId: "gh-001",
    isAssignedNow: false,
  });
  assertEquals(action, {
    kind: "assign",
    sensorId: "ESP32-001",
    greenhouseId: "gh-001",
  });
});

Deno.test("a sensor that is already assigned is planned as an unassign", () => {
  const action = planAssignment({
    sensorId: "ESP32-001",
    greenhouseId: "gh-001",
    isAssignedNow: true,
  });
  assertEquals(action, { kind: "unassign", sensorId: "ESP32-001" });
});

Deno.test("a blank sensor or greenhouse is a no-op, not a malformed request", () => {
  assertEquals(
    planAssignment({ sensorId: "  ", greenhouseId: "gh-001", isAssignedNow: false }).kind,
    "noop",
  );
  assertEquals(
    planAssignment({ sensorId: "ESP32-001", greenhouseId: "  ", isAssignedNow: false }).kind,
    "noop",
  );
});

Deno.test("ids are trimmed before planning", () => {
  assertEquals(
    planAssignment({ sensorId: " ESP32-001 ", greenhouseId: " gh-001 ", isAssignedNow: false }),
    { kind: "assign", sensorId: "ESP32-001", greenhouseId: "gh-001" },
  );
});

// ---------------------------------------------------------------------------
// assignmentRpcArgs
// ---------------------------------------------------------------------------

Deno.test("an assign targets the greenhouse and never touches liveness", () => {
  const args = assignmentRpcArgs(
    planAssignment({ sensorId: "ESP32-001", greenhouseId: "gh-001", isAssignedNow: false }),
  );
  assertEquals(args, {
    p_sensor_id: "ESP32-001",
    p_greenhouse_id: "gh-001",
    p_reading: false,
  });
});

Deno.test("an assign must not clear the greenhouse, or the RPC rejects it", () => {
  const args = assignmentRpcArgs(
    planAssignment({ sensorId: "ESP32-001", greenhouseId: "gh-001", isAssignedNow: false }),
  )!;
  assertEquals(args.p_clear_greenhouse, undefined);
});

Deno.test("an unassign uses p_clear_greenhouse, not a null greenhouse", () => {
  const args = assignmentRpcArgs(
    planAssignment({ sensorId: "ESP32-001", greenhouseId: "gh-001", isAssignedNow: true }),
  )!;
  // A null p_greenhouse_id is the RPC's "leave unchanged" signal, so this is
  // the one field that must be set for the clear to happen at all.
  assertEquals(args.p_clear_greenhouse, true);
  assertEquals(args.p_greenhouse_id, null);
  assertEquals(args.p_sensor_id, "ESP32-001");
  assertEquals(args.p_reading, false);
});

Deno.test("an assignment never sets a lux value", () => {
  // Passing p_lux with p_reading false is harmless today, but the RPC only
  // guards lux when p_reading is true, so omitting it keeps the contract
  // honest if that guard ever changes.
  for (const isAssigned of [false, true]) {
    const args = assignmentRpcArgs(
      planAssignment({ sensorId: "ESP32-001", greenhouseId: "gh-001", isAssignedNow: isAssigned }),
    )!;
    assertEquals(args.p_lux, undefined);
  }
});

Deno.test("a no-op produces no RPC arguments", () => {
  assertEquals(
    assignmentRpcArgs(planAssignment({ sensorId: "", greenhouseId: "gh-001", isAssignedNow: false })),
    null,
  );
});

// ---------------------------------------------------------------------------
// buildAssignmentMap
// ---------------------------------------------------------------------------

Deno.test("the assignment map records which greenhouse owns each sensor", () => {
  const map = buildAssignmentMap([
    { id: "gh-001", sensorIds: ["A", "B"] },
    { id: "gh-002", sensorIds: ["C"] },
  ]);
  assertEquals(map.get("A"), "gh-001");
  assertEquals(map.get("B"), "gh-001");
  assertEquals(map.get("C"), "gh-002");
});

Deno.test("a sensor listed under two greenhouses keeps the first", () => {
  const map = buildAssignmentMap([
    { id: "gh-001", sensorIds: ["A"] },
    { id: "gh-002", sensorIds: ["A"] },
  ]);
  assertEquals(map.get("A"), "gh-001");
});

Deno.test("an empty configuration produces an empty map", () => {
  assertEquals(buildAssignmentMap([]).size, 0);
});

// ---------------------------------------------------------------------------
// partitionSensors
// ---------------------------------------------------------------------------

Deno.test("sensors are split into assigned and available", () => {
  const assignment = buildAssignmentMap([
    { id: "gh-001", sensorIds: ["A"] },
    { id: "gh-002", sensorIds: ["B"] },
  ]);
  const { assigned, available } = partitionSensors(["A", "B", "C"], assignment, "gh-001");
  assertEquals(assigned, ["A"]);
  assertEquals(available, ["C"]);
});

Deno.test("a sensor assigned elsewhere is in neither list", () => {
  // It is not free to take, and listing it as available would invite a
  // second assignment the RPC would then have to reject.
  const assignment = buildAssignmentMap([{ id: "gh-002", sensorIds: ["B"] }]);
  const { assigned, available } = partitionSensors(["B"], assignment, "gh-001");
  assertEquals(assigned, []);
  assertEquals(available, []);
});

Deno.test("every unassigned sensor is available", () => {
  const { available } = partitionSensors(["A", "B", "C"], new Map(), "gh-001");
  assertEquals(available, ["A", "B", "C"]);
});

Deno.test("partitioning preserves the caller's sensor order", () => {
  const { available } = partitionSensors(["Z", "A", "M"], new Map(), "gh-001");
  assertEquals(available, ["Z", "A", "M"]);
});

Deno.test("partitioning no sensors yields empty lists, not an error", () => {
  const { assigned, available } = partitionSensors([], new Map(), "gh-001");
  assert(assigned.length === 0 && available.length === 0);
});
