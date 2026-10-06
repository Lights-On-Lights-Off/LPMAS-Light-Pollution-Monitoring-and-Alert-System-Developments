"use client";
import { useMemo, useSyncExternalStore } from "react";
import {
  type DashboardSummary,
  getDashboardSummary,
  getGreenhouses,
  getSensorList,
  type Greenhouse,
  type Incident,
  type MinuteAggregate,
} from "./api";
import type { SensorListEntry } from "./sensor-list";
import { supabase } from "./supabase";
import { freshestReadings, resolveSensorMonitoring } from "./monitoring-state";
const EMPTY_DATA: DashboardSummary = {
  phase: null,
  readings: [],
  incidents: [],
  generatedAt: new Date(0).toISOString(),
};
type State = {
  data: DashboardSummary;
  loading: boolean;
  error: string | null;
  sensors: SensorListEntry[];
  sensorsFetchedAt: number | null;
  sensorError: string | null;
  greenhouses: Greenhouse[];
  configError: string | null;
  configurationFetchedAt: number | null;
  sources: Record<string, "raw" | "minute">;
  policy: { dark_phase_days: number; offline_threshold_seconds: number };
  lastFetchedAt: number | null;
  piError: string | null;
  cloudError: string | null;
};
const INITIAL: State = {
  data: EMPTY_DATA,
  loading: true,
  error: null,
  sensors: [],
  sensorsFetchedAt: null,
  sensorError: null,
  greenhouses: [],
  configError: null,
  configurationFetchedAt: null,
  sources: {},
  policy: { dark_phase_days: 60, offline_threshold_seconds: 15 },
  lastFetchedAt: null,
  piError: null,
  cloudError: null,
};
let state = INITIAL,
  piData = EMPTY_DATA,
  cloudIncidents: Incident[] = [],
  cloudAggregates: MinuteAggregate[] = [];
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let lastCloud = 0, lastConfig = 0;
function publish(update: Partial<State>) {
  state = { ...state, ...update };
  for (const listener of listeners) listener();
}
async function cloudRefresh() {
  if (!supabase) throw new Error("Cloud monitoring is not configured");
  const [, aggregates, incidents] = await Promise.all([
    getSensorList().then(sensors => {
      publish({ sensors, sensorsFetchedAt: Date.now(), sensorError: null });
    }).catch(error => {
      publish({ sensorError: error instanceof Error ? error.message : "Sensor registry unavailable" });
    }),
    supabase.from("sensor_minute_aggregates").select("*").order(
      "bucket_start",
      { ascending: false },
    ).limit(300).abortSignal(AbortSignal.timeout(10_000)),
    supabase.from("monitoring_incidents").select("*").order("opened_at", {
      ascending: false,
    }).limit(100).abortSignal(AbortSignal.timeout(10_000)),
  ]);
  if (aggregates.error) throw new Error(aggregates.error.message);
  if (incidents.error) throw new Error(incidents.error.message);
  cloudAggregates = (aggregates.data ?? []) as MinuteAggregate[];
  cloudIncidents = (incidents.data ?? []).map((row) => ({
    ...row,
    id: row.pi_incident_id,
  })) as Incident[];
  publish({
    cloudError: null,
  });
}
export function refreshDashboard(force = true): Promise<void> {
  if (inFlight) {
    return force ? inFlight.then(() => refreshDashboard(true)) : inFlight;
  }
  inFlight = (async () => {
    const work: Promise<unknown>[] = [
      getDashboardSummary().then((value) => {
        piData = value;
        publish({ piError: null, lastFetchedAt: Date.now() });
      }).catch((error) =>
        publish({
          piError: error instanceof Error ? error.message : "Pi unavailable",
        })
      ),
    ];
    if (force || Date.now() - lastCloud >= 10_000) {
      lastCloud = Date.now();
      work.push(
        cloudRefresh().catch((error) => {
          const message = error instanceof Error
            ? error.message
            : "Cloud unavailable";
          publish({ cloudError: message });
        }),
      );
    }
    if (force || Date.now() - lastConfig >= 30_000) {
      lastConfig = Date.now();
      work.push(
        Promise.all([
          getGreenhouses(),
          supabase?.rpc("monitoring_policy").abortSignal(
            AbortSignal.timeout(10_000),
          ),
        ]).then(([greenhouses, policy]) => {
          if (policy?.error) throw new Error(policy.error.message);
          publish({
            greenhouses,
            configurationFetchedAt: Date.now(),
            policy: policy?.data ?? state.policy,
            configError: null,
          });
        }).catch((error) =>
          publish({
            configError: error instanceof Error
              ? error.message
              : "Configuration unavailable",
          })
        ),
      );
    }
    await Promise.all(work);
    const { readings, sources } = freshestReadings(
      piData.readings,
      cloudAggregates,
    );
    const incidentMap = new Map<string, Incident>();
    for (const i of [...cloudIncidents, ...piData.incidents]) {
      const key = i.incident_uid ?? `legacy-${i.id}`;
      const current = incidentMap.get(key);
      if (
        !current ||
        (i.version ?? i.incident_version ?? 0) >=
          (current.version ?? current.incident_version ?? 0)
      ) incidentMap.set(key, i);
    }
    publish({
      data: { ...piData, readings, incidents: [...incidentMap.values()] },
      sources,
      loading: false,
      error: state.piError && state.cloudError
        ? "Pi and cloud are unavailable. Showing retained data."
        : null,
    });
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    void refreshDashboard();
    timer = setInterval(() => void refreshDashboard(false), 5_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
export function useDashboardData() {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => INITIAL);
  // Local component state updates must not create new effect dependencies.
  // Store publications (including the polling tick) refresh time-based health.
  const resolved = useMemo(() => resolveSensorMonitoring(snapshot.sensors, snapshot.data.readings, snapshot.greenhouses, {
    now: Date.now(), offlineThresholdSeconds: snapshot.policy.offline_threshold_seconds,
    registryFetchedAt: snapshot.sensorsFetchedAt, piFetchedAt: snapshot.lastFetchedAt,
    registryError: snapshot.sensorError, piError: snapshot.piError,
    configurationKnown: snapshot.configurationFetchedAt !== null,
  }), [snapshot]);
  return {
    ...snapshot,
    sensors: resolved.sensors,
    sensorHealthById: resolved.health,
    refresh: refreshDashboard,
  };
}
