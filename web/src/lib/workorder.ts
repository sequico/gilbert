/**
 * The workorder surface, client half (ADR 0028).
 *
 * The durable format — the document shape, its validators, the pure helpers
 * and the wire views — is one definition in `@gilbert/shared/workorder`, read
 * by both tiers. This module re-exports it, so `@/lib/workorder` is the one
 * import a surface needs, and adds the route calls the panel makes.
 *
 * The whole surface is **route-only** (ADR 0028): the Master does every read
 * and every write, and the server route decides what the caller may see and act
 * on — from the template's assignment of its sections against the caller's own
 * group membership, so a workorder carrying a global section is every signed-in
 * user's and one whose sections are all assigned is its groups' alone. So these
 * are `apiFetch` calls
 * rather than FileNode reads, and `listWorkorders` is the one read: a FileNode
 * change on the rail names an account and nothing else, and the store turns
 * that into this read.
 */

import type {
  WorkorderCheckInput,
  WorkorderCreateInput,
  WorkorderRefChange,
  WorkorderState,
  WorkorderSummary,
} from "@gilbert/shared/workorder";
import { ApiError, apiFetch } from "@/jmap/client";

export * from "@gilbert/shared/workorder";

/** Every workorder the caller may see, as the route composes it. */
export async function listWorkorders(): Promise<WorkorderSummary[]> {
  const res = await apiFetch<{ ok: true; workorders: WorkorderSummary[] }>(
    "/api/workorders",
  );
  return res.workorders;
}

/**
 * One workorder by uid, or null when the caller may not see it: the route
 * answers 404 for the same reason it would for one that does not exist, so a
 * reader learns nothing about a workorder they cannot reach.
 */
export async function readWorkorder(uid: string): Promise<WorkorderSummary | null> {
  try {
    const res = await apiFetch<{ ok: true; workorder: WorkorderSummary }>(
      `/api/workorders/${encodeURIComponent(uid)}`,
    );
    return res.workorder;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Create a workorder; only the Master or an administrator may. */
export async function createWorkorder(
  input: WorkorderCreateInput,
): Promise<WorkorderSummary> {
  const res = await apiFetch<{ ok: true; workorder: WorkorderSummary }>(
    "/api/workorders/create",
    { method: "POST", body: JSON.stringify(input) },
  );
  return res.workorder;
}

/**
 * Replace a workorder with the one that succeeds it.
 *
 * The body is a creation's — a name, the template and its choices — because the
 * successor **is** a new workorder; the route creates it and marks the
 * predecessor `replaced` naming it, in one act.
 */
export async function replaceWorkorder(
  uid: string,
  input: WorkorderCreateInput,
): Promise<WorkorderSummary> {
  const res = await apiFetch<{ ok: true; workorder: WorkorderSummary }>(
    "/api/workorders/replace",
    { method: "POST", body: JSON.stringify({ ...input, uid }) },
  );
  return res.workorder;
}

/** Check or uncheck one step; the route signs it from the session it read. */
export async function checkWorkorderStep(
  input: WorkorderCheckInput,
): Promise<WorkorderSummary> {
  const res = await apiFetch<{ ok: true; workorder: WorkorderSummary }>(
    "/api/workorders/check",
    { method: "POST", body: JSON.stringify(input) },
  );
  return res.workorder;
}

/** Move a workorder to a terminal state; the route moves the root to `closed/`. */
export async function closeWorkorder(
  uid: string,
  state: WorkorderState,
): Promise<WorkorderSummary> {
  const res = await apiFetch<{ ok: true; workorder: WorkorderSummary }>(
    "/api/workorders/close",
    { method: "POST", body: JSON.stringify({ uid, state }) },
  );
  return res.workorder;
}

/** Add or remove one reference of a workorder. */
export async function editWorkorderRefs(
  uid: string,
  change: WorkorderRefChange,
): Promise<WorkorderSummary> {
  const res = await apiFetch<{ ok: true; workorder: WorkorderSummary }>(
    "/api/workorders/ref",
    { method: "POST", body: JSON.stringify({ uid, change }) },
  );
  return res.workorder;
}
