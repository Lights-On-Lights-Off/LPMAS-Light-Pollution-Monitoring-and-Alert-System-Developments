import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyReading,
  createHandler,
  type Delivery,
  drainNotifications,
  type HandlerDeps,
  type IncidentSnapshot,
  validateDelivery,
} from "./index.ts";
const KEY = "backend-key";
const incident: IncidentSnapshot = {
  id: 1,
  incident_uid: "11111111-1111-4111-8111-111111111111",
  version: 1,
  sensor_id: "S1",
  greenhouse_id: "G1",
  phase_type: "dark",
  opened_at: "2026-10-01T00:00:10Z",
  resolved_at: null,
  status: "open",
  peak_lux: 40,
  lowest_lux: 40,
  reason: "Dark phase light violation",
  triggering_readings: [
    "2026-09-30T23:59:50Z",
    "2026-10-01T00:00:00Z",
    "2026-10-01T00:00:10Z",
  ].map((recorded_at) => ({
    sensor_id: "S1",
    greenhouse_id: "G1",
    phase_type: "dark",
    classification: "violation",
    recorded_at,
    lux: 40,
  })),
};
function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    kind: "reading",
    delivery_id: "22222222-2222-4222-8222-222222222222",
    recorded_at: "2026-10-01T00:00:10Z",
    sensor_id: "S1",
    greenhouse_id: "G1",
    lux: 40,
    phase_type: "dark",
    classification: "violation",
    monitoring_active: true,
    config_version: "snapshot-v1",
    incident: null,
    ...overrides,
  };
}
function fixture(
  options: {
    jobs?: unknown[];
    rejectIngestion?: boolean;
    provider?: Response;
    settings?: Record<string, string>;
  } = {},
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const network: string[] = [];
  const deps: HandlerDeps = {
    serviceRoleKey: KEY,
    client: {
      rpc(name, args) {
        calls.push({ name, args });
        if (name === "ingest_pilot_delivery") {
          return Promise.resolve({
            data: { ok: true, aggregate_updated: true },
            error: options.rejectIngestion
              ? { message: "commit failed" }
              : null,
          });
        }
        return Promise.resolve({
          data: name === "claim_notification_jobs" ? options.jobs ?? [] : null,
          error: null,
        });
      },
    },
    readSettings: () =>
      Promise.resolve(
        options.settings ??
          {
            sms_provider: "textbee",
            textbee_api_key: "secret",
            manager_phone: "09171234567",
          },
      ),
    fetchImpl: (url) => {
      network.push(url);
      return Promise.resolve(
        options.provider ??
          new Response(
            JSON.stringify({ data: { success: true, smsBatchId: "batch1" } }),
            { status: 200 },
          ),
      );
    },
    log: () => {},
    spawn: (task) => {
      void task;
    },
  };
  const request = (
    body: unknown,
    authorization: string | null = `Bearer ${KEY}`,
  ) =>
    new Request("https://local/ingest", {
      method: "POST",
      headers: authorization ? { Authorization: authorization } : {},
      body: JSON.stringify(body),
    });
  return { deps, calls, network, request, handler: createHandler(deps) };
}
Deno.test("anonymous and ordinary user callers cannot ingest or drain notifications", async () => {
  for (const auth of [null, "Bearer user-token", "Bearer "]) {
    const f = fixture();
    assertEquals((await f.handler(f.request(delivery(), auth))).status, 401);
    assertEquals(f.calls.length, 0);
  }
});
Deno.test("backend ingestion commits through one transaction RPC", async () => {
  const f = fixture();
  const d = delivery();
  assertEquals((await f.handler(f.request(d))).status, 200);
  assertEquals(f.calls[0], {
    name: "ingest_pilot_delivery",
    args: { p_payload: d },
  });
});
Deno.test("a commit error requests a retry without claiming notification work", async () => {
  const f = fixture({ rejectIngestion: true });
  assertEquals((await f.handler(f.request(delivery()))).status, 500);
  assertEquals(f.calls.length, 1);
});
Deno.test("three minute-count violations never create a notification in the handler", async () => {
  const f = fixture();
  await f.handler(f.request(delivery()));
  assertEquals(f.network.length, 0);
});
Deno.test("a consecutive sequence spanning midnight and minute boundaries is valid", () =>
  assert(validateDelivery(delivery({ incident })).ok));
Deno.test("interrupted and mixed-sensor sequences are rejected", () => {
  for (
    const patch of [{ recorded_at: "2026-10-01T00:00:09Z" }, {
      classification: "safe",
    }, { sensor_id: "S2" }]
  ) {
    const i = structuredClone(incident);
    Object.assign(i.triggering_readings[1], patch);
    assert(!validateDelivery(delivery({ incident: i })).ok);
  }
});
Deno.test("unassigned or unmonitored measurements still have a valid delivery contract", () =>
  assert(
    validateDelivery(
      delivery({
        greenhouse_id: null,
        phase_type: "unconfigured",
        classification: "unclassified",
        monitoring_active: false,
      }),
    ).ok,
  ));
Deno.test("illumination windows do not restrict dark-phase monitoring", () =>
  assert(validateDelivery(delivery({ incident })).ok));
