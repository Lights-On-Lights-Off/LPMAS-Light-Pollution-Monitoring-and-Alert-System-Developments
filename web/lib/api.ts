import { supabase } from "./supabase";

const baseUrl = process.env.NEXT_PUBLIC_PI_API_URL ?? "http://192.168.100.142:5000";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = (await supabase?.auth.getSession())?.data.session?.access_token;
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }

  return response.json();
}

export type Phase = {
  id: number;
  phase_type: "illumination" | "dark";
  starts_on: string;
  ends_on: string;
  window_start: string | null;
  window_end: string | null;
  lux_min: number | null;
  lux_max: number | null;
  lux_ceiling: number | null;
  is_active: number;
};

export type Reading = {
  id: number;
  sensor_id: string;
  lux: number;
  recorded_at: string;
  classification: "safe" | "warning" | "violation";
  phase_type: string;
};

export type Incident = {
  id: number;
  sensor_id: string;
  phase_type: string;
  opened_at: string;
  resolved_at: string | null;
  status: "open" | "acknowledged" | "resolved";
  peak_lux: number | null;
  lowest_lux: number | null;
  reason: string;
};

export type DashboardSummary = {
  phase: Phase | null;
  readings: Reading[];
  incidents: Incident[];
  generatedAt: string;
};

export const getDashboardSummary = async (): Promise<DashboardSummary> => {
  const readings = await getReadings(undefined, 100);
  return { phase: null, readings, incidents: [], generatedAt: new Date().toISOString() };
};

export const getReadings = (sensorId?: string, limit = 100) =>
  api<Reading[]>(`/readings?limit=${limit}${sensorId ? `&sensor_id=${encodeURIComponent(sensorId)}` : ""}`);

export const getActivePhase = () => api<Phase | null>("/phase/active");
export const getIncidents = (status?: Incident["status"]) => api<Incident[]>(`/incidents${status ? `?status=${status}` : ""}`);
export const acknowledgeIncident = (id: number) => api<{ status: string }>(`/incidents/${id}/acknowledge`, { method: "POST" });