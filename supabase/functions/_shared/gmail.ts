import { type GmailCredentials, sendGmailDetailed } from "./gmail-delivery.ts";
export { sendGmail, sendGmailDetailed, validEmail, refreshGmail } from "./gmail-delivery.ts";
export type { GmailCredentials, DeliveryResult } from "./gmail-delivery.ts";

export function gmailSender(client: {rpc(name: string, args: Record<string, unknown>): PromiseLike<{data: unknown; error: unknown}>}, dashboardOrigin?: string) {
  return async (recipient: string, message: string) => {
    const {data, error} = await client.rpc("get_gmail_authorization", {});
    if (error || !data) return {outcome:"failed" as const,detail:"Saved Gmail authorization is unavailable. Connect Gmail in administrator settings."};
    const credentials=data as GmailCredentials;
    return sendGmailDetailed(credentials, credentials.client_id || Deno.env.get("GOOGLE_GMAIL_CLIENT_ID") || "",
      credentials.client_secret || Deno.env.get("GOOGLE_GMAIL_CLIENT_SECRET") || "",recipient,message,(url,init) => fetch(url,init),undefined,dashboardOrigin);
  };
}
