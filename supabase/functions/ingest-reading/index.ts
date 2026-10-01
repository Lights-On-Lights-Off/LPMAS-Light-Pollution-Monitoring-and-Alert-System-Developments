/** Idempotent Pi ingestion. The Pi owns incident confirmation; minute counts
 * are summaries only. Notification jobs are durable, leased and retried. */
import { backendAuthorized } from "../_shared/backend-auth.ts";
import {
  buildSendRequest,
  interpretTextbeeResponse,
  resolveProvider,
} from "../send-test-sms/sms-provider.ts";

export type PhaseType = "illumination" | "dark";
export type Classification = "safe" | "warning" | "violation" | "unclassified";
export interface IncidentSnapshot {
  legacy?: boolean;
  id: number;
  incident_uid: string;
  version: number;
  sensor_id: string;
  greenhouse_id: string;
  phase_type: PhaseType;
  opened_at: string;
  resolved_at: string | null;
  status: "open" | "acknowledged" | "resolved";
  peak_lux: number;
  lowest_lux: number;
  reason: string;
  triggering_readings: Array<
    {
      sensor_id: string;
      greenhouse_id: string;
      phase_type: string;
      classification: string;
      recorded_at: string;
      lux: number;
    }
  >;
}
export interface Delivery {
  kind: "reading" | "incident";
  delivery_id: string;
  recorded_at: string;
  sensor_id?: string;
  lux?: number;
  greenhouse_id?: string | null;
  phase_type?: PhaseType | "unconfigured";
  classification?: Classification;
  monitoring_active?: boolean;
  config_version?: string;
  incident: IncidentSnapshot | null;
}
export interface SupabaseLike {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
export interface HandlerDeps {
  client: SupabaseLike;
  serviceRoleKey: string;
  readSettings(): Promise<Record<string, string>>;
  fetchImpl(input: string, init: RequestInit): Promise<Response>;
  log(level: "info" | "error", message: string): void;
  spawn(task: Promise<unknown>): void;
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const timestamp = (v: unknown): v is string =>
  typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v));
const luxValue = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 65535;
const identifier = (v: unknown): v is string =>
  typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 100;
