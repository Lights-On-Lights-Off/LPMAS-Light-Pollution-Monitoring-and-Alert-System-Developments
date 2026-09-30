"use client";

import { useEffect, useState } from "react";

import { Badge, Card } from "@/components/ui";
import { getOnlineSensors, type SensorListEntry } from "@/lib/api";
import { formatLastSeen, formatLux } from "@/lib/sensor-list";

/**
 * The sensors currently reporting for one greenhouse.
 *
 * Distinct from the chart above it: the chart shows what the readings said,
 * this shows which devices are actually alive. A greenhouse with a flat
 * "safe" line and no sensors listed is the case worth catching, so an empty
 * list is stated explicitly rather than rendered as an empty table.
 */
export function AvailableSensors({
  greenhouseId,
  intervalMs = 10_000,
}: {
  greenhouseId: string;
  intervalMs?: number;
}) {
  const [sensors, setSensors] = useState<SensorListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Bumped on every poll so the "x ago" labels stay honest between renders.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!greenhouseId) {
      setSensors([]);
      setLoading(false);
      return;
    }

    let active = true;

    async function poll() {
      try {
        const online = await getOnlineSensors(greenhouseId);
        if (!active) return;
        setSensors(online);
        setNow(Date.now());
      } catch {
        // Keep the last known list rather than blanking the panel: a
        // transient fetch failure says nothing about the hardware, and
        // emptying the table would read as "all sensors died".
        if (active) setNow(Date.now());
      } finally {
        if (active) setLoading(false);
      }
    }

    poll();
    const interval = setInterval(poll, intervalMs);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [greenhouseId, intervalMs]);

  if (!greenhouseId) return null;

  return (
    <Card className="mt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold text-metal-50">Available Sensors</h2>
        <span className="text-xs text-metal-400">
          {loading ? "Checking…" : `${sensors.length} online`}
        </span>
      </div>

      {sensors.length ? (
        <>
          {/* A table on wide screens, stacked cards below sm, matching the
              pattern already used by the activity log. */}
          <table className="mt-4 hidden w-full text-sm sm:table">
            <thead>
              <tr className="border-b border-metal-700 text-left text-xs uppercase tracking-wide text-metal-400">
                <th className="pb-2 font-medium">Sensor</th>
                <th className="pb-2 font-medium">Illuminance</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 text-right font-medium">Last reading</th>
              </tr>
            </thead>
            <tbody>
              {sensors.map(sensor => (
                <tr key={sensor.sensor_id} className="border-b border-metal-800 last:border-0">
                  <td className="py-2 font-mono text-metal-100">{sensor.sensor_id}</td>
                  <td className="py-2 font-mono text-metal-200">{formatLux(sensor.lux)}</td>
                  <td className="py-2">
                    <Badge tone="green">Online</Badge>
                  </td>
                  <td className="py-2 text-right text-metal-400">
                    {formatLastSeen(sensor.last_reading_at, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 space-y-2 sm:hidden">
            {sensors.map(sensor => (
              <div
                key={sensor.sensor_id}
                className="rounded-lg border border-metal-700 bg-metal-800/40 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm text-metal-100">{sensor.sensor_id}</span>
                  <Badge tone="green">Online</Badge>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-metal-400">
                  <span className="font-mono text-metal-200">{formatLux(sensor.lux)}</span>
                  <span>{formatLastSeen(sensor.last_reading_at, now)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="py-6 text-center text-sm text-metal-400">
          {loading ? "Looking for reporting sensors…" : "No sensors are currently reporting."}
        </p>
      )}
    </Card>
  );
}
