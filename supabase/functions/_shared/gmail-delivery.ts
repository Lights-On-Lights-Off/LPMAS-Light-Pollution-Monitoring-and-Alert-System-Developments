export interface GmailCredentials {
  sender_email: string;
  refresh_token: string;
  client_id?: string;
  client_secret?: string;
}
export type DeliveryResult = { outcome: "accepted" | "failed" | "unknown"; detail: string };
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const emailPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export function validEmail(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 254 || value !== value.trim() || !emailPattern.test(value)) return false;
  const [local, domain] = value.split("@");
  return local.length <= 64 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") &&
    domain.split(".").every(label => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"));
}
// Only fixed explanations leave this module. Provider bodies may contain secrets.
export async function refreshGmail(credentials: GmailCredentials, clientId: string, clientSecret: string, fetchImpl: Fetcher): Promise<{accessToken: string} | {detail: string; reconnect?: boolean}> {
  if (!clientId || !clientSecret) return {detail:"Gmail OAuth client configuration is missing. Open administrator Gmail settings to synchronize it."};
  if (!credentials.refresh_token || !validEmail(credentials.sender_email)) return {detail:"Gmail is not authorized. An administrator must connect Gmail.",reconnect:true};
  try {
    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method:"POST",redirect:"error",signal:AbortSignal.timeout(10_000),
      body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:credentials.refresh_token,grant_type:"refresh_token"}),
    });
    const token = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (token.error === "invalid_grant") return {detail:"Google expired or revoked the Gmail authorization. Reconnect Gmail in administrator settings.",reconnect:true};
      if (token.error === "invalid_client" || token.error === "unauthorized_client") return {detail:"Google rejected the Gmail OAuth client. Check the configured client ID and secret."};
      return {detail:"Google could not refresh Gmail authorization. No email was submitted; try again later."};
    }
    if (typeof token.access_token !== "string" || !token.access_token) return {detail:"Google did not issue a Gmail access token. No email was submitted."};
    if (typeof token.scope === "string" && !token.scope.split(" ").includes("https://www.googleapis.com/auth/gmail.send")) return {detail:"Gmail sending permission is missing. Reconnect Gmail and allow sending.",reconnect:true};
    return {accessToken:token.access_token};
  } catch { return {detail:"Gmail authorization refresh was unavailable. No email was submitted; try again later."}; }
}
export async function sendGmailDetailed(credentials: GmailCredentials, clientId: string, clientSecret: string, recipient: string, message: string, fetchImpl: Fetcher, subjectOverride?: string): Promise<DeliveryResult> {
  if (!validEmail(recipient)) return {outcome:"failed",detail:"The notification recipient email is missing or invalid. Save a verified manager recipient in administrator settings."};
  const authorization = await refreshGmail(credentials,clientId,clientSecret,fetchImpl);
  if (!("accessToken" in authorization)) return {outcome:"failed",detail:authorization.detail};
  const body=btoa(String.fromCharCode(...new TextEncoder().encode(message)));
  const subject=subjectOverride ?? (message.startsWith("LPMAS RESOLVED") ? "LPMAS greenhouse resolved" : message.startsWith("LPMAS CLOSED") ? "LPMAS greenhouse closed" : "LPMAS greenhouse violation");
  const mime=`From: ${credentials.sender_email}\r\nTo: ${recipient}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`;
  const raw=btoa(mime).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
  try {
    const response=await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method:"POST",redirect:"error",signal:AbortSignal.timeout(10_000),headers:{Authorization:`Bearer ${authorization.accessToken}`,"Content-Type":"application/json"},body:JSON.stringify({raw}),
    });
    if(response.ok) return {outcome:"accepted",detail:"Accepted by Gmail; recipient delivery unconfirmed."};
    if(response.status>=500) return {outcome:"unknown",detail:"Gmail acceptance is unconfirmed. Check the recipient inbox before another send."};
    if(response.status===401) return {outcome:"failed",detail:"Gmail rejected the access token. Reconnect Gmail in administrator settings."};
    if(response.status===403) return {outcome:"failed",detail:"Gmail denied sending. Check Gmail API enablement, Google account restrictions, and sending limits."};
    if(response.status===429) return {outcome:"failed",detail:"Gmail sending limit reached. Wait before retrying."};
    return {outcome:"failed",detail:`Gmail rejected the email (HTTP ${response.status}). Check the sender and recipient configuration.`};
  } catch { return {outcome:"unknown",detail:"Gmail submission outcome is unconfirmed. Check the recipient inbox before another send."}; }
}
export async function sendGmail(credentials: GmailCredentials, clientId: string, clientSecret: string, recipient: string, message: string, fetchImpl: Fetcher) {
  return (await sendGmailDetailed(credentials,clientId,clientSecret,recipient,message,fetchImpl)).outcome;
}
