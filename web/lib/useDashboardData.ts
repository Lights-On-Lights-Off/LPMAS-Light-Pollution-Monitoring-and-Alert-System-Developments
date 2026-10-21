"use client";
import { useMemo, useSyncExternalStore } from "react";
import { getGreenhouses, type Incident, type MinuteAggregate } from "./api";
import { supabase } from "./supabase";
import { resolveSensorMonitoring } from "./monitoring-state";
import { createDashboardStore, INITIAL_DASHBOARD_STATE } from "./dashboard-store";
import { buildSensorList } from "./sensor-list";
import { currentReadingFreshness } from "./reading-freshness";

const store = createDashboardStore({
  async sensors() {
    if (!supabase) throw new Error("Cloud monitoring is not configured");
    // Finish or time out before the next 10-second check is due.
    const result = await supabase.from("sensor_list")
      .select("sensor_id,lux,status,last_reading_at,greenhouse_id,created_at,updated_at")
      .abortSignal(AbortSignal.timeout(8000));
    if (result.error) throw new Error(result.error.message);
    return buildSensorList(result.data, {});
  },
  async aggregates() {
    if (!supabase) throw new Error("Cloud monitoring is not configured");
    const result = await supabase.from("sensor_minute_aggregates").select("*")
      .order("bucket_start", { ascending: false }).limit(300).abortSignal(AbortSignal.timeout(10_000));
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []) as MinuteAggregate[];
  },
  async incidents() {
    if (!supabase) throw new Error("Cloud monitoring is not configured");
    const result = await supabase.from("monitoring_incidents").select("*")
      .order("opened_at", { ascending: false }).limit(100).abortSignal(AbortSignal.timeout(10_000));
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map(row => ({ ...row, id: row.pi_incident_id })) as Incident[];
  },
  async configuration() {
    if (!supabase) throw new Error("Cloud monitoring is not configured");
    const [greenhouses, result] = await Promise.all([
      getGreenhouses(), supabase.rpc("monitoring_policy").abortSignal(AbortSignal.timeout(10_000)),
    ]);
    if (result.error) throw new Error(result.error.message);
    return { greenhouses, policy: result.data ?? INITIAL_DASHBOARD_STATE.policy };
  },
});

// Manual refresh joins existing work instead of queuing repeated requests.
export const refreshDashboard = () => store.refresh();
function subscribe(listener: () => void) {
  const unsubscribe = store.subscribe(listener);
  const resume = () => { if (document.visibilityState === "visible") void store.refresh(); };
  document.addEventListener("visibilitychange", resume);
  return () => { unsubscribe(); document.removeEventListener("visibilitychange", resume); };
}
export function useDashboardData() {
  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, () => INITIAL_DASHBOARD_STATE);
  const resolved = useMemo(() => resolveSensorMonitoring(snapshot.sensors, [], snapshot.greenhouses, {
    now: snapshot.now, offlineThresholdSeconds: snapshot.policy.offline_threshold_seconds,
    registryFetchedAt: snapshot.sensorsFetchedAt, piFetchedAt: null,
    registryError: snapshot.sensorError, piError: null,
    configurationKnown: snapshot.configurationFetchedAt !== null,
  }), [snapshot]);
  const sensorHealthById = useMemo(() => Object.fromEntries(resolved.sensors.map(sensor => {
    const status = currentReadingFreshness(sensor.last_reading_at, snapshot.sensorsFetchedAt, snapshot.now,
      snapshot.policy.offline_threshold_seconds, snapshot.sensorError);
    return [sensor.sensor_id, status === "Receiving data" ? "Online" as const : status];
  })), [resolved.sensors, snapshot]);
  return { ...snapshot, sensors: resolved.sensors, sensorHealthById, refresh: refreshDashboard };
}
