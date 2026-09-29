/**
 * LPMAS — `ingest-reading` Supabase Edge Function.
 *
 * Receives one 10-second sensor reading from the Raspberry Pi, records the
 * sensor as alive, folds the reading into the sensor's minute aggregate, and
 * fires a single SMS when a sustained breach is confirmed.
 *
 * Design notes that are load-bearing (see the task report):
 *
 *  - AGGREGATE WRITES ARE DELTAS, NOT RUNNING TOTALS.
 *    `public.upsert_minute_aggregate` merges additively (0011): counts are
 *    summed, min/max folded, avg recomputed as a sample-weighted mean. One
 *    call per reading with sample_count = 1 is therefore correct and
 *    stateless; a running total would double-count. This matters because an
 *    Edge Function instance is evicted at will, so nothing may be held in
 *    memory between readings.
 *
 *  - THE READING PATH NEVER NAMES A GREENHOUSE.
 *    `update_sensor_list` preserves the manager's assignment when
 *    p_greenhouse_id is null, and only the assignment path may set status.
 *    So the ingest call passes p_sensor_id / p_lux / p_reading and nothing
 *    else, and the greenhouse used for the aggregate is read back from the
 *    row the RPC returns.
 *
 *  - PostgREST requires the `p_` argument prefix on RPC calls. The design
 *    spec writes the bare names; those do not resolve.
 *
 *  - The Supabase client and the SMS transport are injected, never
 *    constructed inside the handler, so the whole surface is testable
 *    without a live project.
 */

// ===========================================================================
// Types
// ===========================================================================

export type PhaseType = "illumination" | "dark";
export type Classification = "safe" | "warning" | "violation";

export interface ReadingPayload {
  sensor_id: string;
  lux: number;
  recorded_at: string;
  phase_type: PhaseType;
  greenhouse_id?: string | null;
}

export interface SensorRow {
  sensor_id: string;
  status: string;
  greenhouse_id: string | null;
  lux: number;
  last_reading_at: string;
}

export interface AggregateRow {
  sensor_id: string;
  bucket_start: string;
  sample_count: number;
  avg_lux: number;
  min_lux: number;
  max_lux: number;
  safe_count: number;
  warning_count: number;
  violation_count: number;
  [key: string]: unknown;
}

/** PostgREST result envelope, as returned by supabase-js. */
export interface RpcResult<T> {
  data: T | null;
  error: { message: string } | null;
}

/**
 * The slice of supabase-js this function uses. Narrowing it to an interface
 * is what makes the handler testable against a stub, and it documents
 * exactly which client surface is load-bearing.
 */
export interface SupabaseLike {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult<unknown>>;
  from(table: string): {
    select(columns: string): {
      in(column: string, values: string[]): PromiseLike<RpcResult<unknown>>;
    };
  };
}

export interface HandlerDeps {
  client: SupabaseLike;
  serviceRoleKey: string;
  guard: SmsGuard;
  /** Starts a task that outlives the response. `ctx.waitUntil` in production. */
  spawn(task: Promise<unknown>): void;
  readSettings(): Promise<Record<string, string>>;
  fetchImpl(input: string, init: RequestInit): Promise<unknown>;
  log(level: "info" | "error", message: string): void;
}

// ===========================================================================
// Constants — thresholds are copied verbatim from pi-server/app.py
// ===========================================================================

/** app.py:21-27. */
export const ILLUMINATION_SAFE_MIN = 50;
export const ILLUMINATION_WARNING_MAX = 50;
export const ILLUMINATION_VIOLATION_MAX = 30;
export const DARK_SAFE_MAX = 15;
export const DARK_WARNING_MAX = 29;

/** app.py:30. A confirmed incident requires 3 consecutive violation readings. */
export const CONSECUTIVE_VIOLATIONS_REQUIRED = 3;

/**
 * How far back the durable dedupe check looks for a breach that was already
 * confirmed. Only consulted on the reading that would fire the SMS, so it
 * costs one query per confirmed breach and nothing otherwise.
 */
export const PRIOR_BREACH_LOOKBACK_MINUTES = 10;

const SEMAPHORE_ENDPOINT = "https://api.semaphore.co/api/v4/messages";

// ===========================================================================
// Pure helpers
// ===========================================================================

