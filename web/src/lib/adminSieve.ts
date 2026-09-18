/**
 * The admin System Sieve API, as the client calls it (ADR 0008).
 *
 * One function per route in `server/src/app.ts`'s "System Sieve scripts"
 * section, which writes `x:SieveSystemScript` as the signed-in
 * administrator's own session — a global registry object, not an account's
 * script, so unlike the agents' API there is no per-account scoping to carry.
 *
 * Every read carries the type's own `state`; a write built on one sends it
 * back as `state` so the server can pass it to Stalwart as `ifInState` —
 * a write whose baseline has since changed is refused (409) rather than
 * silently overwriting whatever changed it.
 */

import type {
  SystemSieveScriptContent,
  SystemSieveScriptList,
  SystemSieveScriptWrite,
} from "@gilbert/shared/sieveViews";
import { apiFetch } from "@/jmap/client";

/*
 * Read here, declared there: the shapes these routes answer with and the body a
 * write carries, so a consumer of this module names the same fields the route
 * reads (`@gilbert/shared` is the alias both tiers read; see web/tsconfig.json).
 */
export type {
  SystemSieveScript,
  SystemSieveScriptContent,
  SystemSieveScriptList,
  SystemSieveScriptWrite,
} from "@gilbert/shared/sieveViews";

/** `GET /api/admin/sieve/system` — every system script, without its contents. */
export function listSystemSieveScripts(): Promise<SystemSieveScriptList> {
  return apiFetch<SystemSieveScriptList>("/api/admin/sieve/system");
}

/** `GET /api/admin/sieve/system/:id` — one script, contents included. */
export function getSystemSieveScript(id: string): Promise<SystemSieveScriptContent> {
  return apiFetch<SystemSieveScriptContent>(
    `/api/admin/sieve/system/${encodeURIComponent(id)}`,
  );
}

/**
 * `POST` to create, `PUT .../:id` to update — Stalwart's own compile check
 * runs on the write itself; a bad script, or a save whose `state` is stale,
 * comes back as a thrown `ApiError` whose message is already one a person
 * can act on.
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
export function setSystemSieveScriptActive(
  id: string,
  active: boolean,
  state?: string,
): Promise<void> {
  return apiFetch<void>(`/api/admin/sieve/system/${encodeURIComponent(id)}/active`, {
    method: "POST",
    body: JSON.stringify({ active, state }),
  });
}

/** `DELETE /api/admin/sieve/system/:id`. */
export function deleteSystemSieveScript(id: string, state?: string): Promise<void> {
  return apiFetch<void>(`/api/admin/sieve/system/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ state }),
  });
}
