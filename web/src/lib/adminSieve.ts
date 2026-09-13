/**
 * The admin System Sieve API, as the client calls it (ADR 0008).
 *
 * One function per route in `server/src/app.ts`'s "System Sieve scripts"
 * section, which writes `x:SieveSystemScript` as the signed-in
 * administrator's own session — a global registry object, not an account's
 * script, so unlike the agents' API there is no per-account scoping to carry.
 */

import { apiFetch } from "@/jmap/client";

export interface SystemSieveScript {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface SystemSieveScriptContent extends SystemSieveScript {
  contents: string;
}

/** `GET /api/admin/sieve/system` — every system script, without its contents. */
export async function listSystemSieveScripts(): Promise<SystemSieveScript[]> {
  const res = await apiFetch<{ scripts: SystemSieveScript[] }>("/api/admin/sieve/system");
  return res.scripts;
}

/** `GET /api/admin/sieve/system/:id` — one script, contents included. */
export function getSystemSieveScript(id: string): Promise<SystemSieveScriptContent> {
  return apiFetch<SystemSieveScriptContent>(
    `/api/admin/sieve/system/${encodeURIComponent(id)}`,
  );
}

export interface SystemSieveScriptWrite {
  name: string;
  description: string | null;
  contents: string;
  activate: boolean;
}

/**
 * `POST` to create, `PUT .../:id` to update — Stalwart's own compile check
 * runs on the write itself; a bad script comes back as a thrown `ApiError`
 * whose message is Stalwart's own `SetError` description.
 */
export async function saveSystemSieveScript(
  id: string | null,
  input: SystemSieveScriptWrite,
): Promise<string> {
  const path = id
    ? `/api/admin/sieve/system/${encodeURIComponent(id)}`
    : "/api/admin/sieve/system";
  const res = await apiFetch<{ id: string }>(path, {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(input),
  });
  return res.id;
}

/** `POST /api/admin/sieve/system/:id/active` — activate or deactivate one script. */
export function setSystemSieveScriptActive(id: string, active: boolean): Promise<void> {
  return apiFetch<void>(`/api/admin/sieve/system/${encodeURIComponent(id)}/active`, {
    method: "POST",
    body: JSON.stringify({ active }),
  });
}

/** `DELETE /api/admin/sieve/system/:id`. */
export function deleteSystemSieveScript(id: string): Promise<void> {
  return apiFetch<void>(`/api/admin/sieve/system/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
