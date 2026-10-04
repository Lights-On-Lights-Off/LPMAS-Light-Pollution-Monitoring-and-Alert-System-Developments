import { validatePiUrl } from "./pi-url";
import { supabase } from "./supabase";
import { buildSensorList, filterSensors } from "./sensor-list";

// If NEXT_PUBLIC_PI_API_URL is set (e.g. local dev pointed at a LAN IP, or a
// future permanent domain), it is used as-is and none of the dynamic lookup
// below runs. Otherwise the current Pi address is resolved at request time
// from /api/pi-url, since a Cloudflare Quick Tunnel URL rotates and can't be
// baked into the build like a normal NEXT_PUBLIC_* value.
const STATIC_BASE_URL = process.env.NEXT_PUBLIC_PI_API_URL;
const PI_URL_CACHE_MS = 60_000;

let cachedBaseUrl: string | null = null;
let cachedAt = 0;

async function resolveBaseUrl(forceRefresh = false): Promise<string> {
  if (STATIC_BASE_URL) return validatePiUrl(STATIC_BASE_URL,process.env.NODE_ENV !== "production");

  const isFresh = cachedBaseUrl !== null && Date.now() - cachedAt < PI_URL_CACHE_MS;
  if (isFresh && !forceRefresh) return cachedBaseUrl as string;

  try {
    const response = await fetch("/api/pi-url", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`pi-url lookup failed (${response.status})`);
    const body = await response.json();
    if (typeof body.url !== "string" || !body.url) throw new Error("pi-url response missing url");
    const resolvedUrl = validatePiUrl(body.url,process.env.NODE_ENV !== "production");
    cachedBaseUrl = resolvedUrl;
    cachedAt = Date.now();
    return resolvedUrl;
  } catch (error) {
    if (cachedBaseUrl) return cachedBaseUrl;
    throw new Error("Pi address unavailable. Configure its HTTPS endpoint or an explicit local development URL.");
  }
}

function isStaleUrlStatus(status: number) {
  return status === 502 || status === 503 || status === 504;
}