/**
 * Mirrors `classify_reading` in pi-server/app.py (lines 285-294) for the two
 * phases that reach the cloud.
 *
 * One deliberate difference: app.py also returns "safe" for an illumination
 * reading taken OUTSIDE the greenhouse's monitoring window, because the Pi
 * knows the window from its local greenhouses table. The Edge Function has no
 * such window data — the payload carries only `phase_type` — so it applies
 * the lux thresholds alone. The Pi remains the authority on the incident
 * state machine, and the Pi only forwards a `phase_type` of illumination or
 * dark, so the divergence is limited to readings the Pi would have called
 * safe purely on window timing. Flagged in the task report.
 */
export function classifyReading(lux: number, phase: PhaseType): Classification {
  if (phase === "dark") {
    if (lux <= DARK_SAFE_MAX) return "safe";
    if (lux <= DARK_WARNING_MAX) return "warning";
    return "violation";
  }
  if (lux <= ILLUMINATION_VIOLATION_MAX) return "violation";
  if (lux < ILLUMINATION_WARNING_MAX) return "warning";
  return "safe";
}

export type ValidationResult =
  | { ok: true; value: ReadingPayload }
  | { ok: false; error: string };

/**
 * Validates the request body. Pure and exported so the rules are testable
 * without constructing a Request.
 */
export function validateReadingPayload(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;

  const sensorId = raw.sensor_id;
  if (typeof sensorId !== "string" || sensorId.trim() === "") {
    return { ok: false, error: "sensor_id is required and must be a non-empty string" };
  }

  const lux = raw.lux;
  if (
    typeof lux !== "number" || !Number.isFinite(lux) || lux < 0
  ) {
    return {
      ok: false,
      error: "lux is required and must be a finite, non-negative number",
    };
  }

  const recordedAt = raw.recorded_at;
  if (typeof recordedAt !== "string" || Number.isNaN(Date.parse(recordedAt))) {
    return {
      ok: false,
      error: "recorded_at is required and must be an ISO-8601 timestamp",
    };
  }

  const phase = raw.phase_type;
  if (phase !== "illumination" && phase !== "dark") {
    return { ok: false, error: "phase_type must be 'illumination' or 'dark'" };
  }

  const greenhouseId = raw.greenhouse_id;
  if (
    greenhouseId !== undefined && greenhouseId !== null &&
    (typeof greenhouseId !== "string" || greenhouseId.trim() === "")
  ) {
    return { ok: false, error: "greenhouse_id must be a non-empty string when present" };
  }

  return {
    ok: true,
    value: {
      sensor_id: sensorId.trim(),
      lux,
      recorded_at: new Date(recordedAt).toISOString(),
      phase_type: phase,
      greenhouse_id: (greenhouseId ?? null) as string | null,
    },
  };
}

/** Truncates an ISO timestamp to the start of its UTC minute. */
export function floorToMinute(iso: string): string {
  const date = new Date(iso);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

/** The `n` minute buckets immediately before `bucketStart`, newest first. */
export function minuteLookbackWindow(bucketStart: string, n: number): string[] {
  const base = new Date(bucketStart).getTime();
  const out: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    out.push(new Date(base - i * 60_000).toISOString());
  }
  return out;
}

/**
 * The per-reading delta sent to `upsert_minute_aggregate`.
 *
 * Design (a): one reading in, one sample out. The database's additive merge
 * folds six 10-second calls into a correct rolling minute, so the function
 * stays stateless and cannot lose a partial minute to a cold start.
 */
export function buildAggregateDelta(
  reading: ReadingPayload,
  greenhouseId: string,
): Record<string, unknown> {
  const classification = classifyReading(reading.lux, reading.phase_type);
  return {
    p_sensor_id: reading.sensor_id,
    p_greenhouse_id: greenhouseId,
    p_bucket_start: floorToMinute(reading.recorded_at),
    p_phase_type: reading.phase_type,
    p_sample_count: 1,
    p_avg_lux: reading.lux,
    p_min_lux: reading.lux,
    p_max_lux: reading.lux,
    p_safe_count: classification === "safe" ? 1 : 0,
    p_warning_count: classification === "warning" ? 1 : 0,
    p_violation_count: classification === "violation" ? 1 : 0,
    p_updated_at: reading.recorded_at,
  };
}

/**
 * The service_role key check.
 *
 * Exact string comparison, no prefix matching: a valid user or anon JWT must
 * not be mistaken for the service key, and a key with a prefix of the real
 * one must not be accepted. An unconfigured key authenticates nobody.
 */
export function isAuthorized(request: Request, serviceRoleKey: string): boolean {
  if (!serviceRoleKey) return false;
  const header = request.headers.get("authorization");
  if (!header) return false;
  return header === `Bearer ${serviceRoleKey}`;
}

