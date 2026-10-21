export type ReadingFreshness = "Receiving data" | "Offline" | "Unknown" | "Data stale";

/** A successful HTTP request is not proof of a new measurement. */
export function currentReadingFreshness(
  measuredAt: string | null, fetchedAt: number | null, now: number,
  offlineThresholdSeconds: number, fetchError: string | null,
): ReadingFreshness {
  const measured = measuredAt ? Date.parse(measuredAt) : NaN;
  if (!Number.isFinite(measured) || measured > now || fetchedAt === null) return "Unknown";
  if (fetchError || now - fetchedAt > 30_000) return "Data stale";
  // Only a completed check can confirm that the source itself stopped reporting.
  // Otherwise the age counter would falsely mark healthy sensors offline between polls.
  return fetchedAt - measured <= offlineThresholdSeconds * 1000 ? "Receiving data" : "Offline";
}
