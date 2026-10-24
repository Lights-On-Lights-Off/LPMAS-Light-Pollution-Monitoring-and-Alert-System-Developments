import { NextRequest, NextResponse } from "next/server";
import { backendClient, serverAuth } from "@/lib/server-auth";
import { gmailAuthorization } from "@/lib/gmail-authorization";
import { sendGmailDetailed, type DeliveryResult } from "../../../../../supabase/functions/_shared/gmail-delivery";
import { buildSendRequest, interpretProviderResponse, resolveProvider, SMS_SETTING_KEYS } from "../../../../../supabase/functions/send-test-sms/sms-provider";
import { validatePiUrl } from "@/lib/pi-url";
export const maxDuration=60;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function POST(request: NextRequest) {
  const auth=await serverAuth(),admin=backendClient();
  if(!auth || !admin) return NextResponse.json({error:"Notification service is unavailable."},{status:503});
  const {data:userData,error:userError}=await auth.auth.getUser();
  const user=userData.user;
  if(userError || !user?.email_confirmed_at) return NextResponse.json({error:"Verified operator required."},{status:403});
  const profile=await auth.from("profiles").select("role").eq("id",user.id).maybeSingle();
  if(profile.error || !["admin","manager"].includes(profile.data?.role)) return NextResponse.json({error:"Manager or administrator required."},{status:403});
  let body;
  try { body=await request.json(); } catch { return NextResponse.json({error:"Invalid retry request."},{status:400}); }
  if(!body || !uuid.test(body.job_id ?? "") || !uuid.test(body.request_id ?? "") || !["cloud","local"].includes(body.source)) return NextResponse.json({error:"Invalid retry request."},{status:400});
  if(body.intent !== undefined && body.intent !== "resend_sms") return NextResponse.json({error:"Invalid resend action."},{status:400});
  const manualSms=body.intent === "resend_sms";
  const claim=await admin.rpc(manualSms ? "claim_manual_sms_resend" : "claim_manual_notification_retry",{p_id:body.request_id,p_source:body.source,p_job_id:body.job_id,p_actor_id:user.id});
  if(claim.error) return NextResponse.json({error:claim.error.code === "P0001" ? claim.error.message : "Manual retry is unavailable. Check the database migration and notification configuration."},{status:409});
  const job=claim.data;
  if(!job) return NextResponse.json({error:"Retry could not be claimed."},{status:409});
  if(job.existing) return NextResponse.json({status:job.status,message:job.detail,attempt_id:job.id});
  let result: DeliveryResult | {outcome:"sent"|"delivered";detail:string}={outcome:"unknown",detail:"Manual resend outcome is unconfirmed. Do not resend until the provider result is known."};
  try {
    if(job.channel === "email") {
      const authorization=await gmailAuthorization(admin);
      result=authorization.credentials ? await sendGmailDetailed(authorization.credentials,authorization.credentials.client_id ?? "",authorization.credentials.client_secret ?? "",job.recipient,job.message,(url,init) => fetch(url,init),undefined,process.env.LPMAS_WEB_ORIGIN)
        : {outcome:"failed",detail:authorization.error ?? "Gmail is not connected. Connect Gmail in administrator settings."};
    } else if(job.source === "local") {
      const setting=await admin.from("system_settings").select("value").eq("key","pi_api_url").maybeSingle();
      const session=await auth.auth.getSession();
      if(setting.error || !setting.data?.value || !session.data.session?.access_token) result={outcome:"failed",detail:"The local SMS system is unavailable. No resend was submitted."};
      else {
        const origin=validatePiUrl(process.env.NEXT_PUBLIC_PI_API_URL || setting.data.value,process.env.NODE_ENV !== "production");
        const response=await fetch(`${origin}/api/notification-retries`,{method:"POST",redirect:"error",signal:AbortSignal.timeout(15_000),headers:{Authorization:`Bearer ${session.data.session.access_token}`,"Content-Type":"application/json"},body:JSON.stringify({request_id:job.id,job_id:job.original_job_id,...(manualSms ? {intent:"resend_sms"} : {})})});
        const payload=await response.json().catch(() => ({}));
        if(response.ok && ["accepted","sent","delivered","failed","unknown"].includes(payload.outcome)) result={outcome:payload.outcome,detail:typeof payload.detail === "string" ? payload.detail : "Local SMS resend outcome unconfirmed."};
        else if([400,401,403,404,409,503].includes(response.status)) result={outcome:"failed",detail:"The Pi could not accept the manual SMS retry. Check that the updated Pi service is running and local SMS is enabled."};
      }
    } else {
      const settings=await admin.from("system_settings").select("key,value").in("key",SMS_SETTING_KEYS);
      const config=settings.error ? null : resolveProvider({...Object.fromEntries((settings.data ?? []).map(row => [row.key,row.value])),manager_phone:job.recipient});
      const sending=config ? buildSendRequest(config,job.message) : null;
      if(!config || !sending?.ok) result={outcome:"failed",detail:"Cloud SMS sending is not configured. Check the SMS provider settings."};
      else {
        const response=await fetch(sending.url,{...sending.init,redirect:"error",signal:AbortSignal.timeout(10_000)});
        const outcome=interpretProviderResponse(config,response.status,await response.text());
        result=outcome.ok ? {outcome:"accepted",detail:"Accepted by the SMS provider; recipient delivery unconfirmed."}
          : response.status>=500 ? {outcome:"unknown",detail:"SMS provider acceptance is unconfirmed. Check the recipient before resending."}
          : {outcome:"failed",detail:`SMS provider rejected the resend (HTTP ${response.status}). Check the provider configuration and sending limits.`};
      }
    }
  } catch { /* A network failure after a claim may follow provider acceptance. */ }
  const finish=await admin.rpc("finish_manual_notification_retry",{p_id:job.id,p_attempt_token:job.attempt_token,p_outcome:result.outcome,p_detail:result.detail});
  if(finish.error) return NextResponse.json({status:"unknown",message:"Resend outcome could not be saved. Refresh notification details before another attempt.",attempt_id:job.id},{status:503});
  return NextResponse.json({status:result.outcome,message:result.detail,attempt_id:job.id});
}
