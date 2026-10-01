export function permitsApiMutation(method: string, requestHost: string | null, origin: string | null, fetchSite: string | null): boolean {
  if (['GET','HEAD','OPTIONS'].includes(method)) return true;
  if (fetchSite === 'cross-site') return false;
  // Non-browser clients still pass through each route's authentication checks.
  if (!origin) return true;
  try {
    const source = new URL(origin);
    const localHttp = source.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname);
    return (source.protocol === 'https:' || localHttp) &&
      source.origin === origin && source.host === requestHost;
  } catch { return false; }
}