Deno.test("invalid lux, context, identifiers and timestamps are rejected", () => {
  for (
    const patch of [
      { lux: NaN },
      { lux: Infinity },
      { lux: -1 },
      { lux: 65536 },
      { delivery_id: "invalid" },
      { recorded_at: "2026-10-01" },
      { config_version: "" },
      { classification: "safe" },
      { phase_type: "unconfigured" },
    ]
  ) assert(!validateDelivery({ ...delivery(), ...patch }).ok);
});
Deno.test("decimal threshold boundaries agree with Pi rules", () => {
  assertEquals(classifyReading(30, "illumination"), "violation");
  assertEquals(classifyReading(30.1, "illumination"), "warning");
  assertEquals(classifyReading(49.9, "illumination"), "warning");
  assertEquals(classifyReading(50, "illumination"), "safe");
  assertEquals(classifyReading(15, "dark"), "safe");
  assertEquals(classifyReading(15.1, "dark"), "warning");
  assertEquals(classifyReading(29, "dark"), "warning");
  assertEquals(classifyReading(29.1, "dark"), "violation");
});
Deno.test("acknowledgement and resolution snapshots can replay independently of readings", () => {
  for (const status of ["acknowledged", "resolved"] as const) {
    assert(
      validateDelivery(
        delivery({
          kind: "incident",
          incident: {
            ...incident,
            status,
            resolved_at: status === "resolved" ? "2026-10-01T00:01:00Z" : null,
          },
        }),
      ).ok,
    );
  }
});
Deno.test("worker ticks run without any sensor readings", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(f.request({ retry_notifications: true }))).status,
    200,
  );
  assertEquals(f.calls.map((c) => c.name), ["claim_notification_jobs"]);
});
Deno.test("accepted means provider acceptance, not handset delivery", async () => {
  const f = fixture({
    jobs: [{ id: "job1", lease_token: "lease1", incident }],
  });
  await drainNotifications(f.deps);
  const finish = f.calls.find((c) => c.name === "finish_notification_job")!;
  assertEquals(finish.args.p_accepted, true);
  assert(String(finish.args.p_detail).includes("unconfirmed"));
  assertEquals(finish.args.p_lease_token, "lease1");
});
Deno.test("rejection remains durable and credentials are redacted", async () => {
  const f = fixture({
    jobs: [{ id: "job1", lease_token: "lease1", incident }],
    provider: new Response(JSON.stringify({ error: "secret rejected" }), {
      status: 401,
    }),
  });
  await drainNotifications(f.deps);
  const args = f.calls.find((c) => c.name === "finish_notification_job")!.args;
  assertEquals(args.p_accepted, false);
  assert(!String(args.p_detail).includes("secret"));
});
Deno.test("missing configuration records a retryable notification outcome", async () => {
  const f = fixture({
    jobs: [{ id: "job1", lease_token: "lease1", incident }],
    settings: {},
  });
  await drainNotifications(f.deps);
  assertEquals(f.network.length, 0);
  assertEquals(f.calls.at(-1)!.args.p_accepted, false);
});
Deno.test("oversize and malformed requests fail before database writes", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(f.request({ data: "x".repeat(33000) }))).status,
    413,
  );
  const request = new Request("https://local/ingest", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },
    body: "{",
  });
  assertEquals((await f.handler(request)).status, 400);
  assertEquals(f.calls.length, 0);
});

Deno.test("modern confirmations require one configuration for every triggering sample", () => {
  const modern = {
    ...structuredClone(incident),
    config_version: "snapshot",
    triggering_readings: incident.triggering_readings.map(r => ({...r, config_version: "snapshot"})),
  };
  assert(validateDelivery(delivery({config_version: "snapshot", incident: modern})).ok);
  modern.triggering_readings[0].config_version = "previous";
  assert(!validateDelivery(delivery({config_version: "snapshot", incident: modern})).ok);
  modern.triggering_readings[0].config_version = "snapshot";
  assert(!validateDelivery(delivery({config_version: "different", incident: modern})).ok);
});

Deno.test("context closures replay independently and preserve the confirmation configuration", () => {
  for (const reason of ["safe_reading", "phase_ended", "assignment_changed", "configuration_changed", "monitoring_window_ended"] as const) {
    const closed = {
      ...structuredClone(incident),
      config_version: "original",
      status: "resolved" as const,
      resolved_at: "2026-10-01T00:01:00Z",
      resolution_reason: reason,
      triggering_readings: incident.triggering_readings.map(r => ({...r, config_version: "original"})),
    };
    assert(validateDelivery(delivery({kind: "incident", incident: closed})).ok);
  }
});

Deno.test("invalid closure metadata is rejected without breaking historical queues", () => {
  assert(validateDelivery(delivery({incident})).ok);
  assert(!validateDelivery(delivery({incident: {...incident, resolution_reason: "safe_reading"}})).ok);
  assert(!validateDelivery(delivery({incident: {...incident, status: "resolved", resolved_at: "2026-09-01T00:00:00Z"}})).ok);
  assert(!validateDelivery(delivery({incident: {...incident, config_version: ""}})).ok);
});
