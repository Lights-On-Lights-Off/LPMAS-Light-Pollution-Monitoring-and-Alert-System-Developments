/**
 * Pure logic for the sensor_list API.
 *
 * Kept separate from the route handler so it can be tested without a Next
 * server, a Supabase project, or a request. Everything here is a pure
 * function over plain data.
 *
 * Ruling: sensor_list is read with the service role on the server and
 * filtered HERE rather than with a PostgREST `.eq()` chain. The filter
 * logic is the part that can be wrong in a way that leaks another
 * greenhouse's sensors, so it wants direct tests.
 */

export interface SensorListEntry {
  sensor_id: string;
  lux: number;
  status: "online" | "offline";
  last_reading_at: string | null;
  greenhouse_id: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface SensorListQuery {
  greenhouse_id?: string | null;
  status?: "online" | "offline" | null;
}

/** Validates a raw DB row, or returns null when it cannot be trusted. */
export function normalizeSensorRow(row: unknown): SensorListEntry | null {
  if (!row || typeof row !== "object") return null;
  const candidate = row as Record<string, unknown>;

  const sensorId = candidate.sensor_id;
  if (typeof sensorId !== "string" || !sensorId.trim()) return null;

  const status = candidate.status;
  // An unrecognized status is normalized to offline rather than passed
  // through: a sensor the cloud cannot vouch for must never be displayed as
  // online, and "online" is the claim that drives the dashboard.
  const normalizedStatus: "online" | "offline" = status === "online" ? "online" : "offline";

  const lux = Number(candidate.lux);
  const greenhouseId = candidate.greenhouse_id;

  return {
    sensor_id: sensorId.trim(),
    lux: Number.isFinite(lux) ? lux : 0,
    status: normalizedStatus,
    last_reading_at: typeof candidate.last_reading_at === "string" ? candidate.last_reading_at : null,
    greenhouse_id: typeof greenhouseId === "string" && greenhouseId.trim() ? greenhouseId : null,
    created_at: typeof candidate.created_at === "string" ? candidate.created_at : undefined,
    updated_at: typeof candidate.updated_at === "string" ? candidate.updated_at : undefined,
  };
}

export function normalizeSensorRows(rows: unknown): SensorListEntry[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(normalizeSensorRow)
    .filter((entry): entry is SensorListEntry => entry !== null);
}

/**
 * Applies the query filters.
 *
 * A blank greenhouse_id is treated as "no filter" rather than "match only
 * unassigned sensors", because the UI sends an empty string when no
 * greenhouse is selected and showing nothing then would read as a bug.
 */
export function filterSensors(
  entries: SensorListEntry[],
  query: SensorListQuery,
): SensorListEntry[] {
  const greenhouseId = query.greenhouse_id?.trim();
  const status = query.status;

  return entries.filter(entry => {
    if (greenhouseId && entry.greenhouse_id !== greenhouseId) return false;
    if (status && entry.status !== status) return false;
    return true;
  });
}

/** Sorts most-recently-seen first, then by id, so the order is stable. */
export function sortSensors(entries: SensorListEntry[]): SensorListEntry[] {
  return [...entries].sort((a, b) => {
    const aTime = a.last_reading_at ? Date.parse(a.last_reading_at) : 0;
    const bTime = b.last_reading_at ? Date.parse(b.last_reading_at) : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.sensor_id.localeCompare(b.sensor_id);
  });
}

/** Parses a searchParams value into a validated query. */
export function parseQuery(params: URLSearchParams): SensorListQuery {
  const rawStatus = params.get("status");
  const status =
    rawStatus === "online" || rawStatus === "offline" ? rawStatus : null;
  return {
    greenhouse_id: params.get("greenhouse_id"),
    status,
  };
}

/** Full pipeline: DB rows in, filtered and ordered sensors out. */
export function buildSensorList(rows: unknown, query: SensorListQuery): SensorListEntry[] {
  return sortSensors(filterSensors(normalizeSensorRows(rows), query));
}
