import {assertEquals} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {validAccountEmail} from "./account-email.ts";
Deno.test("account setup rejects testing domains and malformed emails", () => {
  for (const email of ["test@example.invalid", "test@example.com", "test@local.test", "test@localhost", "foo@bar", "a@-gmail.com", "a..b@gmail.com", "a@gmail.com\r\n", "a@@gmail.com"]) assertEquals(validAccountEmail(email), false);
  assertEquals(validAccountEmail("person+alerts@gmail.com"), true);
  assertEquals(validAccountEmail("person@flowerland.ph"), true);
});
