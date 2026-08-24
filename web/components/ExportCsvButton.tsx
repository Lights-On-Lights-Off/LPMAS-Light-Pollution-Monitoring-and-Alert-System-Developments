"use client";
import { Download } from "lucide-react";
import { downloadCsv } from "@/lib/csv";

export function ExportCsvButton({ filename, rows }: { filename: string; rows: Record<string, string | number>[] }) {
  return <button
    onClick={() => downloadCsv(filename, rows)}
    disabled={rows.length === 0}
    className="flex items-center gap-1.5 rounded-lg border border-metal-600 bg-metal-800 px-3 py-1.5 text-xs font-semibold text-metal-200 hover:border-leaf-500/40 hover:text-leaf-500 disabled:opacity-40 disabled:hover:border-metal-600 disabled:hover:text-metal-200"
  >
    <Download size={14} /> Export CSV
  </button>;
}
