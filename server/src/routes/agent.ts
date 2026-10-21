/**
 * The installation's agent, as the administration reads it: where it is, the
 * runs it has worked, and the facts it reasons from.
 *
 * Three documents in three accounts, and one door. The **claim** and the
 * **memory** live in the Master's own app folder — the account the agent signs
 * in as, which is where the installation's own configuration lives too (ADR
 * 0009) — so they are reached the way every one of the installation's own
 * documents is: as the installation, through `openAgentSession` (the deployment's
 * own credential where there is one, impersonation from this administrator's
 * session otherwise). The **runs** live in each group's own account and go
 * through the group door (`resolveGroupAccess`), which asks the installation's
 * grant and not the administrator's membership: an administrator who is not in a
 * group still reads what its agent worked there, and a group the installation is
 * not granted on is refused with the section it was asked for.
 *
 * The door is the installation administrator's own, reused
 * (`requireSession, requireAdmin` — ADR 0001, ADR 0015) rather than a second
 * check written here. **Nothing here starts or stops the agent**: the server's
 * own boot does that (ADR 0027), and a control on this surface would promise
 * something no route could keep.
 *
 * The **write** is a server route, like a group's label catalog: a browser may
 * not write the Master's app folder itself, so a correction and a removal are
 * made here, in the store, against the reading this request took
 * (`agent/memory.ts`). What a person writes is a **person's fact** from that
 * moment: the agent's own write cannot overwrite it, and what it concludes
 * instead is kept beside it as a **proposal** a person accepts or dismisses
 * (ADR 0033), which is what makes a correction something the agent reasons from
 * rather than something it silently corrects on the next pass.
 */

import type { Hono } from "hono";
import { RUNS_ARCHIVE_DIR } from "../agent/archive.js";
import { readClaim } from "../agent/claim.js";
import { readInstruction } from "../agent/instruction.js";
import {
  correctFactByPerson,
  dismissProposal,
  forgetFact,
  listFacts,
  MemoryError,
} from "../agent/memory.js";
import { probeModel, runningModelAccess } from "../agent/model.js";
import { parseRuleDocumentDetailed } from "../agent/rule.js";
import { createRule, deleteRule, listRules, replaceRule } from "../agent/rules.js";
import {
  listRunsForReading,
  RUNS_DIR,
  readRun,
  readRunAt,
  replaceRun,
} from "../agent/runs.js";
import { AGENT_PASS_INTERVAL_MS } from "../agent/supervisor.js";
import { readAgentSwitch, writeAgentSwitch } from "../agent/switch.js";
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
  readAppFileAt,
  writeAppFileAt,
} from "../appFolder.js";
import { masterAddress } from "../config.js";
import {
  GroupAccessError,
  memberGroupAccess,
  openAgentSession,
  resolveGroupAccess,
} from "../groupAccess.js";
import { WRITE_ATTEMPTS } from "../jmap.js";
import type { LiveSession } from "../sessions.js";
import {
  type AgentStatus,
  isClaimDoc,
  isPassStatusDoc,
  PASS_STATUS_FILE,
  type PassStatusDoc,
} from "../shared/agent.js";
import {
  addMetrics,
  emptyMetrics,
  metricsOf,
  type RunMetrics,
} from "../shared/agentMetrics.js";
import { isStateMismatch } from "../shared/errors.js";
import {
  INSTRUCTION_FILE,
  INSTRUCTION_VERSION,
  parseInstructionDocumentDetailed,
} from "../shared/instruction.js";
import { RULES_DIR, RuleError } from "../shared/rule.js";
import type { RunDoc, RunSummary } from "../shared/run.js";
import { finishRun, summarizeRun } from "../shared/run.js";
import {
  type Env,
  failureFor,
  groupAccessFailure,
  groupDenial,
  readJson,
  requireAdmin,
  requireSession,
} from "./shared.js";

/** The most runs one group-wide Stop closes, so its answer fits the browser's deadline. */
const STOP_ALL_MAX = 20;

/** The answer to a fact this surface could not read or write, or upstream's. */
const memoryFailure = failureFor(MemoryError);

/**
 * Stop one run, whatever it is doing — working, or waiting on a person's answer.
 *
 * Stopping is the race the run documents exist for: the pass records a step of
 * the same run while a person presses Stop. A lost compare-and-set is retried on
 * the document as it now stands — the same attempts every other writer makes —
 * and a stop that keeps losing answers `"moved"`, which the route turns into a
 * sentence that says the run is still in flight rather than an upstream error.
 * An already-ended run is handed back as it is: a second Stop is not an error.
 */
