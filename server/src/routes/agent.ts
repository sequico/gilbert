/**
 * The installation's agent, as the administration reads it: where it is, the
 * runs it has worked, and the facts it reasons from.
 *
 * Three documents in three accounts, and one door. The **claim** and the
 * **memory** live in the Master's own app folder — the account the agent signs
 * in as, which is where the installation's own configuration lives too (ADR
 * 0011) — so they are reached the way every one of the installation's own
 * documents is: as the installation, through `openAgentSession` (the deployment's
 * own credential where there is one, impersonation from this administrator's
 * session otherwise). The **runs** live in each group's own account and go
 * through the group door (`resolveGroupAccess`), which asks the installation's
 * grant and not the administrator's membership: an administrator who is not in a
 * group still reads what its agent worked there, and a group the installation is
 * not granted on is refused with the section it was asked for.
 *
 * The door is the installation administrator's own, reused
 * (`requireSession, requireAdmin` — ADR 0001, ADR 0017) rather than a second
 * check written here. **Nothing here starts or stops the agent**: the server's
 * own boot does that (ADR 0031), and a control on this surface would promise
 * something no route could keep.
 *
 * The **write** is a server route, like a group's label catalog: a browser may
 * not write the Master's app folder itself, so a correction and a removal are
 * made here, in the store, against the reading this request took
 * (`agent/memory.ts`). What a person writes is a **person's fact** from that
 * moment — the agent's own write refuses against it in the code
 * `fact_in_force`, which is what makes a correction something the agent reasons
 * from rather than something it silently corrects on the next pass.
 */

import type { Hono } from "hono";
import { readClaim } from "../agent/claim.js";
import {
  correctFactByPerson,
  forgetFact,
  listFacts,
  MemoryError,
} from "../agent/memory.js";
import { listRunsForReading } from "../agent/runs.js";
import { AGENT_PASS_INTERVAL_MS } from "../agent/supervisor.js";
import { type Ctx, filesAccountId } from "../appFolder.js";
import { masterAddress } from "../config.js";
import {
  GroupAccessError,
  openAgentSession,
  resolveGroupAccess,
} from "../groupAccess.js";
import type { LiveSession } from "../sessions.js";
import { type AgentStatus, isClaimDoc } from "../shared/agent.js";
import {
  type Env,
  failureFor,
  groupAccessFailure,
  groupDenial,
  readJson,
  requireAdmin,
  requireSession,
  upstreamFailure,
} from "./shared.js";

/** The answer to a fact this surface could not read or write, or upstream's. */
const memoryFailure = failureFor(MemoryError);

