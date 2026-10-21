"use client";

import { ChevronDown } from "lucide-react";
import { Fragment, useState } from "react";

/** A keyboard-accessible alternative to chart hover and touch tooltips. */
export function ChartDataDetails({ points, series }: {
  points: Record<string, number | null>[];
  series: string[];
}) {
  const [open, setOpen] = useState(false);
  if (!points.length) return null;
  return <details onToggle={event => setOpen(event.currentTarget.open)} className="group mt-4 border-t border-theme-border pt-3 text-sm">
    <summary className="flex min-h-11 list-none items-center justify-between gap-3 font-medium text-theme-secondary-text">View chart data · {points.length} timestamps<ChevronDown aria-hidden="true" size={16} className="shrink-0 transition-transform group-open:rotate-180" /></summary>
    {open && <div className="mt-2 max-h-64 overflow-auto rounded-xl border border-theme-border" role="region" aria-label="Chart readings" tabIndex={0}>
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Lux readings shown in the trend chart</caption>
        <thead className="sticky top-0 bg-[var(--background)] text-theme-text"><tr>
          <th scope="col" className="p-3">Recorded</th><th scope="col" className="p-3">Sensor</th><th scope="col" className="p-3 text-right">Lux</th>
        </tr></thead>
        <tbody>{points.map(point => <Fragment key={point.time}>{series.filter(id => typeof point[id] === "number").map(id => <tr key={id} className="border-t border-theme-border">
          <td className="p-3 text-theme-muted">{new Date(point.time as number).toLocaleString()}</td>
          <th scope="row" className="break-all p-3 font-medium text-theme-text">{id}</th>
          <td className="p-3 text-right font-mono tabular-nums text-theme-text">{point[id]?.toFixed(2)}</td>
        </tr>)}</Fragment>)}</tbody>
      </table>
    </div>}
  </details>;
}