async function stopRun(
  ctx: Ctx,
  accountId: string,
  id: string,
  by: string,
): Promise<RunDoc | "not_found" | "moved"> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const record = await readRun(ctx, accountId, id);
    if (!record) return "not_found";
    if (record.run.state !== "running" && record.run.state !== "blocked")
      return record.run;
    const ended = finishRun(record.run, "cancelled", {
      at: new Date().toISOString(),
      why: `stopped by ${by}`,
    });
    try {
      await replaceRun(ctx, accountId, ended, { ifInState: record.state });
      return ended;
    } catch (err) {
      if (!isStateMismatch(err)) throw err;
    }
  }
  return "moved";
}

/**
 * The runs listing per account, reused while the account's FileNode state has
 * not moved.
 *
 * A surface that watches a run asks every few seconds. The folder walk is the
 * cost, not the answer: the state token is one read, and a listing that nothing
 * changed under is the same list. A write anywhere in the account moves the
 * token, which is what makes the next ask a fresh walk.
 */
/*
 * The TTL is the backstop for a state change this process did not see, so it
 * sits above the slowest poll (the runs surface watches every ten seconds):
 * equal to it, the entry expired just before every ask and the walk ran anyway.
 */
const RUNS_READING_TTL_MS = 30_000;
/** How many archived runs one answer carries; the month can hold many. */
const ARCHIVE_PAGE = 100;
const runsReadings = new Map<string, { state: string; rows: RunSummary[]; at: number }>();

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
  const proseFailure = (c: Parameters<typeof groupDenial>[0], err: unknown) => {
    if (isStateMismatch(err))
      return c.json(
        {
          error: "prose_moved",
          message:
            "The group's prose changed while this was being written, so nothing was saved.",
        },
        409,
      );
    /*
     * A rule name the document model refuses is the caller's to fix: its own
     * sentence and its own status, not the upstream 502 every unmatched error
     * becomes.
     */
    if (err instanceof RuleError)
      return c.json({ error: err.code, message: err.message }, err.status as 400);
    return doorFailure(c, err);
  };

  /**
   * Where the installation's agent is.
   *
   * The claim, and the interval the supervisor asks for a pass on — the two facts
   * about the process that live in no document the browser can reach on its own.
   * **A claim that is stored but past its expiry is no claim**: that instant
   * means one thing (ADR 0032), and answering with a lapsed holder would report
   * an agent working an installation that no agent is working.
   *
   * The model is deliberately not answered here: it is the installation's own
   * document, and the surface **links** to the section that chooses it rather
   * than keeping a second copy of fields edited there (ADR 0009, ADR 0027).
   */
  api.get("/admin/agent", requireSession, requireAdmin, async (c) => {
    try {
      const ctx = await masterCtx(c.get("session"));
      const stored = await readClaim(ctx);
      /*
       * The last pass is read beside the claim and answers the same question
       * about the process itself: whether the pump is turning. A document this
       * build cannot read is `null` — the claim's own sentence — rather than a
       * refusal that would hide the agent's state with it.
       */
      let lastPass: PassStatusDoc | null = null;
      try {
        const found = await readAppFileAt(ctx, filesAccountId(ctx), PASS_STATUS_FILE);
        const parsed = found ? (JSON.parse(found.text) as unknown) : null;
        if (isPassStatusDoc(parsed)) lastPass = parsed;
      } catch {
        lastPass = null;
      }
      const agent: AgentStatus = {
        claim:
          stored && isClaimDoc(stored) && Date.parse(stored.expires) > Date.now()
            ? stored
            : null,
        passSeconds: Math.round(AGENT_PASS_INTERVAL_MS / 1000),
        lastPass,
      };
      return c.json({ agent });
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  /**
   * What the groups' runs spent, over the window the reader chose.
   *
   * The Administration page drew these numbers from every run of every group,
   * downloaded every sixty seconds. The tally is one definition both tiers read
   * (`@gilbert/shared/agentMetrics`), and the server walks a group's runs here:
   * the answer is a few numbers, not a year of documents. `since` is the
   * reader's own first instant, computed in their clock (`periodSince`), so a
   * day in the page's time zone is a day here.
   */
  api.get("/admin/agent/metrics", requireSession, requireAdmin, async (c) => {
    try {
      const raw = c.req.query("since") ?? "";
      const since = raw ? new Date(raw) : undefined;
      if (since && Number.isNaN(since.getTime()))
        return c.json(
          { error: "bad_request", message: "since is an ISO 8601 instant" },
          400,
        );
      const names = (c.req.query("groups") ?? "")
        .split(",")
        .map((one) => one.trim())
        .filter(Boolean);
      const groups: Array<{ name: string; metrics: RunMetrics }> = [];
      for (const name of names) {
        const access = await resolveGroupAccess(c.get("session"), name, {
          need: "agent documents",
        });
        if (!access.ok) continue;
        const rows = (await listRunsForReading(access.ctx, access.accountId)).map(
          summarizeRun,
        );
        groups.push({ name, metrics: metricsOf(rows, since) });
      }
      const total = groups.reduce(
        (sum, one) => addMetrics(sum, one.metrics),
        emptyMetrics(),
      );
      return c.json({ groups, total });
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  /**
   * The runs a group has worked, each as the record carries it.
   *
   * The run document is the product (ADR 0030): this answers the documents as
   * they are stored, and the surface draws them — what woke the run, the rule or
   * the instruction that answered, every step with what it waited on and how it
   * left, the tally, and where it parked and why. A document this build cannot
   * read is **said** in the listing rather than dropped: one run written by
   * another build must not take the rest off the screen, and must never be drawn
   * as an empty run.
   */
  /** Whether the installation's agent is on, as the switch document says. */
  api.get("/admin/agent/switch", requireSession, requireAdmin, async (c) => {
    try {
      const ctx = await masterCtx(c.get("session"));
      return c.json(await readAgentSwitch(ctx, filesAccountId(ctx)));
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  /** Turn the installation's agent on or off; the next pass obeys it. */
  api.put("/admin/agent/switch", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ enabled?: unknown }>(c);
    if (typeof body?.enabled !== "boolean")
      return c.json(
        { error: "bad_request", message: "the switch takes true or false" },
        400,
      );
    try {
      const ctx = await masterCtx(c.get("session"));
      await writeAgentSwitch(ctx, filesAccountId(ctx), body.enabled);
      return c.json({ enabled: body.enabled });
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  /**
   * Whether the model this process runs on can be reached, and with this key.
   * A probe, not a stored state: the answer is what the provider says now.
   */
  api.get("/admin/agent/model", requireSession, requireAdmin, async (c) => {
    const access = runningModelAccess();
    if (!access) return c.json({ ok: false, reason: "no_model" });
    return c.json(await probeModel(access));
  });

  /**
   * Stop a run (ADR 0030, the fourth ending): the document is ended as
   * `cancelled`, and the pass that was working it sees the state on its next
   * write and leaves it exactly so.
   *
   * The gate is the member's own grant on this group, not the administrator's:
   * a person in the group sees and stops its runs, and a group they are not in
   * is refused like any name they cannot see.
   */
  api.post("/groups/:name/runs/:id/stop", requireSession, async (c) => {
    const name = c.req.param("name") ?? "";
    const id = c.req.param("id") ?? "";
    try {
      const access = await memberGroupAccess(c.get("session"), name, {
        need: "agent documents",
      });
      if (!access.ok) return groupDenial(c, access);
      const stopped = await stopRun(
        access.ctx,
        access.accountId,
        id,
        c.get("session").username,
      );
      if (stopped === "not_found") return c.json({ error: "not_found" }, 404);
      if (stopped === "moved")
        return c.json(
          {
            error: "run_moved",
            message:
              "The run moved while it was being stopped, so it is still in flight. Try again.",
          },
          409,
        );
      return c.json({ run: stopped });
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  /**
   * Stop every run in flight in a group: the ones working, and the ones waiting
   * on a person's answer.
   *
   * A run parked on a question is still in flight — nothing will move it but an
   * answer — and a person who wants the group's agent to stop must not have to
   * press Stop once per run. The gate is the same member grant as the single
   * stop, and a run that moved under this pass is retried inside `stopRun` like
   * any other write.
   */
  api.post("/groups/:name/runs/stop", requireSession, async (c) => {
    const name = c.req.param("name") ?? "";
    try {
      const access = await memberGroupAccess(c.get("session"), name, {
        need: "agent documents",
      });
      if (!access.ok) return groupDenial(c, access);
      const rows = await listRunsForReading(access.ctx, access.accountId);
      const inFlight = rows
        .map((row) => row.run)
        .filter(
          (run): run is RunDoc =>
            Boolean(run) && (run!.state === "running" || run!.state === "blocked"),
        );
      /*
       * A sweep has a ceiling, and it is the browser's: one press must answer
       * inside the client's own deadline, and each run is a read and a
       * conditional write. A group with more runs in flight than this keeps the
       * rest, and the answer says how many are still moving rather than closing
       * the page on a promise.
       */
      const runs: string[] = [];
      for (const run of inFlight.slice(0, STOP_ALL_MAX)) {
        const result = await stopRun(
          access.ctx,
          access.accountId,
          run.id,
          c.get("session").username,
        );
        // The listing was read before the writes: a run that ended between them
        // is handed back as it is, and is not one this request stopped.
        if (result === "not_found" || result === "moved") continue;
        if (result.state === "cancelled") runs.push(run.id);
      }
      /*
       * Read again rather than counted: a run can move under a sweep, and "left"
       * is what a person sees if they look, so it is asked of the documents.
       */
      const after = await listRunsForReading(access.ctx, access.accountId);
      const left = after.filter(
        (row) => row.run && (row.run.state === "running" || row.run.state === "blocked"),
      ).length;
      return c.json({ stopped: runs.length, runs, left });
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  api.get("/groups/:name/runs", requireSession, async (c) => {
    const name = c.req.param("name") ?? "";
    const state = c.req.query("state");
    if (state !== undefined && state !== "running" && state !== "live")
      return c.json(
        { error: "bad_request", message: 'state is "running", "live" or absent' },
        400,
      );
    try {
      const access = await memberGroupAccess(c.get("session"), name, {
        need: "agent documents",
      });
      if (!access.ok) return groupDenial(c, access);
      const token = await appFolderState(access.ctx, access.accountId);
      const held = runsReadings.get(access.accountId);
      const fresh =
        held !== undefined &&
        held.state === token &&
        Date.now() - held.at < RUNS_READING_TTL_MS;
      const rows: RunSummary[] = fresh
        ? held.rows
        : (await listRunsForReading(access.ctx, access.accountId)).map(summarizeRun);
      if (!fresh)
        runsReadings.set(access.accountId, {
          state: token,
          rows,
          at: Date.now(),
        });
      /*
       * A surface that watches a run needs the runs in flight, not the history:
       * `?state=running` answers those alone, so a poll every few seconds does
       * not carry a year of documents with it. The rest is a page: the panel
       * draws ten rows and the history grows with the installation, so the
       * server sends the rows asked for and says whether more follow.
       */
      const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
      if (!Number.isInteger(offset) || offset < 0 || offset > 10_000_000)
        return c.json({ error: "bad_request", message: "offset is a whole number" }, 400);
      const asked = Number.parseInt(c.req.query("limit") ?? "", 10);
      const limit = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 1000) : 100;
      const filtered =
        state === "running"
          ? rows.filter((one) => one.state === "running")
          : state === "live"
            ? // The runs a person is watching for: working, and waiting on a
              // person's answer — both will move again without anyone opening a
              // page, so the overview lists them together.
              rows.filter((one) => one.state === "running" || one.state === "blocked")
            : rows;
      const page = filtered.slice(offset, offset + limit);
      return c.json({
        group: name,
        runs: page,
        more: offset + page.length < filtered.length,
      });
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  /**
   * A month of the archive, as the same record a run document is.
   *
   * The archive is storage for the record, not a deletion: a member reads the
   * month by the same gate as the working set, and the month is validated before
   * it becomes a path.
   */
  api.get("/groups/:name/runs/archive", requireSession, async (c) => {
    const name = c.req.param("name") ?? "";
    const month = c.req.query("month") ?? "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      return c.json({ error: "bad_request", message: "month is YYYY-MM" }, 400);
    /*
     * A cursor, not an offset: the drawer is filled while a person reads it
     * (the archiver moves one run a pass), and an offset over a list that
     * mutates repeats or skips a row at a page boundary. `after` is the last
     * row the reader was given, as `when|id` — the same total order the sort
     * below uses.
     */
    const after = c.req.query("after") ?? "";
    try {
      const access = await memberGroupAccess(c.get("session"), name, {
        need: "agent documents",
      });
      if (!access.ok) return groupDenial(c, access);
      const all = (
        await listRunsForReading(
          access.ctx,
          access.accountId,
          `${RUNS_ARCHIVE_DIR}/${month}`,
        )
      )
        .map(summarizeRun)
        .sort((a, b) => {
          const when = (one: RunSummary) => one.startedAt ?? one.ended?.at ?? "";
          return when(b).localeCompare(when(a)) || a.id.localeCompare(b.id);
        });
      const cursor = (one: RunSummary): string =>
        `${one.startedAt ?? one.ended?.at ?? ""}|${one.id}`;
      const at = after ? all.findIndex((one) => cursor(one) === after) : -1;
      const start = at >= 0 ? at + 1 : 0;
      const runs = all.slice(start, start + ARCHIVE_PAGE);
      return c.json({
        group: name,
        month,
        runs,
        more: start + runs.length < all.length,
        /** The last row drawn: the next page asks after it. */
        after: runs.length ? cursor(runs[runs.length - 1] as RunSummary) : null,
      });
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  /**
   * One run whole, by the id its row carries.
   *
   * The list is a header; this is the record behind it, read when a person
   * opens the row. An archived run is named by the month its drawer holds.
   */
  api.get("/groups/:name/runs/:id", requireSession, async (c) => {
    const name = c.req.param("name") ?? "";
    const month = c.req.query("month");
    if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      return c.json({ error: "bad_request", message: "month is YYYY-MM" }, 400);
    try {
      const access = await memberGroupAccess(c.get("session"), name, {
        need: "agent documents",
      });
      if (!access.ok) return groupDenial(c, access);
      const dir = month ? `${RUNS_ARCHIVE_DIR}/${month}` : RUNS_DIR;
      const id = c.req.param("id") ?? "";
      const run = await readRunAt(access.ctx, access.accountId, dir, id);
      if (!run) return c.json({ error: "not_found" }, 404);
      return c.json({ group: name, run });
    } catch (err) {
      return doorFailure(c, err);
    }
  });

  /**
   * A group's prose — its standing instruction and its rules (ADR 0031).
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
        const body = await readJson<{
          rule?: unknown;
          ifInState?: unknown;
          create?: unknown;
        }>(c);
        const parsed = parseRuleDocumentDetailed(JSON.stringify(body?.rule));
        if ("problem" in parsed) return c.json({ error: parsed.problem }, 400);
        if (parsed.rule.id !== id)
          return c.json(
            { error: `The rule says "${parsed.rule.id}" but the route files "${id}".` },
            400,
          );
        /*
         * A create is a create: the editor says so for a rule it is making, and
         * a name that slugs to one already filed is refused rather than
         * replacing that rule's prose in silence. An edit keeps the id it was
         * opened with, so it is a replace.
         */
        if (body?.create === true) {
          await createRule(access.ctx, access.accountId, parsed.rule);
          return c.json({ ok: true, rule: parsed.rule });
        }
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
   * The installation's memory: every fact the agent reasons from (ADR 0033).
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
      const { facts, problems } = await listFacts(ctx, memoryAccount(ctx));
      /*
       * A page, not the whole graph: a memory of thousands of sheets is
       * megabytes, and the surface draws a list a person scrolls. The order is
       * the reader's own (subject, then id), and `after` is the last id that
       * page carried. A cursor naming a sheet that has gone starts from the top
       * rather than silently skipping what now sorts after it.
       */
      const after = c.req.query("after") ?? "";
      const asked = Number.parseInt(c.req.query("limit") ?? "", 10);
      const limit = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 500) : 200;
      const ordered = [...facts].sort(
        (a, b) =>
          a.subject.localeCompare(b.subject, "en") || a.id.localeCompare(b.id, "en"),
      );
      const at = after ? ordered.findIndex((fact) => fact.id === after) : -1;
      const start = at >= 0 ? at + 1 : 0;
      const page = ordered.slice(start, start + limit);
      // A sheet this build cannot read is said, not hidden: the surface shows it
      // beside the facts instead of empty space nobody can explain.
      return c.json({
        facts: page,
        problems,
        total: ordered.length,
        more: start + page.length < ordered.length,
      });
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
   * Dismiss the agent's proposal against a person's fact (ADR 0033).
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
