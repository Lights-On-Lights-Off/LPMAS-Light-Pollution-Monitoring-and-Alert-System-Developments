/**
 * Tests for the ingest-reading Edge Function.
 *
 * Nothing here touches a live Supabase project. The handler takes its
 * Supabase client and its SMS transport as injected dependencies, and the
 * payload validation / classification / aggregate-delta arithmetic are pure
 * exported functions, so the whole surface is testable offline.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  CONSECUTIVE_VIOLATIONS_REQUIRED,
  buildAggregateDelta,
  classifyReading,
  createHandler,
  createSmsGuard,
  floorToMinute,
  hasPriorConfirmedBreach,
  isAuthorized,
  minuteLookbackWindow,
  validateReadingPayload,
  type PhaseType,
  type SensorRow,
  type SupabaseLike,
} from "./index.ts";

const SERVICE_KEY = "test-service-role-key";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface RpcCall {
  kind: "rpc";
  name: string;
  args: Record<string, unknown>;
}

interface SelectCall {
  kind: "select";
  table: string;
  columns: string;
  column: string;
  values: string[];
}

type Call = RpcCall | SelectCall;

interface StubOptions {
  sensorRow?: Partial<SensorRow> | null;
  aggregateRow?: Record<string, unknown> | null;
  sensorError?: { message: string } | null;
  aggregateError?: { message: string } | null;
  priorRows?: Record<string, unknown>[];
}

function stubClient(options: StubOptions = {}) {
  const calls: Call[] = [];
  const sensorRow: SensorRow = {
    sensor_id: "ESP32-001",
    status: "online",
    greenhouse_id: "gh-001",
    lux: 12,
    last_reading_at: "2026-09-29T10:30:00.000Z",
    ...(options.sensorRow ?? {}),
  };

  const client: SupabaseLike = {
    rpc(name, args) {
      calls.push({ kind: "rpc", name, args });
      if (name === "update_sensor_list") {
        return Promise.resolve({
          data: options.sensorError ? null : sensorRow,
          error: options.sensorError ?? null,
        });
      }
      if (name === "upsert_minute_aggregate") {
        return Promise.resolve({
          data: options.aggregateError
            ? null
            : (options.aggregateRow ?? {}),
          error: options.aggregateError ?? null,
        });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
    },
    from(table) {
      return {
        select(columns) {
          return {
            in(column, values) {
              calls.push({ kind: "select", table, columns, column, values });
              return Promise.resolve({ data: options.priorRows ?? [], error: null });
            },
          };
        },
      };
    },
  };

  return { client, calls, sensorRow };
}

function recordingSpawner() {
  const tasks: Promise<unknown>[] = [];
  return {
    tasks,
    spawn(task: Promise<unknown>) {
      tasks.push(task);
    },
    async settle() {
      // A rejected background task must never surface here: the handler is
      // responsible for attaching a catch. Draining with allSettled makes that
      // a test failure instead of an unhandled rejection.
      await Promise.allSettled(tasks);
      return tasks;
    },
  };
}

const silentLog = () => {};

interface HandlerOverrides {
  client?: SupabaseLike;
  /** Pass a whole stub to keep access to its call log. */
  stub?: ReturnType<typeof stubClient>;
  authHeader?: string | null;
  body?: unknown;
  rawBody?: string;
  spawner?: ReturnType<typeof recordingSpawner>;
  guard?: ReturnType<typeof createSmsGuard>;
  fetchImpl?: (input: string, init: RequestInit) => Promise<unknown>;
  settings?: Record<string, string>;
  readSettings?: () => Promise<Record<string, string>>;
  log?: (level: string, message: string) => void;
}