/** Per-sensor "SMS already sent for this breach" flag. */
export interface SmsGuard {
  isNotified(sensorId: string): boolean;
  markNotified(sensorId: string): void;
  clear(sensorId: string): void;
}

export function createSmsGuard(): SmsGuard {
  const notified = new Set<string>();
  return {
    isNotified: (sensorId) => notified.has(sensorId),
    markNotified: (sensorId) => {
      notified.add(sensorId);
    },
    clear: (sensorId) => {
      notified.delete(sensorId);
    },
  };
}

// ===========================================================================
// Database access
// ===========================================================================

function normalizeSensorRow(data: unknown): SensorRow | null {
  // PostgREST returns a function's composite return either as a single object
  // or, depending on version, as a one-row array. Accept both.
  //
  // A null greenhouse_id is a VALID row state, not a missing row: the manager
  // may simply not have mounted the sensor yet. Conflating the two would
  // report the wrong reason to the Pi, so the assignment check stays in the
  // handler.
  const row = (Array.isArray(data) ? data[0] : data) as SensorRow | null;
  if (!row || typeof row !== "object" || typeof row.sensor_id !== "string") return null;
  return row;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Durable half of the SMS dedupe.
 *
 * A cold start wipes the in-memory guard, so the in-memory flag alone would
 * let a sustained breach re-notify on the next minute's third reading. The
 * minute aggregate is durable, so this walks back through the sensor's recent
 * buckets and answers "was this same breach already confirmed?":
 *
 *   - a bucket with any safe or warning sample ends the breach, so an older
 *     confirmation no longer counts (mirrors resolve_incident() on a safe
 *     reading);
 *   - a bucket with >= 3 violations confirms the same ongoing breach;
 *   - a missing bucket is a data gap, which breaks the consecutive run just
 *     as a >15 s reading gap does on the Pi (app.py MAX_CONSECUTIVE_GAP_
 *     SECONDS), so the answer is no.
 *
 * Only called on the single reading that would send, so it costs one query
 * per confirmed breach.
 */
export async function hasPriorConfirmedBreach(
  client: SupabaseLike,
  sensorId: string,
  bucketStart: string,
  lookbackMinutes: number = PRIOR_BREACH_LOOKBACK_MINUTES,
): Promise<boolean> {
  const windows = minuteLookbackWindow(bucketStart, lookbackMinutes);
  const result = await client
    .from("sensor_minute_aggregates")
    .select("sensor_id,bucket_start,sample_count,safe_count,warning_count,violation_count")
    .in("bucket_start", windows);

  if (result.error) {
    throw new Error(result.error.message);
  }

  const byBucket = new Map<string, Record<string, unknown>>();
  for (const row of (result.data ?? []) as Record<string, unknown>[]) {
    if (typeof row.bucket_start === "string") {
      byBucket.set(new Date(row.bucket_start).toISOString(), row);
    }
  }

  for (const windowStart of windows) {
    const row = byBucket.get(windowStart);
    if (!row) return false; // gap: the consecutive run is broken
    if (asNumber(row.safe_count, 0) > 0 || asNumber(row.warning_count, 0) > 0) {
      return false; // breach resolved before this point
    }
    if (asNumber(row.violation_count, 0) >= CONSECUTIVE_VIOLATIONS_REQUIRED) {
      return true;
    }
  }
  return false;
}

// ===========================================================================
// SMS
// ===========================================================================

export function buildViolationMessage(
  sensorId: string,
  greenhouseId: string,
  phase: PhaseType,
  lux: number,
): string {
  const when = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });
  return `ALERT: ${phase} phase light violation - Sensor ${sensorId} at ${greenhouseId}: ${lux} lux at ${when}`;
}

export interface SmsConfig {
  apiKey: string;
  senderName: string;
  managerPhone: string;
}

/**
 * Resolves the SMS settings, or returns null when SMS is not configured or
 * the lookup failed. Never throws.
 */
async function resolveSmsConfig(deps: HandlerDeps): Promise<SmsConfig | null> {
  try {
    const settings = await deps.readSettings();
    const apiKey = (settings.semaphore_api_key ?? "").trim();
    const senderName = (settings.semaphore_sender_name ?? "").trim();
    const managerPhone = (settings.manager_phone ?? "").trim();
    if (!apiKey || !senderName || !managerPhone) return null;
    return { apiKey, senderName, managerPhone };
  } catch (error) {
    deps.log("error", `SMS settings lookup failed: ${describe(error)}`);
    return null;
  }
}