async function requestOnce(baseUrl: string, path: string, init?: RequestInit) {
  const protectedRequest = path.startsWith('/api/hardware-activity') ||
    path.startsWith('/api/readings') || path.includes('/acknowledge');
  const token = protectedRequest ? (await supabase?.auth.getSession())?.data.session?.access_token : undefined;
  return fetch(`${baseUrl}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers }
  });
}

async function requestWithRetry(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = await resolveBaseUrl();

  if (STATIC_BASE_URL) return requestOnce(baseUrl, path, init);

  try {
    const response = await requestOnce(baseUrl, path, init);
    if (isStaleUrlStatus(response.status)) {
      const freshBaseUrl = await resolveBaseUrl(true);
      if (freshBaseUrl !== baseUrl) return requestOnce(freshBaseUrl, path, init);
    }
    return response;
  } catch (error) {
    // Likely the cached tunnel URL just rotated out from under us; refresh
    // once and retry before giving up.
    const freshBaseUrl = await resolveBaseUrl(true);
    if (freshBaseUrl !== baseUrl) return requestOnce(freshBaseUrl, path, init);
    throw error;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await requestWithRetry(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.json();
}

import type { Phase, Reading, Incident, Greenhouse, DashboardSummary, HardwareActivityResponse, MinuteAggregate } from "./monitoring-types";
export type { Phase, Reading, Incident, Greenhouse, DashboardSummary, HardwareActivityResponse, MinuteAggregate } from "./monitoring-types";

export const getDashboardSummary = () => api<DashboardSummary>("/api/dashboard");

// Greenhouse configuration lives in Supabase now (see
// 0006_greenhouse_config.sql), not the Pi — reads go straight to the
// greenhouses/greenhouse_sensors tables, and writes go through the
// upsert_greenhouse()/delete_greenhouse() RPC functions rather than any
// direct table insert (this project never lets client keys write tables
// directly; see the migration's own comments).
function toHHMM(value: string) {
  // Postgres `time` columns come back from PostgREST as "HH:MM:SS";
  // <input type="time"> and the existing card display both expect "HH:MM".
  return value.slice(0, 5);
}

type GreenhouseRow = {
  id: string;
  name: string;
  phase_start: string;
  phase_end: string;
  window_start: string;
  window_end: string;
  is_active: boolean;
  updated_at: string;
  greenhouse_sensors: { sensor_id: string }[] | null;
};

export async function getGreenhouses(): Promise<Greenhouse[]> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase
    .from("greenhouses")
    .select("id, name, phase_start, phase_end, window_start, window_end, is_active, updated_at, greenhouse_sensors(sensor_id)")
    .eq("is_active", true)
    .order("name", { ascending: true }).abortSignal(AbortSignal.timeout(10_000));

  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as GreenhouseRow[]).map(row => ({
    id: row.id,
    name: row.name,
    phase_start: row.phase_start,
    phase_end: row.phase_end,
    window_start: toHHMM(row.window_start),
    window_end: toHHMM(row.window_end),
    is_active: row.is_active ? 1 : 0,
    updated_at: row.updated_at,
    sensor_ids: (row.greenhouse_sensors ?? []).map(s => s.sensor_id)
  }));
}

export async function saveGreenhouse(greenhouse: { id: string; name: string; sensor_ids: string[]; phase_start: string; phase_end: string; window_start: string; window_end: string }): Promise<Greenhouse> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc("upsert_greenhouse", {
    p_id: greenhouse.id,
    p_name: greenhouse.name,
    p_sensor_ids: greenhouse.sensor_ids,
    p_phase_start: greenhouse.phase_start,
    p_phase_end: greenhouse.phase_end,
    p_window_start: greenhouse.window_start,
    p_window_end: greenhouse.window_end
  });

  if (error) throw new Error(error.message);

  const row = data as GreenhouseRow;
  return {
    id: row.id,
    name: row.name,
    phase_start: row.phase_start,
    phase_end: row.phase_end,
    window_start: toHHMM(row.window_start),
    window_end: toHHMM(row.window_end),
    is_active: row.is_active ? 1 : 0,
    updated_at: row.updated_at,
    sensor_ids: greenhouse.sensor_ids
  };
}

export async function deleteGreenhouse(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.rpc("delete_greenhouse", { p_id: id });
  if (error) throw new Error(error.message);
}

export const getReadings = (sensorId?: string, limit = 100, start?: string, end?: string) => { const params = new URLSearchParams(); params.set("limit", limit.toString()); if (sensorId) params.set("sensor_id", sensorId); if (start) params.set("start", start); if (end) params.set("end", end); return api<Reading[]>(`/api/readings?${params.toString()}`); };
export const getActivePhase = () => api<Phase | null>("/api/phase/active");
export const getIncidents = (status?: Incident["status"]) => api<Incident[]>(`/api/incidents${status ? `?status=${status}` : ""}`);
export const acknowledgeIncident = (id: number, incidentUid?: string) => api<{ status: string }>(`/api/incidents/${id}/acknowledge`, { method: "POST", body: JSON.stringify({incident_uid:incidentUid}) });
export async function getHardwareActivity(greenhouseId?: string, sensorIds: string[] = [], start?: string, end?: string): Promise<HardwareActivityResponse> {
  const params = new URLSearchParams({start:start ?? new Date(Date.now()-86400000).toISOString(), end:end ?? new Date().toISOString()});
  if (greenhouseId) params.set('greenhouse_id', greenhouseId);
  sensorIds.forEach(id => params.append('sensor_id', id));
  const readings: Reading[] = [];
  let cursor = 0;
  while (true) {
    params.set('after_id', String(cursor));
    const page = await api<HardwareActivityResponse & {next_after_id?: number | null}>(`/api/hardware-activity?${params}`);
    readings.push(...page.readings);
    if (page.next_after_id == null) break;
    if (page.next_after_id <= cursor || readings.length >= 250_000) throw new Error('History export is too large; choose a shorter date range.');
    cursor = page.next_after_id;
  }
  readings.sort((a,b) => Date.parse(a.recorded_at)-Date.parse(b.recorded_at) || a.id-b.id);
  return {readings, count:readings.length};
}

// --- sensor_list ------------------------------------------------------------
//
// Read directly from Supabase rather than through the Pi: sensor_list lives
// only in the cloud, and migration 0009 grants SELECT to anon/authenticated.
// Writes go through the update_sensor_list RPC instead, so a browser can
// never invent a lux value or flip a sensor's status.

import type { SensorListEntry } from "./sensor-list";
export type { SensorListEntry };

/**
 * Every sensor the cloud knows about, most recently seen first.
 *
 * Filtering is applied client-side through the same tested helpers the API
 * route uses, so the Monitor and Manager views and the route can never
 * disagree about what "online sensors for gh-001" means.
 */
export async function getSensorList(): Promise<SensorListEntry[]> {
  if (!supabase) throw new Error("Supabase is not configured");

  const { data, error } = await supabase
    .from("sensor_list")
    .select("sensor_id,lux,status,last_reading_at,greenhouse_id,created_at,updated_at").abortSignal(AbortSignal.timeout(10_000));

  if (error) throw new Error(error.message);

  return buildSensorList(data, {});
}

/** The sensors assigned to a greenhouse that are currently reporting. */
export async function getOnlineSensors(greenhouseId: string): Promise<SensorListEntry[]> {
  const sensors = await getSensorList();
  return filterSensors(sensors, { greenhouse_id: greenhouseId, status: "online" });
}

/**
 * Assign or unassign one sensor immediately, outside the greenhouse form.
 *
 * Goes through /api/sensor-assign rather than a direct RPC call so the
 * server can check the caller's role: the RPC is SECURITY DEFINER and
 * only performs its own check when auth.uid() is set, which a
 * service_role call does not have.
 */
export async function assignSensor(
  sensorId: string,
  greenhouseId: string,
  isAssignedNow: boolean
): Promise<void> {
  const response = await fetch("/api/sensor-assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sensor_id: sensorId,
      greenhouse_id: greenhouseId,
      is_assigned_now: isAssignedNow,
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `Sensor assignment failed (${response.status})`);
  }
}
