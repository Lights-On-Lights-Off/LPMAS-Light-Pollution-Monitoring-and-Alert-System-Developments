import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendTestEmail } from "./gmail-test.ts";
const credentials = { sender_email: "admin@example.com", refresh_token: "refresh-secret" };
Deno.test("email test refreshes server credentials and submits once with a test subject", async () => {
  const requests: string[] = [];
  const result = await sendTestEmail(credentials, "client", "secret", "manager@example.com", "Test delivery", async (url, init) => {
    requests.push(url);
    if (requests.length === 1) return Response.json({ access_token: "access-secret" });
    const { raw } = JSON.parse(String(init.body));
    const mime = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    assertEquals(mime.includes("Subject: LPMAS test email"), true);
    assertEquals(mime.includes("To: manager@example.com"), true);
    assertEquals(mime.includes("refresh-secret"), false);
    return Response.json({ id: "accepted" });
  });
  assertEquals(result, "accepted");
  assertEquals(requests.length, 2);
});
Deno.test("email test rejects invalid recipients without sending", async () => {
  const result = await sendTestEmail(credentials, "client", "secret", "manager@example.com\r\nBcc: other@example.com", "Test", () => { throw new Error("Must not send"); });
  assertEquals(result, "failed");
});
Deno.test("email test never retries an ambiguous Gmail submission", async () => {
  let calls = 0;
  const result = await sendTestEmail(credentials, "client", "secret", "manager@example.com", "Test", () => {
    calls++;
    if (calls === 1) return Promise.resolve(Response.json({ access_token: "token" }));
    throw new Error("Connection lost");
  });
  assertEquals(result, "unknown");
  assertEquals(calls, 2);
});
Deno.test("failed token refresh does not submit an email", async () => {
  let calls = 0;
  assertEquals(await sendTestEmail(credentials, "client", "secret", "manager@example.com", "Test", () => {
    calls++;
    return Promise.resolve(new Response(null, { status: 401 }));
  }), "failed");
  assertEquals(calls, 1);
});