function buildHandler(overrides: HandlerOverrides = {}) {
  const stub = overrides.stub ?? stubClient();
  const client = overrides.client ?? stub.client;
  const spawner = overrides.spawner ?? recordingSpawner();
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = overrides.fetchImpl ?? (async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    return { ok: true, status: 200 };
  });
  const logs: string[] = [];

  const handler = createHandler({
    client,
    serviceRoleKey: SERVICE_KEY,
    guard: overrides.guard ?? createSmsGuard(),
    spawn: spawner.spawn,
    readSettings: overrides.readSettings ?? (() =>
      Promise.resolve(
        overrides.settings ?? {
          semaphore_api_key: "semi-key",
          semaphore_sender_name: "LPMAS",
          manager_phone: "+639171234567",
        },
      )),
    fetchImpl,
    log: overrides.log ?? ((level, message) => logs.push(`${level}: ${message}`)),
  });

  const rawBody = overrides.rawBody ?? JSON.stringify(
    overrides.body ?? {
      sensor_id: "ESP32-001",
      lux: 12,
      recorded_at: "2026-09-29T10:30:00.000Z",
      phase_type: "illumination",
    },
  );

  const headers = new Headers({ "Content-Type": "application/json" });
  if (overrides.authHeader !== null) {
    headers.set("Authorization", overrides.authHeader ?? `Bearer ${SERVICE_KEY}`);
  }
  const request = new Request("http://localhost/functions/v1/ingest-reading", {
    method: "POST",
    headers,
    body: rawBody,
  });

  return { handler, request, calls: stub.calls, spawner, fetchCalls, logs };
}

function rpcArgs(calls: Call[], name: string): Record<string, unknown> | undefined {
  const call = calls.find((c): c is RpcCall => c.kind === "rpc" && c.name === name);
  return call?.args;
}

// ---------------------------------------------------------------------------
// Spec-required validation cases
// ---------------------------------------------------------------------------

Deno.test("missing sensor_id is rejected with 400", async () => {
  const { handler, request, calls } = buildHandler({
    body: { lux: 12, recorded_at: "2026-09-29T10:30:00.000Z", phase_type: "illumination" },
  });
  const response = await handler(request);
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.ok, false);
  assert(String(body.error).includes("sensor_id"));
  assertEquals(calls.length, 0, "no RPC may run before validation succeeds");
});

Deno.test("missing lux is rejected with 400", async () => {
  const { handler, request, calls } = buildHandler({
    body: { sensor_id: "ESP32-001", recorded_at: "2026-09-29T10:30:00.000Z", phase_type: "illumination" },
  });
  const response = await handler(request);
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.ok, false);
  assert(String(body.error).includes("lux"));
  assertEquals(calls.length, 0);
});

