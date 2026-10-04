import {assert, assertEquals, assertRejects} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {drainNotifications, type HandlerDeps} from "./index.ts";

function worker() {
  const jobs = [
    {id: "sms", attempt_token: "a", channel: "sms", event: "opened", recipient: "09171234567", message: "LPMAS ALERT: Greenhouse G1 has a confirmed light violation."},
    {id: "email", attempt_token: "b", channel: "email", event: "opened", recipient: "manager@gmail.com", message: "LPMAS ALERT: Greenhouse G1 has a confirmed light violation."},
  ];
  const outcomes: Record<string, unknown>[] = [];
  let consumed = false, smsCalls = 0, emailCalls = 0;
  const deps: HandlerDeps = {
    serviceRoleKey: "backend", log: () => {}, spawn: () => {},
    client: {rpc(name, args) {
      if (name === "claim_greenhouse_notifications") {
        const data = consumed ? [] : jobs;
        consumed = true;
        return Promise.resolve({data, error: null});
      }
      outcomes.push(args);
      return Promise.resolve({data: null, error: null});
    }},
    readSettings: async () => ({sms_provider: "textbee", textbee_api_key: "secret", manager_phone: "09999999999"}),
    fetchImpl: async (_url, init) => {
      smsCalls++;
      assert(String(init.body).includes("9171234567"));
      throw new Error("secret provider timeout");
    },
    sendEmail: async (recipient, message) => {
      emailCalls++;
      assertEquals(recipient, "manager@gmail.com");
      assertEquals(message, jobs[0].message);
      return "accepted";
    },
  };
  return {deps, outcomes, counts: () => ({smsCalls, emailCalls})};
}

Deno.test("SMS uncertainty does not prevent mirrored email or trigger a resend", async () => {
  const w = worker();
  assertEquals(await drainNotifications(w.deps), 2);
  assertEquals(w.outcomes[0].p_outcome, "unknown");
  assertEquals(w.outcomes[1].p_outcome, "accepted");
  assert(!JSON.stringify(w.outcomes).includes("secret"));
  assertEquals(await drainNotifications(w.deps), 0);
  assertEquals(w.counts(), {smsCalls: 1, emailCalls: 1});
});

Deno.test("database claim failure makes no outbound request", async () => {
  const w = worker();
  w.deps.client.rpc = () => Promise.resolve({data: null, error: {message: "database unavailable"}});
  await assertRejects(() => drainNotifications(w.deps));
  assertEquals(w.counts(), {smsCalls: 0, emailCalls: 0});
});

Deno.test("lost outcome recording cannot reclaim the consumed attempt", async () => {
  const w = worker();
  const rpc = w.deps.client.rpc;
  w.deps.client.rpc = (name, args) => name === "finish_greenhouse_notification"
    ? Promise.resolve({data: null, error: {message: "commit response lost"}}) : rpc(name, args);
  await assertRejects(() => drainNotifications(w.deps));
  assertEquals(await drainNotifications(w.deps), 0);
  assertEquals(w.counts(), {smsCalls: 1, emailCalls: 0});
});