export function classifyReading(lux: number, phase: PhaseType): Classification {
  if (phase === "dark") {
    return lux <= 15 ? "safe" : lux <= 29 ? "warning" : "violation";
  }
  return lux <= 30 ? "violation" : lux < 50 ? "warning" : "safe";
}
export function validateDelivery(
  body: unknown,
): { ok: true; value: Delivery } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("JSON object required");
  }
  const p = body as Record<string, unknown>;
  if (typeof p.delivery_id !== "string" || !UUID.test(p.delivery_id)) {
    return fail("UUID delivery_id required");
  }
  if (!timestamp(p.recorded_at)) {
    return fail("Timestamp with timezone required");
  }
  if (p.kind !== "reading" && p.kind !== "incident") {
    return fail("Invalid delivery kind");
  }
  if (p.kind === "reading") {
    if (!identifier(p.sensor_id) || !luxValue(p.lux)) {
      return fail("Invalid sensor or lux value");
    }
    if (p.greenhouse_id != null && !identifier(p.greenhouse_id)) {
      return fail("Invalid greenhouse");
    }
    if (
      !identifier(p.config_version) || typeof p.monitoring_active !== "boolean"
    ) return fail("Configuration snapshot required");
    if (
      !["illumination", "dark", "unconfigured"].includes(String(p.phase_type))
    ) return fail("Invalid phase");
    if (p.monitoring_active) {
      if (
        !p.greenhouse_id || p.phase_type === "unconfigured" ||
        p.classification !== classifyReading(p.lux, p.phase_type as PhaseType)
      ) return fail("Classification and phase disagree");
    } else if (p.classification !== "unclassified") {
      return fail("Unmonitored readings must be unclassified");
    }
  }
  const i = p.incident as IncidentSnapshot | null;
  if (p.kind === "incident" && !i) return fail("Incident snapshot required");
  if (i != null) {
    if (
      typeof i !== "object" || !Number.isSafeInteger(i.id) || i.id < 1 ||
      !Number.isSafeInteger(i.version) || i.version < 1 ||
      typeof i.incident_uid !== "string" || !UUID.test(i.incident_uid) ||
      !identifier(i.sensor_id) || !identifier(i.greenhouse_id) ||
      !["illumination", "dark"].includes(i.phase_type) ||
      !timestamp(i.opened_at) ||
      !["open", "acknowledged", "resolved"].includes(i.status) ||
      !luxValue(i.peak_lux) || !luxValue(i.lowest_lux) ||
      i.peak_lux < i.lowest_lux ||
      typeof i.reason !== "string" || i.reason.length > 200 ||
      (i.status === "resolved"
        ? !timestamp(i.resolved_at)
        : i.resolved_at !== null)
    ) return fail("Invalid incident snapshot");
    if (
      p.kind === "reading" &&
      (i.sensor_id !== p.sensor_id || i.greenhouse_id !== p.greenhouse_id ||
        i.phase_type !== p.phase_type)
    ) return fail("Incident context differs from reading");
    if (
      !Array.isArray(i.triggering_readings) ||
      (i.triggering_readings.length !== 3 &&
        !(i.legacy === true && i.triggering_readings.length === 0))
    ) return fail("Three triggering readings required");
    let previous = 0;
    for (const r of i.triggering_readings) {
      if (
        !r || r.sensor_id !== i.sensor_id ||
        r.greenhouse_id !== i.greenhouse_id || r.phase_type !== i.phase_type ||
        r.classification !== "violation" || !luxValue(r.lux) ||
        classifyReading(r.lux, i.phase_type) !== "violation" ||
        !timestamp(r.recorded_at)
      ) return fail("Invalid triggering sequence");
      const current = Date.parse(r.recorded_at);
      if (previous && (current <= previous || current - previous > 15_000)) {
        return fail("Triggering sequence interrupted");
      }
      previous = current;
    }
  }
  // Preserve the exact payload for collision detection; do not normalize fields
  // differently between first delivery and replay.
  return { ok: true, value: body as Delivery };
}
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
interface NotificationJob {
  id: string;
  lease_token: string;
  incident: IncidentSnapshot;
}
export async function drainNotifications(deps: HandlerDeps): Promise<number> {
  const claim = await deps.client.rpc("claim_notification_jobs", {
    p_limit: 5,
  });
  if (claim.error) throw new Error(claim.error.message);
  let count = 0;
  for (const job of (claim.data ?? []) as NotificationJob[]) {
    let accepted = false,
      detail = "SMS not configured",
      recipient = "",
      secret = "";
    try {
      const config = resolveProvider(await deps.readSettings());
      if (config) {
        recipient = config.recipient;
        secret = config.apiKey;
        const i = job.incident;
        // ASCII avoids accidental multi-segment UCS-2 messages. Keep identifiers
        // compact; full incident details remain available in the dashboard.
        const message = `LPMAS ${i.phase_type} violation: ${
          i.sensor_id.slice(0, 24)
        } at ${
          i.greenhouse_id.slice(0, 24)
        }. ${i.lowest_lux}-${i.peak_lux} lux. ${i.opened_at.slice(0, 19)}`
          .replace(/[^\x20-\x7E]/g, "?").slice(0, 160);
        const request = buildSendRequest(config, message);
        if (!request.ok) detail = request.error;
        else {
          const response = await deps.fetchImpl(request.url, {
            ...request.init,
            signal: AbortSignal.timeout(10_000),
          });
          const outcome = interpretTextbeeResponse(
            response.status,
            await response.text(),
            secret,
          );
          accepted = outcome.ok;
          detail = accepted
            ? "Accepted by provider; handset delivery unconfirmed"
            : outcome.detail ?? "Provider rejected SMS";
        }
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : "SMS request failed";
    }
    if (secret) detail = detail.split(secret).join("[redacted]");
    const finish = await deps.client.rpc("finish_notification_job", {
      p_id: job.id,
      p_lease_token: job.lease_token,
      p_accepted: accepted,
      p_detail: detail,
      p_recipient: recipient,
    });
    if (finish.error) throw new Error(finish.error.message);
    count++;
  }
  return count;
}
export function createHandler(deps: HandlerDeps) {
  return async (request: Request): Promise<Response> => {
    if (
      !backendAuthorized(
        request.headers.get("Authorization"),
        deps.serviceRoleKey,
      )
    ) return json(401, { error: "Backend authorization required" });
    if (request.method !== "POST") return json(405, { error: "POST required" });
    let body: unknown;
    try {
      const raw = await request.text();
      if (raw.length > 32_768) return json(413, { error: "Payload too large" });
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "Valid JSON required" });
    }
    const retryOnly = body && typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      (body as Record<string, unknown>).retry_notifications === true;
    let result: unknown = { ok: true };
    if (!retryOnly) {
      const validation = validateDelivery(body);
      if (!validation.ok) return json(400, { error: validation.error });
      const ingestion = await deps.client.rpc("ingest_pilot_delivery", {
        p_payload: validation.value,
      });
      if (ingestion.error) {
        deps.log("error", "Transactional ingestion failed");
        return json(500, { error: "Unable to commit delivery" });
      }
      result = ingestion.data;
    }
    // A failed SMS does not roll back a reading. The leased durable job remains
    // retryable on subsequent readings or the Pi's independent worker tick.
    deps.spawn(
      drainNotifications(deps).catch(() =>
        deps.log("error", "Notification worker failed; durable jobs retained")
      ),
    );
    return json(200, result);
  };
}
declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };
if (import.meta.main) {
  const { createClient } = await import(
    "https://esm.sh/@supabase/supabase-js@2.49.1"
  );
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const client = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    serviceRoleKey,
    { auth: { persistSession: false } },
  );
  Deno.serve(createHandler({
    client,
    serviceRoleKey: Deno.env.get("LPMAS_BACKEND_JWT") ?? serviceRoleKey,
    async readSettings() {
      const { data, error } = await client.from("system_settings").select(
        "key,value",
      ).in("key", ["sms_provider", "textbee_api_key", "manager_phone"]);
      if (error) throw error;
      return Object.fromEntries(
        (data ?? []).map((row) => [row.key, row.value]),
      );
    },
    fetchImpl: (url, init) => fetch(url, init),
    spawn: (task) => EdgeRuntime.waitUntil(task),
    log: (level, message) =>
      level === "error" ? console.error(message) : console.info(message),
  }));
}
