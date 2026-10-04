export interface GmailCredentials {
  sender_email: string;
  refresh_token: string;
}
const emailPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export function validEmail(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 254 || value !== value.trim() || !emailPattern.test(value)) return false;
  const [local, domain] = value.split("@");
  return local.length <= 64 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") &&
    domain.split(".").every(label => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"));
}
export async function sendGmail(
  credentials: GmailCredentials,
  clientId: string,
  clientSecret: string,
  recipient: string,
  message: string,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
): Promise<"accepted" | "failed" | "unknown"> {
  if (!validEmail(credentials.sender_email) || !validEmail(recipient) || !credentials.refresh_token || !clientId || !clientSecret) return "failed";
  // Refresh only the authorization token; never retry the message send.
  let accessToken: string;
  try {
    const tokenResponse = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
        refresh_token: credentials.refresh_token, grant_type: "refresh_token" }),
    });
    if (!tokenResponse.ok) return "failed";
    const token = await tokenResponse.json();
    if (typeof token.access_token !== "string" || !token.access_token) return "failed";
    accessToken = token.access_token;
  } catch {
    // No message submission has happened yet, so acceptance is not ambiguous.
    return "failed";
  }
  const body = btoa(String.fromCharCode(...new TextEncoder().encode(message)));
  const subject = message.startsWith("LPMAS RESOLVED") ? "LPMAS greenhouse resolved" : "LPMAS greenhouse alert";
  const mime = `From: ${credentials.sender_email}\r\nTo: ${recipient}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`;
  const raw = btoa(mime).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    const response = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (response.ok) return "accepted";
    return response.status >= 500 ? "unknown" : "failed";
  } catch { return "unknown"; }
}

export function gmailSender(client: {rpc(name: string, args: Record<string, unknown>): PromiseLike<{data: unknown; error: unknown}>}) {
  return async (recipient: string, message: string) => {
    const {data, error} = await client.rpc("get_gmail_authorization", {});
    if (error || !data) return "failed" as const;
    return sendGmail(data as GmailCredentials, Deno.env.get("GOOGLE_GMAIL_CLIENT_ID") ?? "",
      Deno.env.get("GOOGLE_GMAIL_CLIENT_SECRET") ?? "", recipient, message, (url, init) => fetch(url, init));
  };
}