/**
 * Sends the violation SMS. Never throws: every failure is logged and
 * swallowed so a broken provider can neither fail a reading nor take down
 * the instance.
 */
async function sendViolationSms(
  reading: ReadingPayload,
  greenhouseId: string,
  config: SmsConfig,
  deps: HandlerDeps,
): Promise<void> {
  try {
    await deps.fetchImpl(SEMAPHORE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apikey: config.apiKey,
        number: config.managerPhone,
        sendername: config.senderName,
        message: buildViolationMessage(
          reading.sensor_id,
          greenhouseId,
          reading.phase_type,
          reading.lux,
        ),
      }),
    });
    deps.log("info", `SMS sent for sensor=${reading.sensor_id} greenhouse=${greenhouseId}`);
  } catch (error) {
    // Logged with the reason so a failed notification can be retried out of
    // band; the reading itself is already committed at this point.
    deps.log("error", `SMS failed for sensor=${reading.sensor_id}: ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ===========================================================================
// Handler
// ===========================================================================

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Builds the request handler. Everything it touches is a parameter, so the
 * tests drive it with a stub client and a stub transport.
 */
export function createHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  return async function handle(request: Request): Promise<Response> {
    // 1. Authenticate before doing any work. The key is never logged.
    if (!isAuthorized(request, deps.serviceRoleKey)) {
      return json(401, { ok: false, error: "Unauthorized: a valid service_role key is required" });
    }

    if (request.method !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    // 2. Parse and validate.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { ok: false, error: "Request body must be valid JSON" });
    }

    const validation = validateReadingPayload(body);
    if (!validation.ok) {
      return json(400, { ok: false, error: validation.error });
    }
    const reading = validation.value;
    const classification = classifyReading(reading.lux, reading.phase_type);
    const bucketStart = floorToMinute(reading.recorded_at);

    // 3. Record the reading. This is what makes the sensor online, and it is
    //    also the only authority on the greenhouse assignment.
    //
    //    No p_greenhouse_id: on the reading path the RPC preserves whatever a
    //    manager assigned. Any value sent here would overwrite it, and a
    //    spoofed value from the payload would put the reading in the wrong
    //    greenhouse's history.
    const sensorResult = await deps.client.rpc("update_sensor_list", {
      p_sensor_id: reading.sensor_id,
      p_lux: reading.lux,
      p_reading: true,
    });
    if (sensorResult.error) {
      deps.log("error", `update_sensor_list failed for sensor=${reading.sensor_id}: ${sensorResult.error.message}`);
      return json(500, {
        ok: false,
        error: `update_sensor_list failed: ${sensorResult.error.message}`,
      });
    }

    const sensorRow = normalizeSensorRow(sensorResult.data);
    const sensorStatus = sensorRow?.status ?? "online";

    // 4. A safe reading resolves the incident, so the next breach is a new
    //    one and may notify again.
    if (classification === "safe") {
      deps.guard.clear(reading.sensor_id);
    }

    // 5. Aggregate only what sensor_list authorises. This mirrors the guard
    //    inside upsert_minute_aggregate rather than relying on the RPC to
    //    raise: an unassigned sensor is a normal, expected state, not an
    //    error, and the response should say so.
    const base = { ok: true as const, sensor_id: reading.sensor_id, sensor_status: sensorStatus };
    if (!sensorRow) {
      return json(200, { ...base, aggregate_updated: false, reason: "sensor_unregistered" });
    }
    if (sensorRow.status !== "online") {
      return json(200, { ...base, aggregate_updated: false, reason: "sensor_offline" });
    }
    const greenhouseId = typeof sensorRow.greenhouse_id === "string" && sensorRow.greenhouse_id !== ""
      ? sensorRow.greenhouse_id
      : null;
    if (!greenhouseId) {
      return json(200, { ...base, aggregate_updated: false, reason: "sensor_not_assigned" });
    }

    // 6. Fold this reading into the minute with a per-reading delta.
    const aggregateResult = await deps.client.rpc(
      "upsert_minute_aggregate",
      buildAggregateDelta(reading, greenhouseId),
    );
    if (aggregateResult.error) {
      deps.log("error", `upsert_minute_aggregate failed for sensor=${reading.sensor_id}: ${aggregateResult.error.message}`);
      return json(500, {
        ok: false,
        error: `upsert_minute_aggregate failed: ${aggregateResult.error.message}`,
      });
    }

    const aggregate = (aggregateResult.data ?? null) as AggregateRow | null;

    // 7. SMS on a confirmed breach only: the merged bucket's violation_count
    //    reaching 3 is the aggregate-level form of the Pi's "3 consecutive
    //    violation readings" rule. Counts below 3 are a breach forming, not a
    //    confirmed one.
    let smsTriggered = false;
    const violationCount = asNumber(aggregate?.violation_count, 0);
    if (violationCount >= CONSECUTIVE_VIOLATIONS_REQUIRED) {
      let alreadyNotified = deps.guard.isNotified(reading.sensor_id);
      if (!alreadyNotified) {
        try {
          alreadyNotified = await hasPriorConfirmedBreach(
            deps.client,
            reading.sensor_id,
            bucketStart,
          );
        } catch (error) {
          // Fails open: a real confirmed breach must still be alerted on
          // rather than silently dropped. The worst case is one duplicate SMS
          // to the manager.
          deps.log("error", `breach history lookup failed for sensor=${reading.sensor_id}: ${describe(error)}`);
          alreadyNotified = false;
        }
      }
      if (!alreadyNotified) {
        // Settings are resolved BEFORE the flag is set, so an unconfigured or
        // unreachable SMS provider is reported as "not sent" and the next
        // reading can still try, rather than silently burning the one
        // notification the breach is allowed.
        const config = await resolveSmsConfig(deps);
        if (config) {
          deps.guard.markNotified(reading.sensor_id);
          smsTriggered = true;
          // Fire-and-forget. `sendViolationSms` cannot throw, and the catch is
          // attached here as well so no rejection can reach the runtime as an
          // unhandled promise.
          deps.spawn(
            sendViolationSms(reading, greenhouseId, config, deps).catch((error) => {
              deps.log("error", `unhandled SMS error for sensor=${reading.sensor_id}: ${describe(error)}`);
            }),
          );
        } else {
          deps.log("info", `SMS not configured; skipped for sensor=${reading.sensor_id}`);
        }
      }
    }

    return json(200, {
      ...base,
      aggregate_updated: true,
      classification,
      bucket_start: bucketStart,
      greenhouse_id: greenhouseId,
      sms_triggered: smsTriggered,
    });
  };
}

// ===========================================================================
// Production wiring
// ===========================================================================

/**
 * `EdgeRuntime` is a global provided by the Supabase Edge Runtime, not by
 * Deno, so it is declared here rather than pulled from a lib. It only exists
 * inside `import.meta.main`, which the tests never enter.
 */
declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };

async function readSmsSettings(client: SupabaseLike): Promise<Record<string, string>> {
  const result = await client
    .from("system_settings")
    .select("key,value")
    .in("key", ["semaphore_api_key", "semaphore_sender_name", "manager_phone"]);
  if (result.error) throw new Error(result.error.message);
  const settings: Record<string, string> = {};
  for (const row of (result.data ?? []) as Array<Record<string, unknown>>) {
    if (typeof row.key === "string" && typeof row.value === "string") {
      settings[row.key] = row.value;
    }
  }
  return settings;
}

/**
 * Production entry point. Everything is wired here, at the boundary, and the
 * handler itself stays free of `createClient`, `Deno.env` and `fetch` — which
 * is what lets the tests replace all three.
 *
 * Only reached under `import.meta.main`, so importing this file in a test
 * constructs no client and reads no environment.
 */
if (import.meta.main) {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.49.1");
  const { serve } = await import("https://deno.land/std@0.224.0/http/server.ts");

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceRoleKey) {
    console.error("[ingest-reading] SUPABASE_SERVICE_ROLE_KEY is not set; every request will be rejected");
  }

  const client = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    serviceRoleKey,
    { auth: { persistSession: false, autoRefreshToken: false } },
  ) as unknown as SupabaseLike;

  const guard = createSmsGuard();

  const handler = createHandler({
    client,
    serviceRoleKey,
    guard,
    // Keeps the SMS task alive past the response. The isolate is torn down
    // when the response is returned, so anything not registered here dies.
    spawn: (task) => {
      EdgeRuntime.waitUntil(task);
    },
    readSettings: () => readSmsSettings(client),
    fetchImpl: (input, init) => fetch(input, init),
    log: (level, message) => {
      if (level === "error") console.error(`[ingest-reading] ${message}`);
      else console.log(`[ingest-reading] ${message}`);
    },
  });

  serve(handler);
}
