import { backendAuthorized } from "../_shared/backend-auth.ts";
import { createHandler as createIngestHandler } from "../ingest-reading/index.ts";

export interface GatewayDeps {
  piToken: string;
  configuration(): Promise<unknown>;
  publishTunnel(url: string): Promise<void>;
  authorizeUser(token: string): Promise<string | null>;
  ingest(delivery: unknown): Promise<Response>;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: {"Content-Type":"application/json", "Cache-Control":"no-store"},
});
export function validTunnelOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      /^[-a-z0-9]+\.trycloudflare\.com$/.test(url.hostname) &&
      url.origin === value;
  } catch { return false; }
}
export function createHandler(deps: GatewayDeps) {
  return async (request: Request): Promise<Response> => {
    if (deps.piToken.length < 32 || !backendAuthorized(request.headers.get("Authorization"), deps.piToken)) {
      return json(401, {error:"Pi authorization required"});
    }
    if (request.method !== "POST") return json(405, {error:"POST required"});
    let body: Record<string, unknown>;
    try {
      const reader = request.body?.getReader();
      if (!reader) return json(400, {error:"JSON object required"});
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 65_536) {await reader.cancel(); return json(413, {error:"Payload too large"});}
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
      body = JSON.parse(new TextDecoder().decode(bytes));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch { return json(400, {error:"JSON object required"}); }
    try {
      switch (body.action) {
        case "ingest": return await deps.ingest(body.delivery);
        case "configuration": return json(200, await deps.configuration());
        case "publish-tunnel":
          if (!validTunnelOrigin(body.url)) return json(400, {error:"A Cloudflare HTTPS tunnel origin is required"});
          await deps.publishTunnel(body.url);
          return json(200, {ok:true});
        case "authorize-operator": {
          if (typeof body.access_token !== "string" || body.access_token.length > 8192) return json(400, {error:"Invalid user token"});
          const role = await deps.authorizeUser(body.access_token);
          return role === "admin" || role === "manager" ? json(200, {role}) : json(403, {error:"Operator access required"});
        }
        default: return json(400, {error:"Operation not permitted"});
      }
    } catch {
      // Never return upstream database, authentication, or credential details.
      return json(503, {error:"Cloud operation unavailable"});
    }
  };
}

declare const EdgeRuntime: {waitUntil(task: Promise<unknown>): void};
if (import.meta.main) {
  const {createClient} = await import("https://esm.sh/@supabase/supabase-js@2.49.1");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const client = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceRoleKey, {auth:{persistSession:false}});
  const ingest = createIngestHandler({
    client, serviceRoleKey,
    async readSettings() {
      const {data,error} = await client.from("system_settings").select("key,value").in("key",["sms_provider","textbee_api_key","manager_phone"]);
      if (error) throw error;
      return Object.fromEntries((data ?? []).map(row => [row.key,row.value]));
    },
    fetchImpl:(url,init) => fetch(url,init),
    spawn:task => EdgeRuntime.waitUntil(task),
    log:(level,message) => level === "error" ? console.error(message) : console.info(message),
  });
  Deno.serve(createHandler({
    piToken:Deno.env.get("LPMAS_PI_TOKEN") ?? "",
    async configuration() {
      const {data,error} = await client.rpc("pi_configuration", {});
      if (error) throw error;
      return data;
    },
    async publishTunnel(url) {
      const {error} = await client.from("system_settings").upsert({key:"pi_api_url",value:url,updated_at:new Date().toISOString()},{onConflict:"key"});
      if (error) throw error;
    },
    async authorizeUser(token) {
      const {data,error} = await client.auth.getUser(token);
      if (error || !data.user) return null;
      const profile = await client.from("profiles").select("role").eq("id",data.user.id).maybeSingle();
      if (profile.error) throw profile.error;
      return profile.data?.role ?? null;
    },
    ingest:delivery => ingest(new Request("https://internal.invalid/ingest",{
      method:"POST",headers:{Authorization:`Bearer ${serviceRoleKey}`},body:JSON.stringify(delivery ?? null),
    })),
  }));
}
