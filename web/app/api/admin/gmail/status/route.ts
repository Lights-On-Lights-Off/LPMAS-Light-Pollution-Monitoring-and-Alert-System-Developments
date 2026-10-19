import { NextResponse } from "next/server";
import { backendClient, verifiedAdministrator } from "@/lib/server-auth";
import { gmailAuthorization } from "@/lib/gmail-authorization";
import { refreshGmail } from "../../../../../../supabase/functions/_shared/gmail-delivery";
export async function GET() {
  if (!await verifiedAdministrator()) return NextResponse.json({error:"Verified administrator required."},{status:403});
  const admin=backendClient();
  if(!admin) return NextResponse.json({error:"Email sending is not configured."},{status:503});
  const authorization=await gmailAuthorization(admin);
  if(authorization.error) return NextResponse.json({error:authorization.error},{status:503});
  const credentials=authorization.credentials;
  const configured=Boolean(credentials?.client_id && credentials?.client_secret || process.env.GOOGLE_GMAIL_CLIENT_ID && process.env.GOOGLE_GMAIL_CLIENT_SECRET);
  const check=credentials ? await refreshGmail(credentials,credentials.client_id ?? "",credentials.client_secret ?? "",(url,init) => fetch(url,init)) : null;
  const authorized=Boolean(check && "accessToken" in check);
  return NextResponse.json({configured,authorized,available:!check || authorized || "reconnect" in check && check.reconnect === true,sender_email:credentials?.sender_email ?? null,
    detail:authorized ? "Gmail authorization is active and refreshes automatically. Send a test email to verify sending." : check && "detail" in check ? check.detail : "Connect the Gmail matching your verified administrator account."},
    {headers:{"Cache-Control":"no-store"}});
}
