import { sendGmailDetailed, type GmailCredentials, type Fetcher } from "../../supabase/functions/_shared/gmail-delivery.ts";
export { validEmail } from "../../supabase/functions/_shared/gmail-delivery.ts";
export type { GmailCredentials } from "../../supabase/functions/_shared/gmail-delivery.ts";
export async function sendTestEmail(credentials: GmailCredentials, clientId: string, clientSecret: string, recipient: string, message: string, fetchImpl: Fetcher) {
  return (await sendGmailDetailed(credentials,clientId,clientSecret,recipient,message,fetchImpl,"LPMAS test email")).outcome;
}
