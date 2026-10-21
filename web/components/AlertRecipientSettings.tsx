"use client";
import { useEffect, useState } from "react";
import { Phone, Plus, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import { GmailConnection } from "./GmailConnection";
import type { AdminUser } from "@/lib/adminUsers";
import { MAX_ALERT_RECIPIENTS, parseAlertRecipients, type AlertRecipient } from "@/lib/alert-recipients";
import { sanitizeLocalDigits, toLocalDigits, toInternationalNumber } from "@/lib/admin-notification-settings";
import { logActivity } from "@/lib/activityLog";

export function AlertRecipientSettings({ users, usersLoading, usersError }: { users: AdminUser[]; usersLoading: boolean; usersError: string | null }) {
  const [saved, setSaved] = useState<AlertRecipient[]>([]);
  const [draft, setDraft] = useState<AlertRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const eligible = users.filter(user => user.email_verified && (user.role === "manager" || user.role === "admin"));
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/settings", { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load recipient assignments.");
      setSaved(parseAlertRecipients(body.alert_recipients ?? []));
      setLoadError(null);
    }).catch(e => { if (!controller.signal.aborted) setLoadError(e instanceof Error ? e.message : "Recipients unavailable."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  function update(index: number, values: Partial<AlertRecipient>) {
    setDraft(rows => rows.map((row, i) => i === index ? { ...row, ...values } : row));
  }
  async function save() {
    if (saving) return;
    let rows: AlertRecipient[];
    try {
      rows = parseAlertRecipients(draft);
      if (rows.some(row => !eligible.some(user => user.id === row.user_id))) throw new Error("Remove unavailable accounts or select verified users.");
    } catch (e) { setError(e instanceof Error ? e.message : "Review recipient assignments."); return; }
    setSaving(true); setError(null);
    try {
      const response = await fetch("/api/admin/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ alert_recipients: rows }), signal: AbortSignal.timeout(20_000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to save recipients.");
      setSaved(parseAlertRecipients(body.alert_recipients)); setOpen(false);
      setNotice(rows.length ? `${rows.length} recipient${rows.length === 1 ? "" : "s"} saved. New alerts use these assignments.` : "All recipients removed. New SMS and email alerts have no assigned destinations.");
      void logActivity("UPDATE_SYSTEM_SETTING", "system_settings", "notification_recipients", { user_ids: rows.map(row => row.user_id) }).catch(() => {});
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save recipients."); }
    finally { setSaving(false); }
  }
  const emails = [...new Set(saved.filter(row => row.email_enabled).flatMap(row => {
    const user = eligible.find(user => user.id === row.user_id); return user?.email ? [user.email] : [];
  }))];
  return <>
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1"><h2 className="flex items-center gap-2 text-base font-bold text-theme-text"><Phone size={18} aria-hidden="true" className="shrink-0 text-theme-accent" />Alert Recipients — SMS &amp; Email</h2>
        <p className="mt-1 text-xs leading-5 text-theme-muted">Assign multiple verified administrators and managers. Choose email, SMS, or both for each account.</p></div>
      <button type="button" disabled={loading || Boolean(loadError) || usersLoading || Boolean(usersError)} onClick={() => { setDraft(saved.map(row => ({ ...row }))); setError(null); setNotice(""); setOpen(true); }} className="min-h-11 rounded-lg border border-theme-accent px-3 py-2 text-sm font-semibold text-theme-accent hover:bg-theme-accent-soft disabled:opacity-50">Manage recipients</button>
    </div>
    {loadError && <p role="alert" className="mb-3 text-sm text-theme-danger">{loadError}</p>}
    {usersError && <p role="alert" className="mb-3 text-sm text-theme-danger">{usersError}</p>}
    {notice && <p role="status" className="mb-3 text-sm text-theme-success">{notice}</p>}
    {loading ? <p className="text-sm text-theme-muted">Loading recipients…</p> : <ul className="space-y-3" aria-label="Assigned alert recipients">{saved.map(row => {
      const user = eligible.find(user => user.id === row.user_id);
      return <li key={row.user_id} className="rounded-lg border border-theme-border p-3 text-sm">
        <p className="break-words font-semibold text-theme-text">{user?.full_name || user?.email || "Account unavailable"}</p>
        {!user && <p className="mt-1 text-xs text-theme-danger">This account cannot receive new alerts. Remove it or verify its account details.</p>}
        <div className="mt-2 space-y-1 break-all text-theme-muted">{row.email_enabled && <p>Email: {user?.email ?? "Unavailable"}</p>}{row.sms_enabled && <p>SMS: {row.phone}</p>}</div>
      </li>;
    })}</ul>}
    {!loading && !loadError && !saved.length && <p className="text-sm text-theme-muted">No recipients assigned. Add accounts to receive alerts.</p>}
    <p className="mt-3 text-xs text-theme-muted">Applies to new greenhouse alerts. Shared phone numbers receive one SMS per scheduled send.</p>
    <GmailConnection recipientEmails={emails} />
    <Modal open={open} onClose={() => !saving && setOpen(false)} title="Manage alert recipients"
      description="Choose up to 20 verified accounts. Each recipient can receive email, SMS, or both. Removing every account stops new alert deliveries."
      footer={<><button type="button" disabled={saving} onClick={() => setOpen(false)} className="min-h-11 rounded-lg border border-theme-border px-4 py-2 text-sm text-theme-text disabled:opacity-50">Cancel</button><button type="button" disabled={saving || usersLoading || Boolean(usersError)} onClick={() => void save()} className="min-h-11 rounded-lg bg-theme-accent px-4 py-2 text-sm font-semibold text-theme-accent-foreground disabled:opacity-50">{saving ? "Saving…" : "Save recipients"}</button></>}>
      <div className="space-y-4">
        {error && <p role="alert" className="text-sm text-theme-danger">{error}</p>}
        {draft.map((row, index) => <fieldset key={index} disabled={saving} className="min-w-0 space-y-3 rounded-xl border border-theme-border p-3 disabled:opacity-60">
          <legend className="px-1 text-sm font-semibold text-theme-text">Recipient {index + 1}</legend>
          <label className="block text-sm text-theme-text">Account<select value={row.user_id} onChange={e => update(index, { user_id: e.target.value })} className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text">
            <option value="">Choose a verified user</option>
            {row.user_id && !eligible.some(user => user.id === row.user_id) && <option value={row.user_id}>Unavailable account — remove or replace</option>}
            {eligible.map(user => <option key={user.id} value={user.id} disabled={draft.some((r, i) => i !== index && r.user_id === user.id)}>{user.full_name || user.email} — {user.role}</option>)}
          </select></label>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-theme-text">
            <label className="flex min-h-11 cursor-pointer items-center gap-2"><input type="checkbox" checked={row.email_enabled} onChange={e => update(index, { email_enabled: e.target.checked })} className="size-4 accent-[var(--accent)]" />Email</label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2"><input type="checkbox" checked={row.sms_enabled} onChange={e => update(index, { sms_enabled: e.target.checked })} className="size-4 accent-[var(--accent)]" />SMS</label>
          </div>
          {row.email_enabled && <p className="break-all text-xs text-theme-muted">Email: {eligible.find(user => user.id === row.user_id)?.email || "Select an account above"}</p>}
          {row.sms_enabled && <label className="block text-sm text-theme-text">Philippine mobile number<span className="mt-1 flex min-h-11 items-center rounded-lg border border-theme-border bg-theme-surface"><span className="px-3 text-theme-muted">+63</span><input type="tel" inputMode="numeric" autoComplete="tel-national" aria-label={`Recipient ${index + 1} mobile number after +63`} value={toLocalDigits(row.phone)} onChange={e => update(index, { phone: toInternationalNumber(sanitizeLocalDigits(e.target.value)) })} placeholder="9XXXXXXXXX" className="min-w-0 flex-1 bg-transparent py-2 pr-3 text-theme-text outline-none focus-visible:ring-2 focus-visible:ring-theme-accent" /></span></label>}
          <button type="button" onClick={() => setDraft(rows => rows.filter((_, i) => i !== index))} aria-label={`Remove recipient ${index + 1}`} className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-theme-danger hover:bg-theme-danger/10"><Trash2 size={16} aria-hidden="true" />Remove</button>
        </fieldset>)}
        <button type="button" disabled={saving || draft.length >= MAX_ALERT_RECIPIENTS || !eligible.some(user => !draft.some(row => row.user_id === user.id))} onClick={() => setDraft(rows => [...rows, { user_id: "", phone: "", email_enabled: true, sms_enabled: true }])} className="flex min-h-11 items-center gap-2 rounded-lg border border-theme-accent px-3 py-2 text-sm font-semibold text-theme-accent disabled:opacity-50"><Plus size={16} aria-hidden="true" />Add recipient</button>
        {!eligible.length && <p className="text-sm text-theme-muted">Verify an administrator or manager account in Team management first.</p>}
      </div>
    </Modal>
  </>;
}
