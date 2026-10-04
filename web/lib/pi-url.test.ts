import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validatePiUrl } from "./pi-url.ts";
Deno.test("production Pi origins must be HTTPS and have no credentials or paths", () => {
  assertEquals(validatePiUrl("https://pi.example/"), "https://pi.example");
  for (
    const value of [
      "http://pi.example",
      "https://user:password@pi.example",
      "https://pi.example/path",
      "https://pi.example/?token=x",
      "javascript:alert(1)",
    ]
  ) assertThrows(() => validatePiUrl(value));
});
Deno.test("insecure origins are explicit local-development exceptions", () => {
  assertEquals(
    validatePiUrl("http://127.0.0.1:5000", true),
    "http://127.0.0.1:5000",
  );
  assertThrows(() => validatePiUrl("http://127.0.0.1:5000"));
  assertThrows(() => validatePiUrl("http://remote.example", true));
});
