import type { SupabaseClient } from "@supabase/supabase-js";
import type { GmailCredentials } from "../../supabase/functions/_shared/gmail-delivery";
export async function gmailAuthorization(admin: SupabaseClient): Promise<{credentials: GmailCredentials | null; error: string | null}> {
  const clientId=process.env.GOOGLE_GMAIL_CLIENT_ID,clientSecret=process.env.GOOGLE_GMAIL_CLIENT_SECRET;
  // Synchronize the existing server configuration, so Edge workers use the same
  // OAuth application as the administrator's saved connection.
  if (clientId && clientSecret) {
    const result=await admin.rpc("set_gmail_client_configuration",{p_client_id:clientId,p_client_secret:clientSecret});
    if(result.error) return {credentials:null,error:"Gmail configuration could not be synchronized. Apply the notification retry database migration."};
  }
  const {data,error}=await admin.rpc("get_gmail_authorization",{});
  if(error) return {credentials:null,error:"Saved Gmail authorization is unavailable."};
  if(!data) return {credentials:null,error:null};
  return {credentials:{...data,client_id:data.client_id || clientId || "",client_secret:data.client_secret || clientSecret || ""},error:null};
}
