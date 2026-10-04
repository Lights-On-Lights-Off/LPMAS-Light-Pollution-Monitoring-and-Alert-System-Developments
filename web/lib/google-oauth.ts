import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function oauthNonce() { return randomBytes(32).toString("base64url"); }
export function oauthChallenge(verifier: string) { return createHash("sha256").update(verifier).digest("base64url"); }
export function sameNonce(a: string, b: string) {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
export function configuredWebOrigin(value = process.env.LPMAS_WEB_ORIGIN ?? "", production = process.env.NODE_ENV === "production") {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password ||
      (url.protocol !== "https:" && !(!production && url.protocol === "http:" && url.hostname === "localhost"))) return null;
    return value;
  } catch { return null; }
}
