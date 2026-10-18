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
 * moment: the agent's own write cannot overwrite it, and what it concludes
 * instead is kept beside it as a **proposal** a person accepts or dismisses
 * (ADR 0037), which is what makes a correction something the agent reasons from
 * rather than something it silently corrects on the next pass.
 */

import type { Hono } from "hono";
import { readClaim } from "../agent/claim.js";
import { readInstruction } from "../agent/instruction.js";
import {
  correctFactByPerson,
  dismissProposal,
  forgetFact,
  listFacts,
  MemoryError,
} from "../agent/memory.js";
import { parseRuleDocumentDetailed } from "../agent/rule.js";
import { deleteRule, listRules, replaceRule } from "../agent/rules.js";
import { listRunsForReading } from "../agent/runs.js";
import { AGENT_PASS_INTERVAL_MS } from "../agent/supervisor.js";
import {
  appFolderState,
  type Ctx,
  destroyAppNode,
  ensureAppFolder,
  ensureFolderPath,
  filesAccountId,
  findAppFileAt,
  findAppFolder,
  findFolderPath,
  writeAppFileAt,
} from "../appFolder.js";
import { masterAddress } from "../config.js";
import {
  GroupAccessError,
  openAgentSession,
  resolveGroupAccess,
} from "../groupAccess.js";
import type { LiveSession } from "../sessions.js";
import { type AgentStatus, isClaimDoc } from "../shared/agent.js";
import { isStateMismatch } from "../shared/errors.js";
import {
  INSTRUCTION_FILE,
  INSTRUCTION_VERSION,
  parseInstructionDocumentDetailed,
} from "../shared/instruction.js";
import { RULES_DIR } from "../shared/rule.js";
import type { RunListing } from "../shared/run.js";
import {
  type Env,
  failureFor,
  groupAccessFailure,
  groupDenial,
  readJson,
  requireAdmin,
  requireSession,
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

  /**
   * A thrown refusal answered as the refusal it is.
   *
   * The door's own code -- no Master configured, a credential refused -- is not
   * an upstream fault and must not be reported as one; the memory's codes are
   * answered beside it, and only what is neither is upstream's.
   */
  const doorFailure = (c: Parameters<typeof groupDenial>[0], err: unknown) =>
    groupAccessFailure(c, err) ?? memoryFailure(c, err);

  /**
   * A write to a group's prose that lost its compare-and-set is the caller's
   * conflict, answered as 409 so the panel can say so and reload — not the
   * upstream fault every other refusal would become.
   */
  const proseFailure = (c: Parameters<typeof groupDenial>[0], err: unknown) =>
    isStateMismatch(err)
      ? c.json(
          {
            error: "prose_moved",
            message:
              "The group's prose changed while this was being written, so nothing was saved.",
          },
          409,
        )
      : doorFailure(c, err);

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
      const runs: RunListing[] = await listRunsForReading(access.ctx, access.accountId);
      return c.json({ group: name, runs });
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  /**
   * A group's prose — its standing instruction and its rules (ADR 0035).
   *
   * The write path is here, behind the administrator door, and not in the
   * browser: a group's prose is decided by an installation administrator (owner
   * decision 2026-10-18), and only a route the server answers can make that a
   * boundary rather than a hidden button. The read is beside it so the surface
   * has one caller for both, and the account is resolved from the group's name
   * the way the runs above are.
   */
  api.get("/admin/groups/:name/prose", requireSession, requireAdmin, async (c) => {
    const name = c.req.param("name") ?? "";
    try {
      const access = await resolveGroupAccess(c.get("session"), name, {
        need: "agent documents",
      });
      if (!access.ok) return groupDenial(c, access);
      const instruction = (await readInstruction(access.ctx, access.accountId)) ?? "";
      const records = await listRules(access.ctx, access.accountId);
      return c.json({
        group: name,
        instruction,
        rules: records.map((record) => record.rule),
        state: records[0]?.state ?? (await appFolderState(access.ctx, access.accountId)),
      });
    } catch (err) {
      return proseFailure(c, err);
    }
  });

  api.put(
    "/admin/groups/:name/prose/instruction",
    requireSession,
    requireAdmin,
    async (c) => {
      const name = c.req.param("name") ?? "";
      try {
        const access = await resolveGroupAccess(c.get("session"), name, {
          need: "agent documents",
        });
        if (!access.ok) return groupDenial(c, access);
        const body = await readJson<{ instruction?: unknown; ifInState?: unknown }>(c);
        const instruction =
          typeof body?.instruction === "string" ? body.instruction.trim() : "";
        /*
         * The folder is made before the token is chosen: making it moves the
         * account's state, so a token the client read **before** the folder
         * existed cannot match. When the route itself creates the folder, the
         * token is read fresh; otherwise the client's own read is what the write
         * is conditioned on.
         */
        const hadFolder = await findAppFolder(access.ctx, access.accountId);
        await ensureAppFolder(access.ctx, access.accountId);
        const state =
          hadFolder && typeof body?.ifInState === "string"
            ? body.ifInState
            : await appFolderState(access.ctx, access.accountId);
        if (!instruction) {
          const found = await findAppFileAt(
            access.ctx,
            access.accountId,
            INSTRUCTION_FILE,
          );
          if (found?.file && typeof found.file.id === "string")
            await destroyAppNode(access.ctx, access.accountId, found.file.id, {
              ifInState: state,
            });
          return c.json({ ok: true, instruction: "" });
        }
        const parsed = parseInstructionDocumentDetailed(
          JSON.stringify({ v: INSTRUCTION_VERSION, instruction }),
        );
        if ("problem" in parsed) return c.json({ error: parsed.problem }, 400);
        await writeAppFileAt(
          access.ctx,
          access.accountId,
          INSTRUCTION_FILE,
          parsed.instruction,
          {
            ifInState: state,
          },
        );
        return c.json({ ok: true, instruction: parsed.instruction.instruction });
      } catch (err) {
        return proseFailure(c, err);
      }
    },
  );

  api.put(
    "/admin/groups/:name/prose/rules/:id",
    requireSession,
    requireAdmin,
    async (c) => {
      const name = c.req.param("name") ?? "";
      const id = c.req.param("id") ?? "";
      try {
        const access = await resolveGroupAccess(c.get("session"), name, {
          need: "agent documents",
        });
        if (!access.ok) return groupDenial(c, access);
        const body = await readJson<{ rule?: unknown; ifInState?: unknown }>(c);
        const parsed = parseRuleDocumentDetailed(JSON.stringify(body?.rule));
        if ("problem" in parsed) return c.json({ error: parsed.problem }, 400);
        if (parsed.rule.id !== id)
          return c.json(
            { error: `The rule says "${parsed.rule.id}" but the route files "${id}".` },
            400,
          );
        // The same rule as the instruction above: a folder this route creates is
        // its own change, so the token is read after it, not carried from before.
        const hadFolder = await findFolderPath(access.ctx, access.accountId, RULES_DIR);
        await ensureFolderPath(access.ctx, access.accountId, RULES_DIR);
        const state =
          hadFolder && typeof body?.ifInState === "string"
            ? body.ifInState
            : await appFolderState(access.ctx, access.accountId);
        await replaceRule(access.ctx, access.accountId, parsed.rule, {
          ifInState: state,
        });
        return c.json({ ok: true, rule: parsed.rule });
      } catch (err) {
        return proseFailure(c, err);
      }
    },
  );

  api.delete(
    "/admin/groups/:name/prose/rules/:id",
    requireSession,
    requireAdmin,
    async (c) => {
      const name = c.req.param("name") ?? "";
      const id = c.req.param("id") ?? "";
      try {
        const access = await resolveGroupAccess(c.get("session"), name, {
          need: "agent documents",
        });
        if (!access.ok) return groupDenial(c, access);
        const body = await readJson<{ ifInState?: unknown }>(c);
        const state =
          typeof body?.ifInState === "string"
            ? body.ifInState
            : await appFolderState(access.ctx, access.accountId);
        await deleteRule(access.ctx, access.accountId, id, { ifInState: state });
        return c.json({ ok: true });
      } catch (err) {
        return proseFailure(c, err);
      }
    },
  );

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
      return doorFailure(c, err);
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
      return doorFailure(c, err);
    }
  });

  /**
   * Dismiss the agent's proposal against a person's fact (ADR 0037).
   *
   * The sheet keeps everything it has — its sentence, where it came from, the
   * person's correction, its links — and loses only the words the agent
   * concluded. A sheet that carries no proposal is already what a dismissal
   * leaves, so pressing twice is not an error.
   */
  api.delete("/admin/memory/:id/proposal", requireSession, requireAdmin, async (c) => {
    try {
      const ctx = await masterCtx(c.get("session"));
      const accountId = memoryAccount(ctx);
      const fact = await dismissProposal(
        ctx,
        accountId,
        c.req.param("id") ?? "",
        await listFacts(ctx, accountId),
      );
      return c.json({ fact });
    } catch (err) {
      return doorFailure(c, err);
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
      return doorFailure(c, err);
    }
  });
}
