/**
 * The installation's own document (ADR 0011) and the system Sieve scripts
 * (ADR 0008).
 *
 * The document's door opens onto the Master's account by impersonation from the
 * administrator's own session — no second credential and no Management API. The
 * Sieve door does not: `x:SieveSystemScript` is a server-wide registry object
 * that belongs to no account, so those calls run as the signed-in
 * administrator's own session and an `accountId` is passed only because JMAP
 * requires one on every call. `adminSieve.ts` states the same thing from its own
 * side.
 */

import type { Context, Hono } from "hono";
import {
  deleteSystemSieveScript,
  getSystemSieveScript,
  listSystemSieveScripts,
  SystemSieveError,
  saveSystemSieveScript,
  setSystemSieveScriptActive,
} from "../adminSieve.js";
import { impersonateAs } from "../agentAdmin.js";
import type { Ctx } from "../appFolder.js";
import { agentAddress } from "../config.js";
import {
  type InstallationRefused,
  publishInstallation,
  readInstallationForAdmin,
} from "../installationAdmin.js";
import type { LiveSession } from "../sessions.js";
import type { SystemSieveScriptWrite } from "../shared/sieveViews.js";
import type { Env } from "./shared.js";
import {
  accountCtx,
  readJson,
  refusal,
  requireAdmin,
  requireSession,
  upstreamFailure,
} from "./shared.js";