export function registerAgentRoutes(api: Hono<Env>): void {
  /**
   * The Master's own context, or the reason this session does not get one.
   *
   * `openAgentSession` is the one door onto the installation's own account (the
   * group surfaces go through it too), and its refusals are codes a client
   * composes a sentence from — the credential this deployment carries being
   * refused, an account that cannot be reached, or a deployment that names no
   * Master at all, which has no agent to administer and says so rather than
   * answering about somebody else's account.
   */
  async function masterCtx(session: LiveSession): Promise<Ctx> {
    const address = masterAddress();
    if (!address) throw new GroupAccessError({ code: "agent_not_configured" }, 409);
    const agent = await openAgentSession(session, address);
    if (!agent.ok)
      throw new GroupAccessError({ code: agent.code, detail: agent.detail }, 409);
    return agent.ctx;
  }

  /** The account a Master context keeps its documents in, or the refusal. */
  function memoryAccount(ctx: Ctx): string {
    const accountId = filesAccountId(ctx);
    if (!accountId)
      throw new MemoryError(
        "fact_unreadable",
        "This account has no Files to hold the installation's memory, so there is nothing to read or write.",
        409,
      );
    return accountId;
  }

  /** A thrown door refusal answered as one; anything else is upstream's. */
  const doorFailure = (c: Parameters<typeof groupDenial>[0], err: unknown) =>
    groupAccessFailure(c, err) ?? upstreamFailure(c, err);

  /**
   * Where the installation's agent is.
   *
   * The claim, and the interval the supervisor asks for a pass on — the two facts
   * about the process that live in no document the browser can reach on its own.
   * **A claim that is stored but past its expiry is no claim**: that instant
   * means one thing (ADR 0036), and answering with a lapsed holder would report
   * an agent working an installation that no agent is working.
   *
   * The model is deliberately not answered here: it is the installation's own
   * document, and the surface **links** to the section that chooses it rather
   * than keeping a second copy of fields edited there (ADR 0011, ADR 0031).
   */
  api.get("/admin/agent", requireSession, requireAdmin, async (c) => {
    try {
      const stored = await readClaim(await masterCtx(c.get("session")));
      const agent: AgentStatus = {
        claim:
          stored && isClaimDoc(stored) && Date.parse(stored.expires) > Date.now()
            ? stored
            : null,
        passSeconds: Math.round(AGENT_PASS_INTERVAL_MS / 1000),
      };
      return c.json({ agent });
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  /**
   * The runs a group has worked, each as the record carries it.
   *
   * The run document is the product (ADR 0034): this answers the documents as
   * they are stored, and the surface draws them — what woke the run, the rule or
   * the instruction that answered, every step with what it waited on and how it
   * left, the tally, and where it parked and why. A document this build cannot
   * read is **said** in the listing rather than dropped: one run written by
   * another build must not take the rest off the screen, and must never be drawn
   * as an empty run.
   */
  api.get("/admin/groups/:name/runs", requireSession, requireAdmin, async (c) => {
    const name = c.req.param("name") ?? "";
    try {
      const access = await resolveGroupAccess(c.get("session"), name, {
        need: "agent documents",
      });
      if (!access.ok) return groupDenial(c, access);
      const runs = await listRunsForReading(access.ctx, access.accountId);
      return c.json({ group: name, runs });
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  /**
   * The installation's memory: every fact the agent reasons from (ADR 0037).
   *
   * One reading of the whole graph, each sheet as it is stored — the subject, the
   * one sentence held true of it, the group it is about, where it came from and
   * when, and the facts it is linked to. One memory serves the installation, so
   * this is not per group; a sheet this build cannot read is refused rather than
   * listed as a blank fact, which is the store's own rule.
   */
  api.get("/admin/memory", requireSession, requireAdmin, async (c) => {
    try {
      const ctx = await masterCtx(c.get("session"));
      const { facts } = await listFacts(ctx, memoryAccount(ctx));
      return c.json({ facts });
    } catch (err) {
      return memoryFailure(c, err);
    }
  });

  /**
   * Correct a fact, as a person.
   *
   * The store does the writing (`correctFactByPerson`) against **this** request's
   * reading of the memory, whose token is the compare-and-set: a correction made
   * against a list that has moved since is refused rather than landing over what
   * somebody else wrote. The sheet is stamped with the **session's own address** —
   * the person is whoever this administrator is, never a name the body carries.
   */
  api.put("/admin/memory/:id", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ subject?: unknown; fact?: unknown }>(c);
    if (!body || typeof body.subject !== "string" || typeof body.fact !== "string")
      return c.json(
        { error: "bad_request", message: "a correction states a subject and a fact" },
        400,
      );
    try {
      const session = c.get("session");
      const ctx = await masterCtx(session);
      const accountId = memoryAccount(ctx);
      const fact = await correctFactByPerson(
        ctx,
        accountId,
        {
          id: c.req.param("id") ?? "",
          subject: body.subject,
          fact: body.fact,
          who: session.username,
          at: new Date().toISOString(),
        },
        await listFacts(ctx, accountId),
      );
      return c.json({ fact });
    } catch (err) {
      return memoryFailure(c, err);
    }
  });

  /**
   * Remove a fact.
   *
   * The sheet goes with the token this request's reading carried, so a removal
   * decided against a list that has moved is refused rather than taking a fact
   * that was just corrected. A sheet that is not there is refused as
   * `fact_not_found`: the person was shown it, and "there was nothing to remove"
   * is not what they were told.
   */
  api.delete("/admin/memory/:id", requireSession, requireAdmin, async (c) => {
    try {
      const ctx = await masterCtx(c.get("session"));
      const accountId = memoryAccount(ctx);
      const { state } = await listFacts(ctx, accountId);
      await forgetFact(ctx, accountId, c.req.param("id") ?? "", state);
      return c.json({ ok: true });
    } catch (err) {
      return memoryFailure(c, err);
    }
  });
}
