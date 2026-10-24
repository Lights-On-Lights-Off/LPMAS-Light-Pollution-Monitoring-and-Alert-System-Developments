"use client";
import { useEffect, useState } from "react";

export function GmailConnection({ recipientEmails }: { recipientEmails: string[] }) {
  const [configured, setConfigured] = useState(false);
  const [sender, setSender] = useState<string | null>(null);
  const [status, setStatus] = useState<"checking" | "authorized" | "unauthorized" | "unavailable">("checking");
  const [notice, setNotice] = useState("Checking email sending configuration…");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ message: string; failed: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/admin/gmail/status", { cache: "no-store", signal: AbortSignal.timeout(25_000) })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Email sending status is unavailable.");
        if (!active) return;
        setConfigured(body.configured === true);
        setSender(body.sender_email ?? null);
        setStatus(body.available === false ? "unavailable" : body.authorized && body.sender_email ? "authorized" : "unauthorized");
        const result = new URLSearchParams(window.location.search).get("gmail");
        setNotice(result === "failed" ? "Gmail authorization failed. Use the Gmail matching your verified administrator account."
          : body.detail ? body.detail : body.sender_email ? "Gmail authorization is saved. Send a test to check sending functionality."
          : body.configured ? "Authorize the Gmail matching your verified administrator account." : "Gmail sending is not configured yet.");
      }).catch(error => {
        if (active) { setStatus("unavailable"); setNotice(error instanceof Error ? error.message : "Email sending status is unavailable."); }
      });
    return () => { active = false; };
  }, []);

  async function sendTest() {
    if (busy) return;
    setBusy(true);
    setTestResult(null);
    try {
      const response = await fetch("/api/admin/gmail/test", { method: "POST", signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Test email failed.");
      setTestResult({ message: body.message, failed: body.failed === true });
    } catch (error) {
      setTestResult({ message: error instanceof Error && error.name !== "TimeoutError" ? error.message
        : "Acceptance could not be confirmed. Check the recipient inboxes before sending another test.", failed: true });
    } finally { setBusy(false); }
  }

  const label = { checking: "Checking…", authorized: "Authorized", unauthorized: "Not authorized", unavailable: "Status unavailable" }[status];
  return <div className="mt-4 border-t border-theme-border/70 pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold text-theme-text">Gmail alerts</p>
      <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${status === "authorized" ? "status-success" : "status-warning"}`}>{label}</span>
    </div>
    {sender && <p className="mt-2 break-all text-sm text-theme-text">Authorized sender: {sender}</p>}
    <p role="status" className="mt-2 text-xs text-theme-muted">{notice}</p>
    <p className="mt-2 text-xs text-theme-muted">The connection refreshes automatically. Reconnect if Google expires or revokes access.</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <form action="/api/admin/gmail/connect" method="post">
        <button type="submit" disabled={!configured || busy} className="rounded-lg border border-theme-border px-3 py-2 text-sm font-semibold text-theme-text disabled:opacity-50">{sender ? "Reconnect Gmail" : "Authorize my Gmail to send alerts"}</button>
      </form>
      <button type="button" onClick={() => void sendTest()} disabled={busy || !configured || status !== "authorized" || !recipientEmails.length} className="rounded-lg border border-theme-accent px-3 py-2 text-sm font-semibold text-theme-accent hover:bg-theme-accent-soft disabled:opacity-50">{busy ? "Sending…" : `Send test email${recipientEmails.length === 1 ? "" : "s"}`}</button>
    </div>
    <p className="mt-2 break-all text-xs text-theme-muted">{recipientEmails.length ? `Test recipients: ${recipientEmails.join(", ")}` : "Save at least one verified email recipient to enable the email test."}</p>
    <details className="mt-3 rounded-lg border border-theme-border p-3">
      <summary className="cursor-pointer text-sm font-semibold text-theme-text">Preview violation and resolved emails</summary>
      <p className="mt-2 text-xs text-theme-muted">Each assigned email recipient receives one email per event with incident details and next steps. Violation SMS is sent up to three times, at least 10 seconds apart; resolution SMS is sent once. Names and incident references below are examples.</p>
      <div className="mt-3 space-y-3 text-sm text-theme-text">
        <div><p className="font-semibold">Subject: LPMAS greenhouse violation</p><p className="mt-1">LPMAS ALERT: Greenhouse GH-01 has a confirmed light violation. Incident 12345678-abcd.</p></div>
        <div><p className="font-semibold">Subject: LPMAS greenhouse resolved</p><p className="mt-1">LPMAS RESOLVED: Greenhouse GH-01 has returned to safe light levels. Incident 12345678-abcd.</p></div>
      </div>
    </details>
    {testResult && <p role={testResult.failed ? "alert" : "status"} className={`mt-2 text-sm ${testResult.failed ? "text-theme-danger" : "text-theme-success"}`}>{testResult.message}</p>}
  </div>;
}
