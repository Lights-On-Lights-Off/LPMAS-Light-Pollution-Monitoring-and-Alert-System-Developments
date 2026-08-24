import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`metal-panel rounded-2xl border border-metal-700 p-5 text-metal-100 ${className}`}>{children}</section>;
}

export function Badge({ children, tone = "green" }: { children: ReactNode; tone?: "green" | "amber" | "red" | "slate" }) {
  const colors = {
    green: "bg-leaf-500/15 text-leaf-500 ring-leaf-500/30",
    amber: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
    red: "bg-red-500/15 text-red-300 ring-red-500/30",
    slate: "bg-white/10 text-metal-300 ring-white/15"
  };
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${colors[tone]}`}>{children}</span>;
}
