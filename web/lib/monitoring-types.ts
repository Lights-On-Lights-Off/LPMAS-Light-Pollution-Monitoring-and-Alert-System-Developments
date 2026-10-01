export type Phase = {
  id: number | null;
  greenhouse_id: string | null;
  phase_type: "illumination" | "dark";
  starts_on: string;
  ends_on: string;
  window_start: string | null;
  window_end: string | null;
  is_active: number;
};
export type Reading = {
  id: number;
  sensor_id: string;
  greenhouse_id: string | null;
  lux: number;
  recorded_at: string;
  classification: "safe" | "warning" | "violation" | "unclassified";
  phase_type: string;
};
export type Incident = {
  id: number;
  sensor_id: string;
  greenhouse_id: string | null;
  phase_type: string;
  opened_at: string;
  resolved_at: string | null;
  status: "open" | "acknowledged" | "resolved";
  peak_lux: number | null;
  lowest_lux: number | null;
  reason: string;
  config_version?: string | null;
  resolution_reason?: "safe_reading" | "phase_ended" | "assignment_changed" |
    "configuration_changed" | "monitoring_window_ended" | null;
  incident_uid?: string;
  version?: number;
  incident_version?: number;
  triggering_readings?: string | Reading[];
};
export type Greenhouse = {
  id: string;
  name: string;
  phase_start: string;
  phase_end: string;
  window_start: string;
  window_end: string;
  is_active: number;
  updated_at: string;
  sensor_ids: string[];
};
export type DashboardSummary = {
  phase: Phase | null;
  readings: Reading[];
  incidents: Incident[];
  generatedAt: string;
  deliveryHealth?: {
    pending: number;
    oldestPendingAt: string | null;
    failedAttempts: number;
    configured: boolean;
  };
};
export type HardwareActivityResponse = { readings: Reading[]; count: number };
export type MinuteAggregate = {
  id: number;
  sensor_id: string;
  greenhouse_id: string | null;
  bucket_start: string;
  phase_type: "illumination" | "dark";
  sample_count: number;
  avg_lux: number;
  min_lux: number;
  max_lux: number;
  safe_count: number;
  warning_count: number;
  violation_count: number;
  updated_at: string;
  config_version?: string;
  last_recorded_at?: string;
};