export function registerInstallationRoutes(api: Hono<Env>): void {
  /**
   * The Master's own context, or the reason this session does not get one.
   *
   * `impersonateAs` is the one door onto another account (see the policy
   * publish above): it rebuilds the composite credential from this
   * administrator's sealed session, and Stalwart refuses an app-password
   * session for it. Both of its refusals — an app password, and a composite
   * the server will not accept — are answers this surface can show, so they
   * come back as values with the server's own words.
   */
  const installationMaster = async (
    session: LiveSession,
  ): Promise<{ ctx: Ctx } | { refused: InstallationRefused }> => {
    const master = agentAddress();
    if (!master)
      return {
        refused: {
          status: 409,
          code: "no_master",
          message:
            "This deployment names no Master (GILBERT_AGENT_ADDRESS), so there is no account whose own " +
            "app folder a boot reads the installation's document from, and nothing for this surface to " +
            "read or publish. A process that is not a deployment administers no installation.",
        },
      };
    const imp = await impersonateAs(session, master);
    if (!imp.ok)
      return {
        refused: {
          status: imp.status,
          code:
            imp.status === 403
              ? "forbidden"
              : imp.status === 404
                ? "master_not_found"
                : "upstream_error",
          message: imp.message,
        },
      };
    return { ctx: imp.ctx };
  };

  /**
   * The installation's own document: the one the boot reads (`bootstrap.ts`,
   * whose store and rules are `installation.ts` and `shared/installation.ts`).
   *
   * Both halves of this door open onto **the Master's** account, reached by the
   * same impersonation the policy publish above uses: `GILBERT_AGENT_ADDRESS`
   * names the account `bootstrap.ts` signs in as, and the document a boot runs
   * on is that account's own `gilbert` app folder. An administrator whose own
   * account is somewhere else administers *that* document rather than
   * publishing into their own Files -- the difference between a surface called
   * "Installation" and one that only looks like it.
   *
   * GET answers the text as that account holds it, and whether there is one at
   * all — including a document this build cannot read, which is the one a
   * person has come here to repair. POST validates the text with the boot's own
   * validator and writes it with the boot's own writer -- conditionally, and
   * from the stored epoch rather than the submitted one (`installationAdmin.ts`
   * says why) -- so a publish cannot store a document this build would refuse
   * to start from, cannot move a document somebody else just wrote, and cannot
   * move the stored epoch backwards. Text that is not a document is refused
   * before anything is written.
   *
   * A deployment that names no Master has no account a boot reads from, and
   * that is a refusal the read and the publish both answer with -- as a value,
   * with its own code, rather than by opening the door onto whoever is asking.
   *
   * The answer says when the document applies, because it is not now: the
   * running process keeps the configuration it booted with and the next boot
   * reads what was just written. Nothing is reloaded and no session is kicked
   * — nothing about the running process changed.
   */
  api.get("/admin/installation", requireSession, requireAdmin, async (c) => {
    try {
      const door = await installationMaster(c.get("session"));
      if ("refused" in door) return c.json(...refusal(door.refused));
      const result = await readInstallationForAdmin(door.ctx);
      if ("refused" in result) return c.json(...refusal(result.refused));
      return c.json({ installation: result.view });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  api.post("/admin/installation", requireSession, requireAdmin, async (c) => {
    const raw = await c.req.text();
    try {
      const door = await installationMaster(c.get("session"));
      if ("refused" in door) return c.json(...refusal(door.refused));
      const result = await publishInstallation(door.ctx, raw);
      if ("refused" in result) return c.json(...refusal(result.refused));
      return c.json({ outcome: result.published });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- System Sieve scripts (ADR 0008) ----------

  /** A refusal from this surface: the code and the sentence, or upstream's. */
  function systemSieveFailure(c: Context, err: unknown) {
    if (err instanceof SystemSieveError) return c.json(...refusal(err));
    return upstreamFailure(c, err);
  }

  /**
   * The body of a System Sieve write, validated into the shape both tiers name
   * (`@gilbert/shared/sieveViews`) rather than into a second declaration of it:
   * a field added to the surface's write and forgotten here is a field this
   * route silently drops.
   */
  function readSystemSieveBody(body: unknown): SystemSieveScriptWrite | null {
    const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const contents = typeof raw.contents === "string" ? raw.contents : null;
    if (!name || contents === null) return null;
    const description =
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : null;
    const state = typeof raw.state === "string" && raw.state ? raw.state : undefined;
    return { name, description, contents, activate: Boolean(raw.activate), state };
  }

  api.get("/admin/sieve/system", requireSession, requireAdmin, async (c) => {
    try {
      const ctx = await accountCtx(c);
      return c.json(await listSystemSieveScripts(ctx));
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });

  api.get("/admin/sieve/system/:id", requireSession, requireAdmin, async (c) => {
    try {
      const ctx = await accountCtx(c);
      return c.json(await getSystemSieveScript(ctx, c.req.param("id")));
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });

  api.post("/admin/sieve/system", requireSession, requireAdmin, async (c) => {
    const parsed = readSystemSieveBody(await readJson<unknown>(c));
    if (!parsed) return c.json({ error: "bad_request" }, 400);
    try {
      const ctx = await accountCtx(c);
      /* A create has no prior read to lose, and the write ignores a `state`. */
      const id = await saveSystemSieveScript(ctx, null, parsed);
      return c.json({ id });
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });

  api.put("/admin/sieve/system/:id", requireSession, requireAdmin, async (c) => {
    const parsed = readSystemSieveBody(await readJson<unknown>(c));
    if (!parsed) return c.json({ error: "bad_request" }, 400);
    try {
      const ctx = await accountCtx(c);
      const id = await saveSystemSieveScript(ctx, c.req.param("id"), parsed);
      return c.json({ id });
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });

  api.post("/admin/sieve/system/:id/active", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ active?: unknown; state?: unknown }>(c);
    const state = typeof body?.state === "string" && body.state ? body.state : undefined;
    try {
      const ctx = await accountCtx(c);
      await setSystemSieveScriptActive(
        ctx,
        c.req.param("id"),
        Boolean(body?.active),
        state,
      );
      return c.json({ ok: true });
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });

  api.delete("/admin/sieve/system/:id", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ state?: unknown }>(c);
    const state = typeof body?.state === "string" && body.state ? body.state : undefined;
    try {
      const ctx = await accountCtx(c);
      await deleteSystemSieveScript(ctx, c.req.param("id"), state);
      return c.json({ ok: true });
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });
}
