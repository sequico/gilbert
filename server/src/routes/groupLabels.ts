/**
 * A group mailbox's label catalog (ADR 0005): the group's own, read and written
 * as the Master by an installation administrator.
 */

import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { readGroupLabels, writeGroupLabels } from "../account.js";
import { GroupAccessError, resolveGroupAccess } from "../groupAccess.js";
import {
  accountFailure,
  type Env,
  readJson,
  requireAdmin,
  requireSession,
  upstreamFailure,
} from "./shared.js";

export function registerGroupLabelRoutes(api: Hono<Env>): void {
  api.get("/admin/groups/:name/labels", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const access = await resolveGroupAccess(session, name, { need: "labels" });
      if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
      const labels = await readGroupLabels(access.ctx, access.accountId);
      /* A catalog the validator refuses reads as no catalog: the surface shows
         what it can render, and a write over one is refused where it is made. */
      return c.json({ labels: labels.state === "catalog" ? labels.labels : [] });
    } catch (err) {
      if (err instanceof GroupAccessError) {
        const { code } = err.reason;
        const detail = "detail" in err.reason ? err.reason.detail : undefined;
        return c.json(
          detail ? { error: code, detail } : { error: code },
          err.status as ContentfulStatusCode,
        );
      }
      return upstreamFailure(c, err);
    }
  });

  api.post("/admin/groups/:name/labels", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    const body = await readJson<{ labels?: unknown }>(c);
    if (!body || !Array.isArray(body.labels))
      return c.json({ error: "bad_request", message: "labels must be an array" }, 400);
    try {
      const access = await resolveGroupAccess(session, name, { need: "labels" });
      if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
      await writeGroupLabels(access.ctx, access.accountId, body.labels);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof GroupAccessError) {
        const { code } = err.reason;
        const detail = "detail" in err.reason ? err.reason.detail : undefined;
        return c.json(
          detail ? { error: code, detail } : { error: code },
          err.status as ContentfulStatusCode,
        );
      }
      /* The door refuses the reserved namespace with an `AccountError`, which
         is this server's own refusal and is answered as one rather than as an
         upstream failure. */
      return accountFailure(c, err);
    }
  });
}
