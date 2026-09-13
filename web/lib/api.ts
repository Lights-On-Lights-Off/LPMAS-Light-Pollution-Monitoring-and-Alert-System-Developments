import { supabase } from "./supabase";

// If NEXT_PUBLIC_PI_API_URL is set (e.g. local dev pointed at a LAN IP, or a
// future permanent domain), it is used as-is and none of the dynamic lookup
// below runs. Otherwise the current Pi address is resolved at request time
// from /api/pi-url, since a Cloudflare Quick Tunnel URL rotates and can't be
// baked into the build like a normal NEXT_PUBLIC_* value.
const STATIC_BASE_URL = process.env.NEXT_PUBLIC_PI_API_URL;
const LAN_FALLBACK_URL = "http://192.168.100.144:5000";
const PI_URL_CACHE_MS = 60_000;

let cachedBaseUrl: string | null = null;
let cachedAt = 0;

async function resolveBaseUrl(forceRefresh = false): Promise<string> {
  if (STATIC_BASE_URL) return STATIC_BASE_URL;

  const isFresh = cachedBaseUrl !== null && Date.now() - cachedAt < PI_URL_CACHE_MS;
  if (isFresh && !forceRefresh) return cachedBaseUrl as string;

  try {
    const response = await fetch("/api/pi-url", { cache: "no-store" });
    if (!response.ok) throw new Error(`pi-url lookup failed (${response.status})`);
    const body = await response.json();
    if (typeof body.url !== "string" || !body.url) throw new Error("pi-url response missing url");
    const resolvedUrl: string = body.url;
    cachedBaseUrl = resolvedUrl;
    cachedAt = Date.now();
    return resolvedUrl;
  } catch (error) {
    if (cachedBaseUrl) return cachedBaseUrl;
    console.error("[api] falling back to LAN address, pi-url lookup failed:", error);
    return LAN_FALLBACK_URL;
  }
}

function isStaleUrlStatus(status: number) {
  return status === 502 || status === 503 || status === 504;
}

async function requestOnce(baseUrl: string, path: string, init?: RequestInit) {
  const token = (await supabase?.auth.getSession())?.data.session?.access_token;
  return fetch(`${baseUrl}${path}`, {
    ...init,
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

export type Phase = { id: number | null; greenhouse_id: string | null; phase_type: "illumination" | "dark"; starts_on: string; ends_on: string; window_start: string | null; window_end: string | null; is_active: number };
export type Reading = { id: number; sensor_id: string; greenhouse_id: string | null; lux: number; recorded_at: string; classification: "safe" | "warning" | "violation"; phase_type: string };
export type Incident = { id: number; sensor_id: string; greenhouse_id: string | null; phase_type: string; opened_at: string; resolved_at: string | null; status: "open" | "acknowledged" | "resolved"; peak_lux: number | null; lowest_lux: number | null; reason: string };
export type Greenhouse = { id: string; name: string; phase_start: string; phase_end: string; window_start: string; window_end: string; is_active: number; updated_at: string; sensor_ids: string[] };
export type DashboardSummary = { phase: Phase | null; readings: Reading[]; incidents: Incident[]; generatedAt: string };
export type HardwareActivityResponse = { readings: Reading[]; count: number };
export type MinuteAggregate = { id: number; sensor_id: string; greenhouse_id: string | null; bucket_start: string; phase_type: "illumination" | "dark"; sample_count: number; avg_lux: number; min_lux: number; max_lux: number; safe_count: number; warning_count: number; violation_count: number; updated_at: string };

export const getDashboardSummary = () => api<DashboardSummary>("/api/dashboard");
export const getGreenhouses = () => api<Greenhouse[]>("/api/greenhouses");
export const saveGreenhouse = (greenhouse: { id: string; name: string; sensor_ids: string[]; phase_start: string; phase_end: string; window_start: string; window_end: string }) => api<Greenhouse>("/api/greenhouses", { method: "POST", body: JSON.stringify(greenhouse) });
export const getReadings = (sensorId?: string, limit = 100, start?: string, end?: string) => { const params = new URLSearchParams(); params.set("limit", limit.toString()); if (sensorId) params.set("sensor_id", sensorId); if (start) params.set("start", start); if (end) params.set("end", end); return api<Reading[]>(`/api/readings?${params.toString()}`); };
export const getActivePhase = () => api<Phase | null>("/api/phase/active");
export const getIncidents = (status?: Incident["status"]) => api<Incident[]>(`/api/incidents${status ? `?status=${status}` : ""}`);
export const acknowledgeIncident = (id: number) => api<{ status: string }>(`/api/incidents/${id}/acknowledge`, { method: "POST" });
export const getHardwareActivity = (greenhouseId?: string, sensorIds: string[] = [], start?: string, end?: string) => { const params = new URLSearchParams(); if (greenhouseId) params.set("greenhouse_id", greenhouseId); sensorIds.forEach(id => params.append("sensor_id", id)); if (start) params.set("start", start); if (end) params.set("end", end); return api<HardwareActivityResponse>(`/api/hardware-activity?${params.toString()}`); };