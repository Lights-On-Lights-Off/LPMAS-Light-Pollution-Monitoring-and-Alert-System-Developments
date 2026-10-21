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
