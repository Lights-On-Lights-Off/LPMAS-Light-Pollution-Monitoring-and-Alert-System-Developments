/** Validate the origin before attaching a user's bearer token. */
export function validatePiUrl(value: string, allowLocalHttp = false): string {
  const url = new URL(value);
  if (
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) throw new Error("Pi URL must be a plain origin");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    /^192\.168\./.test(url.hostname) || /^10\./.test(url.hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(allowLocalHttp && local && url.protocol === "http:")
  ) throw new Error("Pi API requires HTTPS");
  return url.origin;
}
