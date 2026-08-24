import type { Role } from "./profile";

export type AdminUser = { id: string; email: string; full_name: string | null; role: Role };

async function call<T>(init?: RequestInit): Promise<T> {
  const res = await fetch("/api/admin/users", {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export const listAdminUsers = () => call<{ users: AdminUser[] }>();
export const createAdminUser = (email: string, role: Role, full_name?: string) =>
  call<AdminUser>({ method: "POST", body: JSON.stringify({ email, role, full_name }) });
export const updateAdminUserRole = (id: string, role: Role) =>
  call<{ ok: true }>({ method: "PATCH", body: JSON.stringify({ id, role }) });
export const deleteAdminUser = (id: string) =>
  call<{ ok: true }>({ method: "DELETE", body: JSON.stringify({ id }) });
