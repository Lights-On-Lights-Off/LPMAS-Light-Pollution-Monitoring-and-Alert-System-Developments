import type { ReactNode } from "react";

export type BadgeTone = "green" | "amber" | "red" | "slate";

export function healthTone(health: string): BadgeTone {
  return health === "Online" ? "green" : health === "Offline" ? "red" : "amber";
}

export function incidentTone(incident: { status: string; resolution_reason?: string | null }): BadgeTone {
  if (incident.status === "open") return "red";
  return incident.status === "resolved" && incident.resolution_reason === "safe_reading" ? "green" : "amber";
}

export function deliveryTone(status: string): BadgeTone {
  if (["failed", "rejected", "error", "revoked"].includes(status)) return "red";
  return ["accepted", "sent", "delivered", "success"].includes(status) ? "green" : "amber";
}

export function Card({ children, className = "", compact = false }: { children: ReactNode; className?: string; compact?: boolean }) {
  return <section className={`glass-card min-w-0 rounded-2xl text-primary ${compact ? "kpi-card p-3 sm:p-4" : "p-4 sm:p-5"} ${className}`}>{children}</section>;
}

export function Badge({ children, tone = "green" }: { children: ReactNode; tone?: BadgeTone }) {
  const colors = {
    green: "status-success",
    amber: "status-warning",
    red: "status-danger",
    slate: "bg-slate-500/10 text-theme-muted ring-slate-500/20"
  };

  return <span className={`inline-flex max-w-full items-center break-words rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${colors[tone]}`}>{children}</span>;
}
export function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-6 text-center text-sm text-[var(--muted-foreground)]">{text}</td>
    </tr>
  );
}
