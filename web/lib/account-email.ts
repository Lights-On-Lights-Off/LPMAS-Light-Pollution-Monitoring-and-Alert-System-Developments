export function validAccountEmail(email: string): boolean {
  if (email.length > 254 || email !== email.trim() || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) return false;
  const [local, domain] = email.toLowerCase().split("@");
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (domain.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return false;
  return !["example.com", "example.net", "example.org"].includes(domain) && !/\.(invalid|test|example|localhost)$/.test(domain);
}
