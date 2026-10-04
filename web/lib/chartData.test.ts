import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sensorSeries } from "./chartData.ts";
Deno.test("asynchronous sensor samples keep their own timestamps and gaps", () => {
  const points: Record<string, number>[] = [
    { time: 0, S1: 10 },
    { time: 1, S2: 20 },
    { time: 10_000, S1: 11 },
    { time: 40_000, S1: 12 },
  ];
  assertEquals(sensorSeries(points, "S1", 15_000), [
    { time: 0, S1: 10 },
    { time: 10_000, S1: 11 },
    { time: 25_000, S1: null },
    { time: 40_000, S1: 12 },
  ]);
});
