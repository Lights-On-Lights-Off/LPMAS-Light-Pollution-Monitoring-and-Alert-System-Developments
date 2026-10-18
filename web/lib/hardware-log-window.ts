export type HardwareLogRange = "30m" | "1h" | "3h" | "today" | "all";

export function hardwareLogWindow(range: HardwareLogRange, now = new Date()) {
  const start = new Date(now);
  if (range === "all") start.setTime(0);
  else if (range === "today") start.setHours(0, 0, 0, 0);
  else {
    const minutes = { "30m": 30, "1h": 60, "3h": 180 }[range];
    start.setTime(now.getTime() - minutes * 60_000);
  }
  return { start: start.toISOString(), end: now.toISOString() };
}