Deno.test("invalid phase_type is rejected with 400", async () => {
  for (const phase of ["night", "unconfigured", "", "ILLUMINATION", 7, null]) {
    const { handler, request, calls } = buildHandler({
      body: { sensor_id: "ESP32-001", lux: 12, recorded_at: "2026-09-29T10:30:00.000Z", phase_type: phase },
    });
    const response = await handler(request);
    assertEquals(response.status, 400, `phase_type ${JSON.stringify(phase)} must be rejected`);
    const body = await response.json();
    assert(String(body.error).includes("phase_type"));
    assertEquals(calls.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

Deno.test("validateReadingPayload accepts the spec payload", () => {
  const result = validateReadingPayload({
    sensor_id: "ESP32-001",
    lux: 45.2,
    recorded_at: "2026-09-29T10:30:00.000Z",
    phase_type: "illumination",
    greenhouse_id: "gh-001",
  });
  assert(result.ok);
  assertEquals(result.value.sensor_id, "ESP32-001");
  assertEquals(result.value.lux, 45.2);
  assertEquals(result.value.recorded_at, "2026-09-29T10:30:00.000Z");
  assertEquals(result.value.phase_type, "illumination");
});

Deno.test("validateReadingPayload rejects missing or malformed recorded_at", () => {
  for (const recorded_at of [undefined, null, "", "not-a-date", 12345]) {
    const result = validateReadingPayload({
      sensor_id: "ESP32-001",
      lux: 1,
      recorded_at,
      phase_type: "dark",
    });
    assert(!result.ok, `recorded_at ${JSON.stringify(recorded_at)} must be rejected`);
    assert(String((result as { error: string }).error).includes("recorded_at"));
  }
});

Deno.test("validateReadingPayload rejects non-numeric and negative lux", () => {
  for (const lux of [undefined, null, "abc", NaN, Infinity, -1]) {
    const result = validateReadingPayload({
      sensor_id: "ESP32-001",
      lux,
      recorded_at: "2026-09-29T10:30:00.000Z",
      phase_type: "dark",
    });
    assert(!result.ok, `lux ${JSON.stringify(lux)} must be rejected`);
  }
});

Deno.test("validateReadingPayload rejects a blank sensor_id", () => {
  for (const sensor_id of ["", "   ", null, 42]) {
    const result = validateReadingPayload({
      sensor_id,
      lux: 1,
      recorded_at: "2026-09-29T10:30:00.000Z",
      phase_type: "dark",
    });
    assert(!result.ok);
    assert(String((result as { error: string }).error).includes("sensor_id"));
  }
});

Deno.test("malformed JSON body is rejected with 400", async () => {
  const { handler, request } = buildHandler({ rawBody: "{not json" });
  const response = await handler(request);
  assertEquals(response.status, 400);
  assertEquals((await response.json()).ok, false);
});

Deno.test("a non-POST request is rejected with 405", async () => {
  const { handler, request } = buildHandler();
  const getRequest = new Request("http://localhost/functions/v1/ingest-reading", {
    method: "GET",
    headers: request.headers,
  });
  const response = await handler(getRequest);
  assertEquals(response.status, 405);
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

Deno.test("isAuthorized requires an exact service_role bearer match", () => {
  const ok = new Request("http://x", { headers: { Authorization: `Bearer ${SERVICE_KEY}` } });
  assert(isAuthorized(ok, SERVICE_KEY));
  assert(!isAuthorized(new Request("http://x"), SERVICE_KEY));
  assert(!isAuthorized(new Request("http://x", { headers: { Authorization: "Bearer nope" } }), SERVICE_KEY));
  assert(
    !isAuthorized(
      new Request("http://x", { headers: { Authorization: `bearer ${SERVICE_KEY}` } }),
      SERVICE_KEY,
    ),
    "the scheme is case-sensitive, matching the spec's 'Bearer' form",
  );
  assert(
    !isAuthorized(
      new Request("http://x", {
        headers: { Authorization: `Bearer ${SERVICE_KEY}x` },
      }),
      SERVICE_KEY,
    ),
  );
  assert(!isAuthorized(ok, ""));
});

Deno.test("a request without a service_role key is rejected with 401 before any work", async () => {
  const { handler, request, calls, fetchCalls } = buildHandler({ authHeader: null });
  const response = await handler(request);
  assertEquals(response.status, 401);
  assertEquals((await response.json()).ok, false);
  assertEquals(calls.length, 0);
  assertEquals(fetchCalls.length, 0);
});

Deno.test("a request with the wrong bearer token is rejected with 401", async () => {
  const { handler, request, calls } = buildHandler({ authHeader: "Bearer wrong-key" });
  const response = await handler(request);
  assertEquals(response.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("an unconfigured service role key rejects everything rather than allowing all", async () => {
  const { handler, request, calls } = buildHandler();
  const broken = createHandler({
    client: stubClient().client,
    serviceRoleKey: "",
    guard: createSmsGuard(),
    spawn: () => {},
    readSettings: () => Promise.resolve({}),
    fetchImpl: async () => ({}),
    log: silentLog,
  });
  assertEquals((await broken(request)).status, 401);
  assertEquals((await handler(request)).status, 200, "control: the real key still works");
  assert(calls.length > 0);
});

// ---------------------------------------------------------------------------
// Classification thresholds (pi-server/app.py lines 21-27, 285-294)
// ---------------------------------------------------------------------------

Deno.test("illumination classification matches app.py: >=50 safe, 31-49 warning, <=30 violation", () => {
  assertEquals(classifyReading(50, "illumination"), "safe");
  assertEquals(classifyReading(50.1, "illumination"), "safe");
  assertEquals(classifyReading(1000, "illumination"), "safe");
  assertEquals(classifyReading(49.999, "illumination"), "warning");
  assertEquals(classifyReading(31, "illumination"), "warning");
  assertEquals(classifyReading(30, "illumination"), "violation");
  assertEquals(classifyReading(0, "illumination"), "violation");
});

Deno.test("dark classification matches app.py: 0-15 safe, 16-29 warning, >=30 violation", () => {
  assertEquals(classifyReading(0, "dark"), "safe");
  assertEquals(classifyReading(15, "dark"), "safe");
  assertEquals(classifyReading(15.5, "dark"), "warning");
  assertEquals(classifyReading(16, "dark"), "warning");
  assertEquals(classifyReading(29, "dark"), "warning");
  assertEquals(classifyReading(30, "dark"), "violation");
  assertEquals(classifyReading(900, "dark"), "violation");
});

// ---------------------------------------------------------------------------
// Minute bucketing
// ---------------------------------------------------------------------------

Deno.test("floorToMinute truncates to the UTC minute", () => {
  assertEquals(floorToMinute("2026-09-29T10:30:00.000Z"), "2026-09-29T10:30:00.000Z");
  assertEquals(floorToMinute("2026-09-29T10:30:59.999Z"), "2026-09-29T10:30:00.000Z");
  assertEquals(floorToMinute("2026-09-29T23:59:59.999Z"), "2026-09-29T23:59:00.000Z");
  assertEquals(floorToMinute("2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z");
});

Deno.test("minuteLookbackWindow yields the prior buckets only, newest excluded", () => {
  assertEquals(minuteLookbackWindow("2026-09-29T10:30:00.000Z", 3), [
    "2026-09-29T10:29:00.000Z",
    "2026-09-29T10:28:00.000Z",
    "2026-09-29T10:27:00.000Z",
  ]);
});

// ---------------------------------------------------------------------------
// Aggregate delta arithmetic
// ---------------------------------------------------------------------------

Deno.test("a violation reading sends a per-reading delta, never a running total", () => {
  // 30 lux in the dark phase is the first violation value (DARK_VIOLATION_MIN).
  const args = buildAggregateDelta(
    { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:12.000Z", phase_type: "dark" },
    "gh-001",
  );
  assertEquals(args, {
    p_sensor_id: "ESP32-001",
    p_greenhouse_id: "gh-001",
    p_bucket_start: "2026-09-29T10:30:00.000Z",
    p_phase_type: "dark",
    p_sample_count: 1,
    p_avg_lux: 30,
    p_min_lux: 30,
    p_max_lux: 30,
    p_safe_count: 0,
    p_warning_count: 0,
    p_violation_count: 1,
    p_updated_at: "2026-09-29T10:30:12.000Z",
  });
});

Deno.test("safe and warning readings set exactly one classification count", () => {
  const safe = buildAggregateDelta(
    { sensor_id: "ESP32-001", lux: 5, recorded_at: "2026-09-29T10:30:02.000Z", phase_type: "dark" },
    "gh-001",
  );
  assertEquals([safe.p_safe_count, safe.p_warning_count, safe.p_violation_count], [1, 0, 0]);

  const warning = buildAggregateDelta(
    { sensor_id: "ESP32-001", lux: 20, recorded_at: "2026-09-29T10:30:04.000Z", phase_type: "dark" },
    "gh-001",
  );
  assertEquals([warning.p_safe_count, warning.p_warning_count, warning.p_violation_count], [0, 1, 0]);
});

Deno.test("every aggregate RPC argument uses the p_ prefix PostgREST requires", () => {
  const args = buildAggregateDelta(
    { sensor_id: "ESP32-001", lux: 5, recorded_at: "2026-09-29T10:30:02.000Z", phase_type: "dark" },
    "gh-001",
  );
  for (const key of Object.keys(args)) {
    assert(key.startsWith("p_"), `argument ${key} is missing the p_ prefix`);
  }
});

// ---------------------------------------------------------------------------
// Happy path / RPC call sequence
// ---------------------------------------------------------------------------

Deno.test("an assigned online reading updates the sensor list then upserts the minute", async () => {
  const { handler, request, calls } = buildHandler({
    body: {
      sensor_id: "ESP32-001",
      lux: 45.2,
      recorded_at: "2026-09-29T10:30:00.000Z",
      phase_type: "illumination",
      greenhouse_id: "gh-001",
    },
  });
  const response = await handler(request);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, {
    ok: true,
    sensor_id: "ESP32-001",
    aggregate_updated: true,
    sensor_status: "online",
    classification: "warning",
    bucket_start: "2026-09-29T10:30:00.000Z",
    greenhouse_id: "gh-001",
    sms_triggered: false,
  });

  assertEquals(calls.length, 2);
  assertEquals((calls[0] as RpcCall).name, "update_sensor_list");
  assertEquals((calls[1] as RpcCall).name, "upsert_minute_aggregate");

  // The reading path must never name a greenhouse: passing one would overwrite
  // a manager's assignment, and passing null is safe only because the RPC
  // preserves the existing value.
  assertEquals(rpcArgs(calls, "update_sensor_list"), {
    p_sensor_id: "ESP32-001",
    p_lux: 45.2,
    p_reading: true,
  });

  const aggregateArgs = rpcArgs(calls, "upsert_minute_aggregate")!;
  assertEquals(aggregateArgs.p_greenhouse_id, "gh-001");
  assertEquals(aggregateArgs.p_sample_count, 1);
  assertEquals(aggregateArgs.p_warning_count, 1);
  assertEquals(aggregateArgs.p_bucket_start, "2026-09-29T10:30:00.000Z");
});

Deno.test("the greenhouse used for the aggregate comes from sensor_list, not the payload", async () => {
  const { handler, request, calls } = buildHandler({
    stub: stubClient({ sensorRow: { greenhouse_id: "gh-002" } }),
    body: {
      sensor_id: "ESP32-001",
      lux: 5,
      recorded_at: "2026-09-29T10:30:00.000Z",
      phase_type: "dark",
      greenhouse_id: "gh-999",
    },
  });
  await handler(request);
  assertEquals(rpcArgs(calls, "update_sensor_list")!.p_greenhouse_id, undefined);
  assertEquals(
    rpcArgs(calls, "upsert_minute_aggregate")!.p_greenhouse_id,
    "gh-002",
  );
});

Deno.test("a PostgREST array result from the RPC is unwrapped", async () => {
  // Some PostgREST versions return a composite-returning function's result as
  // a one-row array rather than an object. The wrapper below keeps the call
  // log in one place so the assertions still see it.
  const inner = stubClient();
  const calls: Call[] = [];
  const arrayReturning: SupabaseLike = {
    from: (table) => inner.client.from(table),
    rpc(name, args) {
      calls.push({ kind: "rpc", name, args });
      if (name === "update_sensor_list") {
        return Promise.resolve({ data: [inner.sensorRow], error: null });
      }
      return inner.client.rpc(name, args);
    },
  };
  const { handler, request } = buildHandler({ client: arrayReturning });
  const response = await handler(request);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).aggregate_updated, true);
  assertEquals(rpcArgs(calls, "upsert_minute_aggregate")!.p_greenhouse_id, "gh-001");
});

// ---------------------------------------------------------------------------
// Unassigned sensors
// ---------------------------------------------------------------------------

Deno.test("an unassigned sensor still updates the sensor list but writes no aggregate", async () => {
  const { handler, request, calls } = buildHandler({
    stub: stubClient({ sensorRow: { greenhouse_id: null } }),
  });
  const response = await handler(request);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.aggregate_updated, false);
  assertEquals(body.reason, "sensor_not_assigned");
  assertEquals(body.sensor_status, "online");
  assertEquals(rpcArgs(calls, "update_sensor_list")!.p_sensor_id, "ESP32-001");
  assertEquals(
    calls.filter((c) => c.kind === "rpc" && c.name === "upsert_minute_aggregate").length,
    0,
  );
});

Deno.test("an offline sensor result suppresses the aggregate with its own reason", async () => {
  const { handler, request, calls } = buildHandler({
    stub: stubClient({ sensorRow: { status: "offline", greenhouse_id: "gh-001" } }),
  });
  const response = await handler(request);
  const body = await response.json();
  assertEquals(body.aggregate_updated, false);
  assertEquals(body.reason, "sensor_offline");
  assertEquals(
    calls.filter((c) => c.kind === "rpc" && c.name === "upsert_minute_aggregate").length,
    0,
  );
});

// ---------------------------------------------------------------------------
// RPC failures
// ---------------------------------------------------------------------------

Deno.test("an update_sensor_list failure returns 500 and writes no aggregate", async () => {
  const { handler, request, calls, spawner } = buildHandler({
    stub: stubClient({ sensorError: { message: "boom" } }),
  });
  const response = await handler(request);
  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body.ok, false);
  assert(String(body.error).includes("boom"));
  assertEquals(
    calls.filter((c) => c.kind === "rpc" && c.name === "upsert_minute_aggregate").length,
    0,
  );
  assertEquals((await spawner.settle()).length, 0);
});

Deno.test("an aggregate failure returns 500 without sending an SMS", async () => {
  const { handler, request, spawner, fetchCalls } = buildHandler({
    stub: stubClient({
      aggregateError: { message: "Sensor ESP32-001 is not assigned" },
      aggregateRow: { violation_count: 5 },
    }),
  });
  const response = await handler(request);
  assertEquals(response.status, 500);
  assertEquals((await response.json()).ok, false);
  await spawner.settle();
  assertEquals(fetchCalls.length, 0);
});

// ---------------------------------------------------------------------------
// SMS triggering: violation_count >= 3, once per sustained breach
// ---------------------------------------------------------------------------

function violationAggregate(count: number) {
  return {
    sensor_id: "ESP32-001",
    bucket_start: "2026-09-29T10:30:00.000Z",
    sample_count: count,
    violation_count: count,
    safe_count: 0,
    warning_count: 0,
    avg_lux: 10,
    min_lux: 10,
    max_lux: 10,
  };
}

Deno.test("no SMS below the 3-reading confirmation threshold", async () => {
  for (const count of [1, 2]) {
    const { handler, request, spawner, fetchCalls } = buildHandler({
      stub: stubClient({ aggregateRow: violationAggregate(count) }),
      body: { sensor_id: "ESP32-001", lux: 10, recorded_at: "2026-09-29T10:30:00.000Z", phase_type: "dark" },
    });
    const response = await handler(request);
    assertEquals(response.status, 200);
    assertEquals((await response.json()).sms_triggered, false);
    await spawner.settle();
    assertEquals(fetchCalls.length, 0, `violation_count ${count} must not notify`);
  }
});

Deno.test("an SMS is fired when the merged violation_count reaches 3", async () => {
  const { handler, request, spawner, fetchCalls } = buildHandler({
    stub: stubClient({ aggregateRow: violationAggregate(3) }),
    body: { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
  });
  const response = await handler(request);
  const body = await response.json();
  assertEquals(body.sms_triggered, true);
  await spawner.settle();

  assertEquals(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assertEquals(call.url, "https://api.semaphore.co/api/v4/messages");
  const sent = JSON.parse(String(call.init.body));
  assertEquals(sent.apikey, "semi-key");
  assertEquals(sent.number, "+639171234567");
  assertEquals(sent.sendername, "LPMAS");
  assert(sent.message.includes("ESP32-001"));
  assert(sent.message.includes("30 lux"));
  assertEquals(call.init.method, "POST");
});

Deno.test("the SMS is not repeated while the same breach continues", async () => {
  // One shared guard across four readings of a single sustained breach: the
  // bucket's merged violation_count climbs 3 -> 4 -> 5 -> 6, and exactly one
  // notification is sent.
  const guard = createSmsGuard();
  const sentPerReading: number[] = [];
  for (const count of [3, 4, 5, 6]) {
    const { handler, request, spawner, fetchCalls } = buildHandler({
      guard,
      stub: stubClient({ aggregateRow: violationAggregate(count) }),
      body: { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
    });
    await handler(request);
    await spawner.settle();
    sentPerReading.push(fetchCalls.length);
  }
  assertEquals(sentPerReading, [1, 0, 0, 0], "one SMS for the whole sustained breach");
});

Deno.test("a safe reading resets the guard so the next breach notifies again", async () => {
  const guard = createSmsGuard();
  const safe = { sensor_id: "ESP32-001", lux: 5, recorded_at: "2026-09-29T10:31:00.000Z", phase_type: "dark" };

  const first = buildHandler({
    guard,
    stub: stubClient({ aggregateRow: violationAggregate(3) }),
    body: { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
  });
  await first.handler(first.request);
  await first.spawner.settle();
  assertEquals(first.fetchCalls.length, 1);

  const resolution = buildHandler({
    guard,
    stub: stubClient({
      aggregateRow: { ...violationAggregate(0), sample_count: 1, safe_count: 1, violation_count: 0 },
    }),
    body: safe,
  });
  const resolveResponse = await resolution.handler(resolution.request);
  assertEquals((await resolveResponse.json()).classification, "safe");
  await resolution.spawner.settle();
  assertEquals(resolution.fetchCalls.length, 0);

  const second = buildHandler({
    guard,
    stub: stubClient({ aggregateRow: violationAggregate(3) }),
    body: { sensor_id: "ESP32-001", lux: 10, recorded_at: "2026-09-29T10:40:20.000Z", phase_type: "dark" },
  });
  await second.handler(second.request);
  await second.spawner.settle();
  assertEquals(second.fetchCalls.length, 1, "a new breach is a new notification");
});

Deno.test("the guard is per sensor", async () => {
  const guard = createSmsGuard();
  const a = buildHandler({
    guard,
    stub: stubClient({ aggregateRow: violationAggregate(3) }),
    body: { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
  });
  await a.handler(a.request);
  await a.spawner.settle();

  const b = buildHandler({
    guard,
    stub: stubClient({
      sensorRow: { sensor_id: "ESP32-002" },
      aggregateRow: { ...violationAggregate(3), sensor_id: "ESP32-002" },
    }),
    body: { sensor_id: "ESP32-002", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
  });
  const response = await b.handler(b.request);
  assertEquals((await response.json()).sms_triggered, true);
  await b.spawner.settle();
  assertEquals(b.fetchCalls.length, 1, "ESP32-002 has not been notified yet");
});

// ---------------------------------------------------------------------------
// Durable (cold-start) dedupe
// ---------------------------------------------------------------------------

function bucket(offsetMinutes: number, counts: { safe?: number; warning?: number; violation?: number }) {
  const violation = counts.violation ?? 0;
  const base = Date.parse("2026-09-29T10:30:00.000Z");
  return {
    sensor_id: "ESP32-001",
    bucket_start: new Date(base - offsetMinutes * 60_000).toISOString(),
    sample_count: (counts.safe ?? 0) + (counts.warning ?? 0) + violation,
    safe_count: counts.safe ?? 0,
    warning_count: counts.warning ?? 0,
    violation_count: violation,
  };
}

Deno.test("hasPriorConfirmedBreach sees a sustained breach confirmed in the previous minute", async () => {
  const { client } = stubClient({
    priorRows: [bucket(1, { violation: 5 }), bucket(2, { violation: 4 }), bucket(3, { violation: 3 })],
  });
  assertEquals(await hasPriorConfirmedBreach(client, "ESP32-001", "2026-09-29T10:30:00.000Z", 10), true);
});

Deno.test("hasPriorConfirmedBreach is false when the last minute was safe", async () => {
  const { client } = stubClient({
    priorRows: [bucket(1, { safe: 1 }), bucket(2, { violation: 6 })],
  });
  assertEquals(await hasPriorConfirmedBreach(client, "ESP32-001", "2026-09-29T10:30:00.000Z", 10), false);
});

Deno.test("hasPriorConfirmedBreach is false for a first-time breach of 1 or 2 readings", async () => {
  const { client } = stubClient({ priorRows: [bucket(1, { violation: 2 }), bucket(2, { violation: 1 })] });
  assertEquals(await hasPriorConfirmedBreach(client, "ESP32-001", "2026-09-29T10:30:00.000Z", 10), false);
});

Deno.test("hasPriorConfirmedBreach treats a data gap as a resolved breach", async () => {
  const { client } = stubClient({ priorRows: [bucket(4, { violation: 6 })] });
  assertEquals(await hasPriorConfirmedBreach(client, "ESP32-001", "2026-09-29T10:30:00.000Z", 10), false);
});

Deno.test("a cold start mid-breach does not re-notify (durable aggregate check)", async () => {
  // A fresh guard: this simulates a cold start, so the in-memory flag is gone.
  const { handler, request, spawner, fetchCalls, calls } = buildHandler({
    stub: stubClient({
      aggregateRow: violationAggregate(3),
      priorRows: [bucket(1, { violation: 5 })],
    }),
    body: { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
  });
  const response = await handler(request);
  assertEquals((await response.json()).sms_triggered, false);
  await spawner.settle();
  assertEquals(fetchCalls.length, 0);
  const select = calls.find((c) => c.kind === "select");
  assert(select !== undefined, "the durable check must query the prior buckets");
  assertEquals(select.table, "sensor_minute_aggregates");
});

Deno.test("a cold start on a genuinely new breach still notifies", async () => {
  const { handler, request, spawner, fetchCalls } = buildHandler({
    stub: stubClient({
      aggregateRow: violationAggregate(3),
      priorRows: [bucket(1, { violation: 2 }), bucket(2, { safe: 1 })],
    }),
    body: { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
  });
  await handler(request);
  await spawner.settle();
  assertEquals(fetchCalls.length, 1);
});

Deno.test("a failing durable lookup fails open (alert) instead of throwing", async () => {
  const base = stubClient({ aggregateRow: violationAggregate(3) });
  const failing: SupabaseLike = {
    rpc: (name, args) => base.client.rpc(name, args),
    from() {
      return {
        select() {
          return {
            in() {
              return Promise.reject(new Error("network down"));
            },
          };
        },
      };
    },
  };
  const logs: string[] = [];
  const { handler, request, spawner, fetchCalls } = buildHandler({
    client: failing,
    body: { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  const response = await handler(request);
  // The rejection must not escape the request path, and a real confirmed
  // breach must still be alerted on rather than silently suppressed.
  assertEquals(response.status, 200);
  assertEquals((await response.json()).sms_triggered, true);
  await spawner.settle();
  assertEquals(fetchCalls.length, 1);
  assert(logs.some((l) => l.includes("network down")), "the lookup failure is logged");
});

// ---------------------------------------------------------------------------
// SMS transport failures never block ingestion
// ---------------------------------------------------------------------------

Deno.test("a rejected SMS fetch does not affect the response and is logged", async () => {
  const logs: string[] = [];
  const { handler, request, spawner } = buildHandler({
    stub: stubClient({ aggregateRow: violationAggregate(3) }),
    body: { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
    fetchImpl: () => Promise.reject(new Error("semaphore 502")),
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  const response = await handler(request);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).ok, true);
  await spawner.settle();
  assertEquals(logs.length, 1);
  assert(logs[0].startsWith("error:"));
  assert(logs[0].includes("semaphore 502"), "the failure reason is logged for retry");
});

Deno.test("unconfigured SMS settings skip the send entirely", async () => {
  const { handler, request, spawner, fetchCalls } = buildHandler({
    stub: stubClient({ aggregateRow: violationAggregate(3) }),
    body: { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
    settings: {},
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });
  const response = await handler(request);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).sms_triggered, false);
  await spawner.settle();
  assertEquals(fetchCalls.length, 0);
});

Deno.test("a throwing readSettings is swallowed and does not fail the request", async () => {
  const { handler, request, spawner, fetchCalls } = buildHandler({
    stub: stubClient({ aggregateRow: violationAggregate(3) }),
    body: { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
    readSettings: () => Promise.reject(new Error("settings 500")),
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });
  const response = await handler(request);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).ok, true);
  await spawner.settle();
  assertEquals(fetchCalls.length, 0);
});

Deno.test("the response is returned even while the SMS is still in flight", async () => {
  // A fetch that never settles models a slow provider: the request must not
  // wait for it (plan Review Focus #4).
  const { handler, request } = buildHandler({
    stub: stubClient({ aggregateRow: violationAggregate(3) }),
    body: { sensor_id: "ESP32-001", lux: 30, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
    fetchImpl: () => new Promise(() => {}),
  });
  const response = await Promise.race([
    handler(request),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("handler awaited the SMS")), 2000)),
  ]);
  assertEquals(response.status, 200);
});

Deno.test("the SMS message is built from the confirmed breach details", async () => {
  const { handler, request, spawner, fetchCalls } = buildHandler({
    stub: stubClient({
      sensorRow: { greenhouse_id: "greenhouse-alpha" },
      aggregateRow: violationAggregate(3),
    }),
    body: { sensor_id: "ESP32-009", lux: 42.5, recorded_at: "2026-09-29T10:30:20.000Z", phase_type: "dark" },
  });
  await handler(request);
  await spawner.settle();
  const sent = JSON.parse(String(fetchCalls[0].init.body));
  assert(sent.message.includes("ESP32-009"));
  assert(sent.message.includes("greenhouse-alpha"));
  assert(sent.message.includes("42.5 lux"));
  assert(sent.message.includes("dark"), "the message names the phase");
});

Deno.test("CONSECUTIVE_VIOLATIONS_REQUIRED is the project rule of 3", () => {
  assertEquals(CONSECUTIVE_VIOLATIONS_REQUIRED, 3);
});
