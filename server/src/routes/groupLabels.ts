/**
 * A group mailbox's label catalog (ADR 0004): the group's own, read and written
 * as the Master by an installation administrator.
 */

import type { Hono } from "hono";
import { isOwnRefusal, readGroupLabels, writeGroupLabels } from "../account.js";
import { resolveGroupAccess } from "../groupAccess.js";
import {
  accountFailure,
  type Env,
  groupAccessFailure,
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
      return groupAccessFailure(c, err) ?? upstreamFailure(c, err);
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
      const denied = groupAccessFailure(c, err);
      if (denied) return denied;
      /* The door refuses the reserved namespace with a 4xx `AccountError`, a
         judgement of this server's own, and that is answered as one; a 5xx is
         the mail server failing, whose sentence `upstreamFailure` fixes and
         whose log it writes. */
      return isOwnRefusal(err) ? accountFailure(c, err) : upstreamFailure(c, err);
    }
  });
}
