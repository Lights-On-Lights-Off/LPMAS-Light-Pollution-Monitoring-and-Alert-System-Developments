import {assertEquals} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {configuredWebOrigin, oauthNonce, oauthChallenge, sameNonce} from "./google-oauth.ts";

Deno.test("OAuth callbacks use the configured origin and reject open redirects", () => {
  assertEquals(configuredWebOrigin("https://lpmas.example.com", true), "https://lpmas.example.com");
  for (const value of ["", "https://lpmas.example.com/", "https://lpmas.example.com/path", "https://user:secret@lpmas.example.com", "http://lpmas.example.com", "javascript:alert(1)"]) {
    assertEquals(configuredWebOrigin(value, true), null);
  }
  assertEquals(configuredWebOrigin("http://localhost:3000", true), null);
  assertEquals(configuredWebOrigin("http://localhost:3000", false), "http://localhost:3000");
});

Deno.test("authorization state and PKCE use unpredictable independent values", () => {
  const first = oauthNonce(), second = oauthNonce();
  assertEquals(first.length, 43);
  assertEquals(first === second, false);
  assertEquals(sameNonce(first, first), true);
  assertEquals(sameNonce(first, second), false);
  assertEquals(sameNonce(first, first + "x"), false);
  assertEquals(oauthChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});
