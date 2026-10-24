/** New structured notices get concise subjects; historical queued bodies remain readable. */
export function notificationSubject(message: string): string {
  const greenhouse = message.match(/^Greenhouse: ([^\r\n]+)$/m)?.[1]?.trim().slice(0, 80);
  if (!greenhouse) return message.startsWith("LPMAS RESOLVED") ? "LPMAS greenhouse resolved"
    : message.startsWith("LPMAS CLOSED") ? "LPMAS greenhouse closed" : "LPMAS greenhouse violation";
  const event = message.startsWith("LPMAS RESOLVED") ? "Safe levels restored"
    : message.startsWith("LPMAS CLOSED") ? "Closed - recovery unconfirmed" : "Light violation";
  return `LPMAS | ${event} | ${greenhouse}`;
}
export function testEmailMessage(now = new Date()): string {
  return `LPMAS TEST: Email channel check\n\nThis is a test message. It does not report a greenhouse incident.\n\nSent: ${now.toISOString()} (UTC)\n\nIf this arrived in the intended manager inbox, the email delivery path worked for this test.\n\nNext step\nReturn to administrator settings and confirm the saved alert recipient.\n\nLPMAS - Light Pollution Monitoring and Alert System`;
}

export const SYSTEM_WEB_ORIGIN = "https://lpmas-light-pollution-monitoring-an-sage.vercel.app";

/** Links contain no credentials or incident data. Authentication stays on the website. */
export function notificationDashboardUrl(origin = SYSTEM_WEB_ORIGIN): string {
  try {
    const url = new URL(origin);
    if (url.protocol === "https:" && !url.username && !url.password && url.origin === origin) {
      return new URL("/dashboard", url).href;
    }
  } catch { /* Use the established public system origin. */ }
  return `${SYSTEM_WEB_ORIGIN}/dashboard`;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);
const paragraphs = (value: string) => value.split(/\n\n+/).map(text =>
  `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#374151">${escapeHtml(text).replace(/\n/g, "<br>")}</p>`
).join("");

/** Email-client-compatible presentation around the unchanged, durable event text. */
export function renderNotificationEmail(message: string, origin?: string) {
  const url = notificationDashboardUrl(origin);
  const historical = message.includes("This incident has already ended.");
  const state = message.startsWith("LPMAS TEST")
    ? { badge: "EMAIL CHANNEL CHECK", title: "Test notification", color: "#1d4ed8", background: "#eff6ff" }
    : message.startsWith("LPMAS RESOLVED")
    ? { badge: "SAFE LEVELS RESTORED", title: "Light levels have recovered", color: "#166534", background: "#f0fdf4" }
    : message.startsWith("LPMAS CLOSED")
    ? { badge: "RECOVERY UNCONFIRMED", title: "Monitoring incident closed", color: "#92400e", background: "#fffbeb" }
    : message.startsWith("LPMAS ALERT")
    ? { badge: historical ? "PAST INCIDENT" : "LIGHT ALERT", title: "Light violation recorded", color: "#b91c1c", background: "#fef2f2" }
    : { badge: "SYSTEM UPDATE", title: "Greenhouse notification", color: "#166534", background: "#f0fdf4" };
  const field = (name: string) => message.match(new RegExp(`^${name}: ([^\\r\\n]+)$`, "m"))?.[1] ?? "";
  const rows = [["Greenhouse", field("Greenhouse")], ["Event time", field("Event time")], ["Incident reference", field("Incident reference")]]
    .filter(([, value]) => value);
  const explanation = message.match(/\n\nWhat happened\n([\s\S]*?)\n\nNext steps\n/)?.[1];
  const action = message.match(/\n\nNext steps\n([\s\S]*?)\n\nLPMAS/)?.[1];
  const details = rows.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 24px;background:#f8faf9;border:1px solid #dbe5df;border-radius:8px">${rows.map(([label, value]) =>
    `<tr><td style="padding:12px 16px;vertical-align:top;font-size:13px;line-height:1.5;color:#4b5563;width:110px">${escapeHtml(label)}</td><td style="padding:12px 16px;font-size:15px;line-height:1.5;font-weight:600;color:#111827;word-break:break-word;overflow-wrap:anywhere">${escapeHtml(value)}</td></tr>`
  ).join("")}</table>` : "";
  const content = explanation && action
    ? `<h2 style="margin:0 0 8px;font-size:18px;line-height:1.4;color:#111827">What happened</h2>${paragraphs(explanation)}<h2 style="margin:22px 0 8px;font-size:18px;line-height:1.4;color:#111827">Next steps</h2>${paragraphs(action)}`
    : paragraphs(message);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(state.title)}</title></head>
<body style="margin:0;padding:0;background:#f3f6f4;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(`${state.title}${field("Greenhouse") ? ` — ${field("Greenhouse")}` : ""}. Review the latest status in your dashboard.`)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f6f4"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dbe5df;border-radius:12px">
<tr><td style="padding:24px;border-bottom:1px solid #dbe5df"><p style="margin:0;font-size:22px;font-weight:700;letter-spacing:1px;color:#14532d">LPMAS</p><p style="margin:5px 0 0;font-size:13px;line-height:1.5;color:#4b5563">Light Pollution Monitoring and Alert System</p></td></tr>
<tr><td style="padding:28px 24px"><p style="display:inline-block;margin:0 0 14px;padding:7px 10px;font-size:12px;line-height:1.4;font-weight:700;letter-spacing:0.6px;color:${state.color};background:${state.background};border-radius:5px">${state.badge}</p>
<h1 style="margin:0 0 24px;font-size:28px;line-height:1.25;color:#111827">${state.title}</h1>${details}${content}
<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 16px"><tr><td align="center" bgcolor="#166534" style="background:#166534;border-radius:7px"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 24px;border:1px solid #166534;border-radius:7px;font-size:16px;line-height:22px;font-weight:700;text-decoration:none;color:#ffffff;mso-padding-alt:14px 24px">Open dashboard</a></td></tr></table>
<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#4b5563">Sign in with your system account to review the latest incident status.</p><p style="margin:0;font-size:12px;line-height:1.5;color:#4b5563;word-break:break-word">Button not opening? <a href="${escapeHtml(url)}" style="color:#166534;text-decoration:underline">${escapeHtml(url)}</a></p></td></tr>
<tr><td style="padding:18px 24px;border-top:1px solid #dbe5df;font-size:12px;line-height:1.6;color:#4b5563">This email records an event at the stated time. Conditions may have changed.<br>Automated notification from LPMAS.</td></tr></table>
</td></tr></table></body></html>`;
  return { html, text: `${message}\n\nOpen dashboard:\n${url}`, dashboardUrl: url };
}

/** Fold UTF-8 subjects into MIME encoded words without splitting a code point. */
export function notificationSubjectHeader(subject: string): string {
  const clean = subject.replace(/[\x00-\x1f\x7f]/g, " ");
  if (!/[^\x20-\x7e]/.test(clean)) return clean;
  const words: string[] = [];
  let bytes: number[] = [];
  const flush = () => { if (bytes.length) words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`); bytes = []; };
  for (const character of clean) {
    const encoded = [...new TextEncoder().encode(character)];
    if (bytes.length + encoded.length > 42) flush();
    bytes.push(...encoded);
  }
  flush();
  return words.join("\r\n ");
}
