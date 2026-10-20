/**
 * The workorder surface's door (ADR 0024).
 *
 * A workorder is one **uid** and a document named `<uid>.json` under
 * `workorders/` in an account's `gilbert` app folder. The **Master's** copy is
 * the workorder's **root** — its identity, its friendly name, its global
 * checklist and its state — and the Master's `workorders/` folder is the
 * registry; a terminal state moves the root to `workorders/closed/`. A
 * **group's** copy, in the group's own account, is the group's **part**. The
 * durable shape, the validators and the builders live in
 * `@gilbert/shared/workorder`; these modules only resolve which account and
 * folder a document lives in, compose the view a caller may reach, and apply
 * the writes.
 *
 * The Master does every read and every write, because it is a member of every
 * group the installation grants it on (ADR 0005): the route serves the surface
 * as the Master and decides, per request, what each caller may reach by the
 * caller's own group membership (ADR 0015). Nothing here is read through a
 * Stalwart share — a workorder is route-only. Because the Master is the only
 * writer, the caller's own address on a step's signature comes from the
 * authenticated session, never from the request.
 *
 * It defines nothing: each helper lives in the job-shaped module beside this
 * one under `server/src/workorder/`, and these lines re-export the same names
 * callers already import.
 */

export { requireState, WorkorderAdminError } from "./workorder/errors.js";
export {
  ensureWorkorders,
  listWorkorders,
  readWorkorder,
  WORKORDER_LIST_MAX,
} from "./workorder/listing.js";
export {
  checkStep,
  closeWorkorder,
  createWorkorder,
  editRefs,
  moveRoot,
  replaceWorkorder,
  settleStepAsAgent,
} from "./workorder/writes.js";
