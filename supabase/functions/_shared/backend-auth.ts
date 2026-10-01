/** Gateway JWT validation alone does not distinguish users from the backend. */
export function backendAuthorized(header: string | null, key: string): boolean {
  if (!key || header === null) return false;
  const expected = `Bearer ${key}`;
  let difference = header.length ^ expected.length;
  for (let i = 0; i < Math.max(header.length, expected.length); i++) {
    difference |= (header.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return difference === 0;
}
