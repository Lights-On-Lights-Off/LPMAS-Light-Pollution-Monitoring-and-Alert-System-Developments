import {assert, assertEquals} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {sendGmail, validEmail} from "./gmail.ts";
const creds = {sender_email: "admin@gmail.com", refresh_token: "private-refresh-token"};

Deno.test("Gmail sends the mirrored message with fixed endpoints and no mailbox read permission", async () => {
  const calls: {url: string; init: RequestInit}[] = [];
  const outcome = await sendGmail(creds, "client", "private-client-secret", "manager@gmail.com", "LPMAS RESOLVED: Greenhouse G1 is safe.", async (url, init) => {
    calls.push({url, init});
    return calls.length === 1 ? Response.json({access_token: "private-access-token"}) : Response.json({id: "gmail-message"});
  });
  assertEquals(outcome, "accepted");
  assertEquals(calls.map(c => c.url), ["https://oauth2.googleapis.com/token", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"]);
  const raw = JSON.parse(String(calls[1].init.body)).raw;
  const mime = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  assert(mime.includes("To: manager@gmail.com"));
  assert(mime.includes("From: admin@gmail.com"));
  assert(mime.includes("Subject: LPMAS greenhouse resolved"));
  assertEquals(atob(mime.split("\r\n\r\n")[1]), "LPMAS RESOLVED: Greenhouse G1 is safe.");
  assert(!mime.includes("private-"));
});

Deno.test("ambiguous Gmail send is never retried", async () => {
  let calls = 0;
  const outcome = await sendGmail(creds, "client", "secret", "manager@gmail.com", "alert", async () => {
    calls++;
    if (calls === 1) return Response.json({access_token: "access"});
    throw new Error("timeout after provider accepted");
  });
  assertEquals(outcome, "unknown");
  assertEquals(calls, 2);
});

Deno.test("header injection and missing authorization cannot send", async () => {
  for (const email of ["manager@gmail.com\r\nBcc: thief@gmail.com", "manager@gmail.com\n", "manager@gmail.com\r\n", "", "invalid", "manager@gmail.com,thief@gmail.com", "a@@gmail.com", "a..b@gmail.com", "a@-gmail.com", "a@éxample.com"]) {
    assertEquals(validEmail(email), false);
    assertEquals(await sendGmail(creds, "client", "secret", email, "alert", () => {throw new Error("Must not send");}), "failed");
  }
});

Deno.test("token refresh failure records failure without attempting a Gmail submission", async () => {
  for (const response of [null, new Response("not JSON"), Response.json({error: "invalid_grant"}, {status: 400}), Response.json({})]) {
    let calls = 0;
    const outcome = await sendGmail(creds, "client", "secret", "manager@gmail.com", "alert", async url => {
      calls++;
      assertEquals(url, "https://oauth2.googleapis.com/token");
      if (!response) throw new Error("refresh timed out");
      return response;
    });
    assertEquals(outcome, "failed");
    assertEquals(calls, 1);
  }
});
