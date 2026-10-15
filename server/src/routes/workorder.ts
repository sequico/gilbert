/**
 * The workorder surfaces (ADR 0028): one route-only view, composed per caller
 * from the Master's root and the caller's own groups' parts.
 */

import type { Context, Hono } from "hono";
import { isRecord } from "../shared/json.js";
import {
  isWorkorderRef,
  isWorkorderState,
  isWorkorderStepState,
  isWorkorderTemplateRef,
  type WorkorderCreateInput,
  type WorkorderItemInput,
  type WorkorderRef,
} from "../shared/workorder.js";
import {
  checkStep as checkWorkorderStep,
  closeWorkorder,
  createWorkorder,
  editRefs,
  listWorkorders,
  readWorkorder,
  replaceWorkorder,
  WorkorderAdminError,
} from "../workorderAdmin.js";
import type { Env } from "./shared.js";
import {
  readJson,
  refusal,
  requireAdmin,
  requireSession,
  upstreamFailure,
} from "./shared.js";

export function registerWorkorderRoutes(api: Hono<Env>): void {
  // ---------- Workorders (ADR 0028) ----------

  /** A refusal from the workorder surface: its code and sentence, or upstream's. */
  const workorderFailure = (c: Context, err: unknown) => {
    if (err instanceof WorkorderAdminError) return c.json(...refusal(err));
    return upstreamFailure(c, err);
  };

  /*
   * The creation body, narrowed to what the door writes.
   *
   * Narrowed by **refusing**, never by dropping: this used to skip a variant
   * whose value was not a string, an `items` entry whose `data` was an object
   * instead of a list, and a field whose value was a number or a boolean — and
   * then answer `{ ok: true }`. The caller was told the workorder was created
   * while its steps and its field values were quietly missing, and the missing
   * half was exactly the half a person would notice at the workface. A body
   * that does not fit is a mistake to correct, not a limb to remove.
   */
  const badBody = (what: string) =>
    new WorkorderAdminError("bad_request", `A workorder's ${what} is not its shape.`);

  const workorderCreate = (raw: unknown): WorkorderCreateInput => {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.name !== "string" || !isWorkorderTemplateRef(r.template))
      throw new WorkorderAdminError(
        "bad_request",
        "A workorder needs a name and the template it instantiates.",
      );
    const input: WorkorderCreateInput = {
      name: r.name,
      template: r.template,
    };
    if (isRecord(r.variants)) {
      const variants: Record<string, string> = {};
      for (const [key, value] of Object.entries(r.variants)) {
        if (typeof value !== "string") throw badBody(`variant "${key}"`);
        variants[key] = value;
      }
      input.variants = variants;
    }
    if (isRecord(r.items)) {
      const items: Record<string, WorkorderItemInput[]> = {};
      for (const [key, list] of Object.entries(r.items)) {
        if (!Array.isArray(list)) throw badBody(`variant "${key}" items`);
        const chosen: WorkorderItemInput[] = [];
        for (const entry of list) {
          if (!isRecord(entry) || typeof entry.key !== "string")
            throw badBody(`item in variant "${key}"`);
          const one: WorkorderItemInput = { key: entry.key };
          if (isRecord(entry.data)) {
            const data: Record<string, string> = {};
            for (const [field, value] of Object.entries(entry.data)) {
              if (typeof value !== "string")
                throw badBody(`item field "${field}" in variant "${key}"`);
              data[field] = value;
            }
            one.data = data;
          }
          chosen.push(one);
        }
        items[key] = chosen;
      }
      input.items = items;
    }
    return input;
  };

  api.get("/workorders", requireSession, async (c) => {
    try {
      return c.json({ ok: true, workorders: await listWorkorders(c.get("session")) });
    } catch (err) {
      return workorderFailure(c, err);
    }
  });

  api.get("/workorders/:uid", requireSession, async (c) => {
    try {
      const workorder = await readWorkorder(c.get("session"), c.req.param("uid"));
      if (!workorder) return c.json({ ok: false, error: "workorder_not_found" }, 404);
      return c.json({ ok: true, workorder });
    } catch (err) {
      return workorderFailure(c, err);
    }
  });

  api.post("/workorders/create", requireSession, requireAdmin, async (c) => {
    const body = await readJson<unknown>(c);
    try {
      const workorder = await createWorkorder(c.get("session"), workorderCreate(body));
      return c.json({ ok: true, workorder });
    } catch (err) {
      return workorderFailure(c, err);
    }
  });

  /*
   * Replace: the successor from the same body a creation takes, and the
   * predecessor marked in the same act. `requireAdmin` beside creation's, which
   * is the same grant — this writes a workorder.
   */
  api.post("/workorders/replace", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ uid?: unknown } & Record<string, unknown>>(c);
    try {
      const uid = typeof body?.uid === "string" ? body.uid : "";
      const workorder = await replaceWorkorder(
        c.get("session"),
        uid,
        workorderCreate(body),
      );
      return c.json({ ok: true, workorder });
    } catch (err) {
      return workorderFailure(c, err);
    }
  });

  api.post("/workorders/check", requireSession, async (c) => {
    const body = await readJson<{
      uid?: unknown;
      scope?: unknown;
      group?: unknown;
      path?: unknown;
      state?: unknown;
      note?: unknown;
    }>(c);
    const rawScope = body?.scope;
    const scope = rawScope === "global" || rawScope === "group" ? rawScope : null;
    if (!scope)
      return c.json(
        { error: "bad_request", message: 'The scope must be "global" or "group".' },
        400,
      );
    const state = body?.state;
    if (!isWorkorderStepState(state))
      return c.json(
        {
          error: "bad_request",
          message: "A step state must be open, done, skipped or not-applicable.",
        },
        400,
      );
    try {
      const workorder = await checkWorkorderStep(c.get("session"), {
        uid: typeof body?.uid === "string" ? body.uid : "",
        scope,
        group: typeof body?.group === "string" ? body.group : undefined,
        path: typeof body?.path === "string" ? body.path : "",
        state,
        note: typeof body?.note === "string" ? body.note : undefined,
      });
      return c.json({ ok: true, workorder });
    } catch (err) {
      return workorderFailure(c, err);
    }
  });

  api.post("/workorders/close", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ uid?: unknown; state?: unknown }>(c);
    const state = body?.state;
    if (!isWorkorderState(state))
      return c.json(
        { error: "bad_request", message: "A workorder state is required." },
        400,
      );
    try {
      const workorder = await closeWorkorder(
        c.get("session"),
        typeof body?.uid === "string" ? body.uid : "",
        state,
      );
      return c.json({ ok: true, workorder });
    } catch (err) {
      return workorderFailure(c, err);
    }
  });

  api.post("/workorders/ref", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ uid?: unknown; change?: unknown }>(c);
    const change = (body?.change ?? {}) as { add?: unknown; remove?: unknown };
    const refs: { add?: WorkorderRef; remove?: WorkorderRef } = {};
    if (isWorkorderRef(change.add)) refs.add = change.add;
    if (isWorkorderRef(change.remove)) refs.remove = change.remove;
    if (!refs.add && !refs.remove)
      return c.json(
        { error: "bad_request", message: "A reference to add or remove is required." },
        400,
      );
    try {
      const workorder = await editRefs(
        c.get("session"),
        typeof body?.uid === "string" ? body.uid : "",
        refs,
      );
      return c.json({ ok: true, workorder });
    } catch (err) {
      return workorderFailure(c, err);
    }
  });
}
