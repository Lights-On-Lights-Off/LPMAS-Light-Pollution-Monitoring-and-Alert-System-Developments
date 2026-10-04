"use client";
import {useEffect, useState} from "react";

export function GmailConnection() {
  const [configured, setConfigured] = useState(false);
  const [sender, setSender] = useState<string | null>(null);
  const [notice, setNotice] = useState("Checking email sending configuration…");
  useEffect(() => {
    let active = true;
    void fetch("/api/admin/gmail/status", {cache: "no-store", signal: AbortSignal.timeout(10_000)})
      .then(async response => {
        const body = await response.json();
        if (!active) return;
        if (!response.ok) {setNotice("Email sending is not configured yet."); return;}
        setConfigured(body.configured === true);
        setSender(body.sender_email ?? null);
        const result = new URLSearchParams(window.location.search).get("gmail");
        setNotice(result === "failed" ? "Gmail authorization failed. Use the Gmail matching your verified administrator account."
          : body.sender_email ? "Gmail authorization saved. Provider acceptance and recipient delivery are tracked separately."
          : body.configured ? "Authorize the Gmail matching your verified administrator account." : "Email sending is not configured yet.");
      }).catch(() => {if (active) setNotice("Email sending status is unavailable.");});
    return () => {active = false;};
  }, []);
  return <div className="mt-4">
    {sender && <p className="text-sm text-theme-text">Authorized sender: {sender}</p>}
    <p role="status" className="mt-2 text-xs text-theme-muted">{notice}</p>
    <form action="/api/admin/gmail/connect" method="post" className="mt-3">
      <button type="submit" disabled={!configured} className="rounded-lg border border-theme-border px-3 py-2 text-sm font-semibold text-theme-text disabled:opacity-50">Authorize my Gmail to send alerts</button>
    </form>
    <p className="mt-2 text-xs text-theme-muted">Opening and recovery emails mirror the SMS. Sending attempts are never retried.</p>
  </div>;
}
