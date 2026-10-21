import type { DashboardSummary, Greenhouse, Incident, MinuteAggregate, Phase } from "./monitoring-types.ts";
import type { SensorListEntry } from "./sensor-list.ts";
import { freshestReadings, phaseForGreenhouse } from "./monitoring-state.ts";

export const CURRENT_REFRESH_MS = 10_000;
export const CONFIG_REFRESH_MS = 30_000;
export type MonitoringPolicy = { dark_phase_days: number; offline_threshold_seconds: number };
export type DashboardState = {
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
  policy: MonitoringPolicy;
  lastFetchedAt: number | null;
  aggregateError: string | null;
  incidentError: string | null;
  now: number;
};
export const INITIAL_DASHBOARD_STATE: DashboardState = {
  data: { phase: null, readings: [], incidents: [], generatedAt: new Date(0).toISOString() },
  loading: true, error: null, sensors: [], sensorsFetchedAt: null, sensorError: null,
  greenhouses: [], configError: null, configurationFetchedAt: null, sources: {},
  policy: { dark_phase_days: 60, offline_threshold_seconds: 15 },
  lastFetchedAt: null, aggregateError: null, incidentError: null, now: 0,
};
type Dependencies = {
  sensors(): Promise<SensorListEntry[]>;
  aggregates(): Promise<MinuteAggregate[]>;
  incidents(): Promise<Incident[]>;
  configuration(): Promise<{ greenhouses: Greenhouse[]; policy: MonitoringPolicy }>;
  now?: () => number;
  every?: (callback: () => void, milliseconds: number) => () => void;
};
function configuredPhase(greenhouses: Greenhouse[], days: number, now: number): Phase | null {
  for (const greenhouse of greenhouses) {
    if (!greenhouse.is_active) continue;
    const phase = phaseForGreenhouse(greenhouse, days, new Date(now));
    if (!phase) continue;
    const afterEnd = (offset: number) => new Date(Date.parse(`${greenhouse.phase_end}T00:00:00Z`) + offset * 86400_000).toISOString().slice(0, 10);
    return {
      id: null, greenhouse_id: greenhouse.id, phase_type: phase, is_active: 1,
      starts_on: phase === "dark" ? afterEnd(1) : greenhouse.phase_start,
      ends_on: phase === "dark" ? afterEnd(days) : greenhouse.phase_end,
      window_start: phase === "dark" ? null : greenhouse.window_start,
      window_end: phase === "dark" ? null : greenhouse.window_end,
    };
  }
  return null;
}

/** Each source publishes independently. A stalled history request cannot delay current values. */
export function createDashboardStore(deps: Dependencies) {
  let state = INITIAL_DASHBOARD_STATE;
  const listeners = new Set<() => void>();
  const flights = new Map<string, Promise<void>>();
  const timers: (() => void)[] = [];
  const now = deps.now ?? Date.now;
  const every = deps.every ?? ((callback: () => void, milliseconds: number) => {
    const timer = setInterval(callback, milliseconds);
    return () => clearInterval(timer);
  });
  function publish(update: Partial<DashboardState>) {
    state = { ...state, ...update, now: now() };
    state.error = state.sensorError && state.aggregateError
      ? "Current readings and history are unavailable. Showing retained data." : null;
    state.data = { ...state.data, phase: configuredPhase(state.greenhouses, state.policy.dark_phase_days, state.now) };
    listeners.forEach(listener => listener());
  }
  function run(name: string, load: () => Promise<void>, failed: (message: string) => void) {
    const current = flights.get(name);
    if (current) return current;
    const task = Promise.resolve().then(load).catch(error => {
      failed(error instanceof Error ? error.message : "Monitoring data unavailable");
    }).finally(() => { flights.delete(name); });
    flights.set(name, task);
    return task;
  }
  function refreshCurrent() {
    return run("sensors", async () => {
      const sensors = await deps.sensors();
      publish({ sensors, sensorsFetchedAt: now(), sensorError: null, loading: false });
    }, sensorError => publish({ sensorError, loading: false }));
  }
  function refreshAggregates() {
    return run("aggregates", async () => {
      const aggregates = await deps.aggregates();
      const { readings, sources } = freshestReadings([], aggregates);
      publish({ data: { ...state.data, readings, generatedAt: new Date(now()).toISOString() }, sources, aggregateError: null, lastFetchedAt: now() });
    }, aggregateError => publish({ aggregateError }));
  }
  function refreshIncidents() {
    return run("incidents", async () => {
      const incidents = await deps.incidents();
      publish({ data: { ...state.data, incidents }, incidentError: null });
    }, incidentError => publish({ incidentError }));
  }
  function refreshConfiguration() {
    return run("configuration", async () => {
      const { greenhouses, policy } = await deps.configuration();
      publish({ greenhouses, policy, configurationFetchedAt: now(), configError: null });
    }, configError => publish({ configError }));
  }
  async function refresh() {
    await Promise.all([refreshCurrent(), refreshAggregates(), refreshIncidents(), refreshConfiguration()]);
  }
  return {
    getSnapshot: () => state,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        timers.push(every(() => { void refreshCurrent(); void refreshAggregates(); void refreshIncidents(); }, CURRENT_REFRESH_MS));
        timers.push(every(() => { void refreshConfiguration(); }, CONFIG_REFRESH_MS));
        // Update measurement ages even when lux stays constant or a request stalls.
        timers.push(every(() => publish({}), 1000));
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) timers.splice(0).forEach(cancel => cancel());
      };
    },
  };
}
