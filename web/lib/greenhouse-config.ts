import type { Greenhouse } from "./monitoring-types";
export type GreenhouseConfig = {
  id: string;
  name: string;
  sensorIds: string[];
  phaseStart: string;
  phaseEnd: string;
  windowStart: string;
  windowEnd: string;
};

export function toLocalConfig(g: Greenhouse): GreenhouseConfig {
  return {
    id: g.id,
    name: g.name,
    sensorIds: g.sensor_ids ?? [],
    phaseStart: g.phase_start,
    phaseEnd: g.phase_end,
    windowStart: g.window_start,
    windowEnd: g.window_end,
  };
}
