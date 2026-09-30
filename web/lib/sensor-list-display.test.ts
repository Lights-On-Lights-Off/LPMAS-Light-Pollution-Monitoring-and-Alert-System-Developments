/**
 * Tests for the Available Sensors display helpers.
 *
 * The last-seen label is what tells an operator whether a sensor is merely
 * quiet or actually dead, so the boundary cases (exactly 60s, 60m, 24h) and
 * a null or unparseable timestamp are the ones worth pinning down.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import { formatLastSeen, formatLux } from "./sensor-list.ts";

const NOW = Date.parse("2026-09-29T10:30:00.000Z");

function ago(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

Deno.test("a recent reading is reported in seconds", () => {
  assertEquals(formatLastSeen(ago(0), NOW), "0s ago");
  assertEquals(formatLastSeen(ago(9), NOW), "9s ago");
  assertEquals(formatLastSeen(ago(59), NOW), "59s ago");
});

Deno.test("seconds roll over to minutes at exactly 60", () => {
  assertEquals(formatLastSeen(ago(60), NOW), "1m ago");
  assertEquals(formatLastSeen(ago(119), NOW), "1m ago");
  assertEquals(formatLastSeen(ago(3599), NOW), "59m ago");
});

Deno.test("minutes roll over to hours at exactly 60", () => {
  assertEquals(formatLastSeen(ago(3600), NOW), "1h ago");
  assertEquals(formatLastSeen(ago(86399), NOW), "23h ago");
});

Deno.test("hours roll over to days at exactly 24", () => {
  assertEquals(formatLastSeen(ago(86400), NOW), "1d ago");
  assertEquals(formatLastSeen(ago(86400 * 5), NOW), "5d ago");
});

Deno.test("a sensor that never reported says never, not 0s ago", () => {
  assertEquals(formatLastSeen(null, NOW), "never");
});

Deno.test("an unparseable timestamp says never rather than NaN", () => {
  assertEquals(formatLastSeen("not-a-date", NOW), "never");
  assertEquals(formatLastSeen("", NOW), "never");
});

Deno.test("a clock skewed into the future does not render a negative age", () => {
  // The Pi's clock can lead the cloud's by a second or two; showing "-3s ago"
  // would be a visible glitch in an otherwise quiet panel.
  const future = new Date(NOW + 3000).toISOString();
  assertEquals(formatLastSeen(future, NOW), "0s ago");
});

Deno.test("formatLux renders one decimal place", () => {
  assertEquals(formatLux(12), "12.0 lux");
  assertEquals(formatLux(45.234), "45.2 lux");
  assertEquals(formatLux(0), "0.0 lux");
});

Deno.test("formatLux falls back to a dash for an unusable value", () => {
  assertEquals(formatLux(NaN), "—");
  assertEquals(formatLux(Infinity), "—");
});
