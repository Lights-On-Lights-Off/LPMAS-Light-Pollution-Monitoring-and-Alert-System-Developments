"use client";
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Badge } from "./ui";
import { Modal } from "./Modal";

export type ActivityLogRow = {
  id: number;
  username: string | null;
  role?: string;
  action: string;
  resource?: string | null;
  resource_id?: string | null;
  details: Record<string, unknown> | null;
  page?: string | null;
  ip_address?: string | null;
  browser?: string | null;
  created_at: string;
};

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function actionTone(action: string): "green" | "amber" | "red" | "slate" {
  if (action === "SIGN_IN") return "green";
  if (action === "SIGN_OUT" || action.startsWith("FAILED_")) return "slate";
  if (action.startsWith("DELETE_") || action === "EMPTY_RECYCLE_BIN") return "red";
  if (action.startsWith("EXPORT_")) return "amber";
  return "green";
}

function roleTone(role: string): "red" | "amber" | "slate" {
  if (role === "admin") return "red";
  if (role === "manager") return "amber";
  return "slate";
}

// Sortable column keys. "actor" sorts by username, everything else by its
// own field on the row.
type SortKey = "created_at" | "username" | "action" | "page";

export function ActivityLogTable({
  logs,
  loading,
  error,
  showRoleColumn = false,
  onDownloadCsv,
  downloadDisabled = false
}: {
  logs: ActivityLogRow[];
  loading: boolean;
  error?: string | null;
  showRoleColumn?: boolean;
  onDownloadCsv: (logs: ActivityLogRow[]) => void;
  downloadDisabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [viewingLog, setViewingLog] = useState<ActivityLogRow | null>(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = !term ? logs : logs.filter(log =>
      (log.username ?? "").toLowerCase().includes(term) ||
      log.action.toLowerCase().includes(term) ||
      (log.page ?? "").toLowerCase().includes(term) ||
      (log.role ?? "").toLowerCase().includes(term) ||
      (log.browser ?? "").toLowerCase().includes(term) ||
      (log.ip_address ?? "").toLowerCase().includes(term) ||
      (log.resource ?? "").toLowerCase().includes(term) ||
      (log.resource_id ?? "").toLowerCase().includes(term) ||
      (log.details ? JSON.stringify(log.details) : "").toLowerCase().includes(term)
    );

    const sorted = [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "created_at") cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      else if (sortKey === "username") cmp = (a.username ?? "").localeCompare(b.username ?? "");
      else if (sortKey === "action") cmp = a.action.localeCompare(b.action);
      else cmp = (a.page ?? "").localeCompare(b.page ?? "");
      return sortDir === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [logs, search, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);
  const rangeStart = filtered.length ? (clampedPage - 1) * pageSize + 1 : 0;
  const rangeEnd = Math.min(clampedPage * pageSize, filtered.length);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(dir => (dir === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPage(1);
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return "↕";
    return sortDir === "asc" ? "↑" : "↓";
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
            Show
            <select
              value={pageSize}
              onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
              className="rounded-lg border border-[color-mix(in_srgb,var(--accent)_28%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface))] px-2 py-1.5 text-xs font-medium text-[var(--foreground)] outline-none"
            >
              {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            entries
          </label>
          <button
            onClick={() => onDownloadCsv(filtered)}
            disabled={downloadDisabled || loading || !filtered.length}
            className="flex items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            <Download size={14} />
            Export CSV
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          Search logs:
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Actor, action, page, browser..."
            className="w-44 rounded-lg border border-[color-mix(in_srgb,var(--accent)_28%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_6%,var(--surface))] px-2.5 py-1.5 text-xs text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
          />
        </label>
      </div>

      {error && logs.length > 0 && <p role="alert" className="mb-3 text-sm text-red-400">Unable to refresh activity logs. Showing previously loaded entries. {error}</p>}

      {loading ? (
        <div className="grid min-h-56 place-items-center text-sm text-[var(--muted-foreground)]">Loading activity logs...</div>
      ) : error && !logs.length ? (
        <div className="grid min-h-56 place-items-center text-center text-sm text-red-400">Unable to load activity logs.<br />{error}</div>
      ) : !filtered.length ? (
        <div className="grid min-h-56 place-items-center text-sm text-[var(--muted-foreground)]">{logs.length ? "No logs match your search." : "No activity logs available."}</div>
      ) : (
        <>
          <div className="hidden w-full overflow-x-auto rounded-2xl border border-white/[0.07] bg-black/[0.08] md:block">
            <table className="w-full min-w-[1050px] text-sm leading-5">
              <thead className="border-b border-metal-700 bg-[var(--surface)]">
                <tr>
                  <th className="cursor-pointer select-none px-3 py-3 text-left align-middle text-xs font-semibold tracking-wide text-metal-300" onClick={() => toggleSort("created_at")}>Time {sortIndicator("created_at")}</th>
                  <th className="cursor-pointer select-none px-3 py-3 text-left align-middle text-xs font-semibold tracking-wide text-metal-300" onClick={() => toggleSort("username")}>Actor {sortIndicator("username")}</th>
                  {showRoleColumn && <th className="px-3 py-3 text-left align-middle text-xs font-semibold tracking-wide text-metal-300">Role</th>}
                  <th className="cursor-pointer select-none px-3 py-3 text-left align-middle text-xs font-semibold tracking-wide text-metal-300" onClick={() => toggleSort("action")}>Action {sortIndicator("action")}</th>
                  <th className="px-3 py-3 text-left align-middle text-xs font-semibold tracking-wide text-metal-300">Detail</th>
                  <th className="cursor-pointer select-none px-3 py-3 text-left align-middle text-xs font-semibold tracking-wide text-metal-300" onClick={() => toggleSort("page")}>Page {sortIndicator("page")}</th>
                  <th className="px-3 py-3 text-left align-middle text-xs font-semibold tracking-wide text-metal-300">IP Address</th>
                  <th className="px-3 py-3 text-left align-middle text-xs font-semibold tracking-wide text-metal-300">Browser</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(log => (
                  <tr key={log.id} className="border-b border-metal-700 last:border-0">
                    <td className="px-3 py-3 align-middle text-xs text-metal-400">{new Date(log.created_at).toLocaleString()}</td>
                    <td className="px-3 py-3 align-middle text-sm font-medium text-metal-200">{log.username ?? "Unknown"}</td>
                    {showRoleColumn && <td className="px-3 py-3 align-middle"><Badge tone={roleTone(log.role ?? "")}>{log.role ?? "—"}</Badge></td>}
                    <td className="px-3 py-3 align-middle"><Badge tone={actionTone(log.action)}>{log.action}</Badge></td>
                    <td className="px-3 py-3 align-middle">
                      <button onClick={() => setViewingLog(log)} className="rounded-lg border border-[color-mix(in_srgb,var(--accent)_28%,var(--border))] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]">
                        View
                      </button>
                    </td>
                    <td className="max-w-[240px] break-all px-3 py-3 align-middle font-mono text-xs text-metal-400" title={log.page ?? undefined}>{log.page?.trim() || "Not recorded"}</td>
                    <td className="px-3 py-3 align-middle font-mono text-xs text-metal-400">{log.ip_address ?? "—"}</td>
                    <td className="px-3 py-3 align-middle text-xs text-metal-400 whitespace-nowrap">{log.browser?.trim() || "Not recorded"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="max-h-[480px] space-y-3 overflow-y-auto md:hidden">
            {pageRows.map(log => (
              <div key={log.id} className="rounded-xl border border-white/[0.07] bg-black/[0.08] p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-semibold text-[var(--foreground)]">{log.username ?? "Unknown"}</p>
                  <Badge tone={actionTone(log.action)}>{log.action}</Badge>
                </div>
                <div className="mt-3 space-y-1.5 text-xs">
                  {showRoleColumn && (
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-[var(--muted-foreground)]">Role</span>
                      <Badge tone={roleTone(log.role ?? "")}>{log.role ?? "—"}</Badge>
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="shrink-0 text-[var(--muted-foreground)]">Time</span>
                    <span className="min-w-0 break-words text-right text-[var(--foreground)]">{new Date(log.created_at).toLocaleString()}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="shrink-0 text-[var(--muted-foreground)]">Page</span>
                    <span className="min-w-0 break-all text-right font-mono text-[var(--foreground)]">{log.page?.trim() || "Not recorded"}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="shrink-0 text-[var(--muted-foreground)]">IP / Browser</span>
                    <span className="min-w-0 break-words text-right text-[var(--foreground)]">{log.ip_address ?? "—"} · {log.browser?.trim() || "Not recorded"}</span>
                  </div>
                </div>
                <button onClick={() => setViewingLog(log)} className="mt-3 w-full rounded-lg border border-[color-mix(in_srgb,var(--accent)_28%,var(--border))] py-1.5 text-xs font-medium text-[var(--foreground)]">
                  View details
                </button>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--muted-foreground)]">
            <span>Showing {rangeStart} to {rangeEnd} of {filtered.length} total entries</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={clampedPage <= 1} className="rounded-lg border border-[color-mix(in_srgb,var(--accent)_28%,var(--border))] px-2.5 py-1 font-medium text-[var(--foreground)] disabled:opacity-40">Prev</button>
              <span>{clampedPage} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={clampedPage >= totalPages} className="rounded-lg border border-[color-mix(in_srgb,var(--accent)_28%,var(--border))] px-2.5 py-1 font-medium text-[var(--foreground)] disabled:opacity-40">Next</button>
            </div>
          </div>
        </>
      )}

      <Modal
        open={!!viewingLog}
        onClose={() => setViewingLog(null)}
        title="Activity Detail"
        description={viewingLog ? `${viewingLog.action} · ${new Date(viewingLog.created_at).toLocaleString()}` : undefined}
        footer={<button onClick={() => setViewingLog(null)} className="rounded-xl bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] px-4 py-2 text-sm font-semibold">Close</button>}
      >
        {viewingLog && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Actor" value={viewingLog.username ?? "Unknown"} />
            {viewingLog.role && <DetailRow label="Role" value={viewingLog.role} />}
            <DetailRow label="Resource" value={viewingLog.resource ? `${viewingLog.resource}${viewingLog.resource_id ? ` (${viewingLog.resource_id})` : ""}` : "—"} />
            <DetailRow label="Page" value={viewingLog.page?.trim() || "Not recorded"} mono />
            <DetailRow label="IP Address" value={viewingLog.ip_address ?? "—"} mono />
            <DetailRow label="Browser" value={viewingLog.browser?.trim() || "Not recorded"} />
            <div>
              <p className="mb-1.5 text-xs font-semibold text-[var(--muted-foreground)]">Details</p>
              <pre className="max-h-56 overflow-auto rounded-lg bg-black/20 p-3 text-xs text-[var(--foreground)]">
                {viewingLog.details ? JSON.stringify(viewingLog.details, null, 2) : "—"}
              </pre>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-xs font-semibold text-[var(--muted-foreground)]">{label}</span>
      <span className={`min-w-0 break-words text-right ${mono ? "font-mono text-xs" : "text-sm"} text-[var(--foreground)]`}>{value}</span>
    </div>
  );
}
