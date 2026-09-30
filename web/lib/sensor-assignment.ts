/**
 * Pure logic for assigning sensors to greenhouses.
 *
 * The RPC (update_sensor_list) is the authority on authorization and on
 * whether the greenhouse exists; it also refuses a contradictory call
 * ("assign gh-001 and clear the assignment" at once). What lives here is
 * deciding WHICH of assign / unassign / no-op a toggle means, and turning
 * the caller's request into that one unambiguous shape.
 *
 * Unassigning must use p_clear_greenhouse rather than sending a null
 * greenhouse_id: the RPC treats a null greenhouse as "leave the assignment
 * unchanged", so passing null would silently do nothing and the manager
 * would see a checkbox that refuses to clear.
 */

export type AssignmentAction =
  | { kind: "assign"; sensorId: string; greenhouseId: string }
  | { kind: "unassign"; sensorId: string }
  | { kind: "noop"; reason: string };

/**
 * Decides what a sensor toggle should do.
 *
 * `isAssignedNow` is the manager's current view, not the sensor's row, so
 * a stale list cannot make a click silently re-apply the same assignment.
 */
export function planAssignment(options: {
  sensorId: string;
  greenhouseId: string;
  isAssignedNow: boolean;
}): AssignmentAction {
  const sensorId = options.sensorId.trim();
  const greenhouseId = options.greenhouseId.trim();

  if (!sensorId) return { kind: "noop", reason: "sensor_id is required" };
  if (!greenhouseId) return { kind: "noop", reason: "greenhouse_id is required" };

  return options.isAssignedNow
    ? { kind: "unassign", sensorId }
    : { kind: "assign", sensorId, greenhouseId };
}

/** The RPC argument object for a planned action. */
export function assignmentRpcArgs(
  action: AssignmentAction,
): Record<string, unknown> | null {
  if (action.kind === "assign") {
    return {
      p_sensor_id: action.sensorId,
      p_greenhouse_id: action.greenhouseId,
      p_reading: false,
    };
  }

  if (action.kind === "unassign") {
    // p_clear_greenhouse, NOT a null p_greenhouse_id: a null greenhouse means
    // "leave unchanged" to the RPC, so unassigning that way is a silent no-op.
    return {
      p_sensor_id: action.sensorId,
      p_greenhouse_id: null,
      p_clear_greenhouse: true,
      p_reading: false,
    };
  }

  return null;
}

/**
 * The greenhouse each sensor is assigned to, keyed by sensor id.
 * A sensor appearing in two greenhouses' lists keeps the first, matching
 * the "one sensor, one greenhouse" rule the dashboard already assumes.
 */
export function buildAssignmentMap(
  greenhouses: { id: string; sensorIds: string[] }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const greenhouse of greenhouses) {
    for (const sensorId of greenhouse.sensorIds) {
      if (!map.has(sensorId)) map.set(sensorId, greenhouse.id);
    }
  }
  return map;
}

/** Splits every known sensor into assigned and available for a greenhouse. */
export function partitionSensors(
  allSensorIds: string[],
  assignment: Map<string, string>,
  greenhouseId: string,
): { assigned: string[]; available: string[] } {
  const assigned: string[] = [];
  const available: string[] = [];

  for (const sensorId of allSensorIds) {
    if (assignment.get(sensorId) === greenhouseId) assigned.push(sensorId);
    else if (!assignment.has(sensorId)) available.push(sensorId);
    // A sensor assigned to a DIFFERENT greenhouse is in neither list: it is
    // not free to take, and showing it here would invite a second
    // assignment that the RPC would then have to reject.
  }

  return { assigned, available };
}
