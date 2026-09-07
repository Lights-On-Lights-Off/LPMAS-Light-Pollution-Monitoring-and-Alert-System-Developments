import type { ReactNode } from "react";

type BadgeTone = "green" | "amber" | "red" | "slate";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`glass-card rounded-2xl p-5 text-primary md:p-6 ${className}`}>{children}</section>;
}

export function Badge({ children, tone = "green" }: { children: ReactNode; tone?: BadgeTone }) {
  const colors = {
    green: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/25",
    amber: "bg-amber-500/12 text-amber-700 ring-amber-500/25",
    red: "bg-red-500/12 text-red-700 ring-red-500/25",
    slate: "bg-slate-500/10 text-slate-600 ring-slate-500/20"
  };

  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${colors[tone]}`}>{children}</span>;
}