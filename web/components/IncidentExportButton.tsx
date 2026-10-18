"use client";
import { useState } from "react";
import { Download } from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { Modal, modalButtonClass } from "./Modal";
import { supabase } from "@/lib/supabase";
import { downloadCsv } from "@/lib/csv";
import { incidentOutcome } from "@/lib/monitoring-state";
import type { Incident } from "@/lib/monitoring-types";
import { logActivity } from "@/lib/activityLog";

function localInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset()*60_000).toISOString().slice(0,16);
}
export function IncidentExportButton({ greenhouseNames }: { greenhouseNames: Record<string,string> }) {
  const [open,setOpen] = useState(false);
  const [start,setStart] = useState("");
  const [end,setEnd] = useState("");
  const [format,setFormat] = useState("csv");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  async function runExport() {
    setBusy(true); setError(null);
    try {
      if (!supabase) throw new Error("Cloud monitoring is not configured.");
      const from = new Date(start), to = new Date(end);
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) throw new Error("Choose a valid From and To range.");
      const incidents: Incident[] = [];
      for (let offset=0; ; offset+=1000) {
        const result = await supabase.from("monitoring_incidents")
          .select("id,sensor_id,greenhouse_id,phase_type,opened_at,resolved_at,status,reason,resolution_reason")
          .gte("opened_at",from.toISOString()).lte("opened_at",to.toISOString())
          .order("opened_at",{ascending:false}).order("id",{ascending:false})
          .range(offset,offset+999).abortSignal(AbortSignal.timeout(10_000));
        if(result.error) throw new Error(result.error.message);
        incidents.push(...(result.data ?? []) as Incident[]);
        if((result.data?.length ?? 0)<1000) break;
      }
      if (!incidents.length) throw new Error("No incidents opened in this date range.");
      const rows = incidents.map(i => ({
        Opened: new Date(i.opened_at).toLocaleString(),
        Sensor: i.sensor_id,
        Greenhouse: i.greenhouse_id ? greenhouseNames[i.greenhouse_id] ?? i.greenhouse_id : "Unassigned",
        Phase: i.phase_type, Status: incidentOutcome(i).label,
        Resolved: i.resolved_at ? new Date(i.resolved_at).toLocaleString() : "",
        Reason: i.reason ?? "", Outcome: incidentOutcome(i).detail ?? "",
      }));
      if (format === "csv") downloadCsv("incident-report.csv",rows);
      else {
        const doc = new jsPDF({orientation:"landscape"});
        doc.setFontSize(16); doc.text("Incident Report",14,18);
        doc.setFontSize(10); doc.text(`${from.toLocaleString()} – ${to.toLocaleString()}`,14,26);
        autoTable(doc,{startY:32,head:[Object.keys(rows[0])],body:rows.map(Object.values),styles:{fontSize:8},margin:{left:14,right:14}});
        doc.save("incident-report.pdf");
      }
      await logActivity("EXPORT_INCIDENT_REPORT","monitoring_incidents",undefined,{start:from.toISOString(),end:to.toISOString(),format,incidents:incidents.length});
      setOpen(false);
    } catch(e) { setError(e instanceof Error ? e.message : "Export failed."); }
    finally { setBusy(false); }
  }
  const control = "mt-1 w-full rounded-lg border border-theme-border bg-theme-surface p-2 text-theme-text";
  return <>
    <button className="flex items-center gap-2 rounded-xl border border-theme-border px-3 py-2 text-sm font-semibold" onClick={() => {
      setStart(localInput(new Date(Date.now()-86400000)));setEnd(localInput(new Date()));setError(null);setFormat("csv");setOpen(true);
    }}><Download size={16}/>Download</button>
    <Modal open={open} onClose={() => {if(!busy)setOpen(false);}} title="Export incident report" description="Download incidents opened within the selected date range." footer={<>
      <button disabled={busy} className={modalButtonClass.secondary} onClick={() => setOpen(false)}>Cancel</button>
      <button disabled={busy || !start || !end} className={modalButtonClass.primary} onClick={() => void runExport()}>{busy ? "Exporting…" : "Download"}</button>
    </>}>
      <label className="block text-sm">From<input className={control} type="datetime-local" value={start} onChange={e => setStart(e.target.value)}/></label>
      <label className="block text-sm">To<input className={control} type="datetime-local" value={end} onChange={e => setEnd(e.target.value)}/></label>
      <label className="block text-sm">Format<select className={control} value={format} onChange={e => setFormat(e.target.value)}><option value="csv">CSV</option><option value="pdf">PDF</option></select></label>
      {error && <p role="alert" className="text-sm text-theme-danger">{error}</p>}
    </Modal>
  </>;
}
