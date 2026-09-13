/**
 * The agent's documents in Stalwart — read, write, claim.
 *
 * ADR 0003 puts every durable byte of the fleet in the group's own account
 * (rules, jobs, decisions, claims, schedule, audit) and the installation-wide
 * facts in the agent's own account (configuration, the stream claim, worker
 * heartbeats). This class is the one place those documents are addressed:
 * one path per document, one validator per shape, one conditional write.
 *
 * Concurrency has no lock to take — JMAP offers none — so every write that
 * must not lose a race passes the FileNode state it read as `ifInState`, and
 * the server refuses the write when anything in the account changed since.
 * That is the whole coordination model: documents plus compare-and-set
 * (ADR 0003 §6).
 */

import {
  appFolderState,
  type Ctx,
  destroyAppNode,
  ensureFolderPath,
  findAppFileAt,
  listAppDir,
  readAppJsonAt,
  writeAppFileAt,
} from "../appFolder.js";
import { isStateMismatch } from "../jmap.js";
import {
  AGENT_AUDIT_DIR,
  AGENT_AUTHORING_DIR,
  AGENT_CLAIM_FILE,
  AGENT_CONFIG_FILE,
  AGENT_DECISIONS_DIR,
  AGENT_DIR,
  AGENT_INSTRUCTION_FILE,
  AGENT_JOBS_DIR,
  AGENT_NOTEBOOK_FILE,
  AGENT_RULES_FILE,
  AGENT_SCHEDULE_FILE,
  AGENT_STREAM_FILE,
  AGENT_WORKERS_DIR,
  type AgentAuditDoc,
  type AgentAuditEntry,
  type AgentAuthoringDoc,
  type AgentAuthoringEntry,
  type AgentClaim,
  type AgentConfigDoc,
  type AgentDecision,
  type AgentInstructionDoc,
  type AgentJob,
  type AgentNotebookDoc,
  type AgentNotebookFact,
  type AgentRule,
  type AgentRulesDoc,
  type AgentScheduleDoc,
  type AgentScheduleEntry,
  type AgentStreamClaim,
  type AgentUsage,
  type AgentWorkerRecord,
  agentDocName,
  auditDocName,
  isAgentAuditDoc,
  isAgentAuthoringDoc,
  isAgentClaim,
  isAgentConfigDoc,
  isAgentDecision,
  isAgentInstructionDoc,
  isAgentJob,
  isAgentNotebookDoc,
  isAgentRulesDoc,
  isAgentScheduleDoc,
  isAgentStreamClaim,
  isAgentWorkerRecord,
  monthOf,
} from "./documents.js";

/** A document together with the state its read saw, for a conditional write. */
export interface AgentDoc<T> {
  doc: T;
  /** The FileNode state at read time: pass it as `ifInState` to write safely. */
  state: string;
}

/**
 * A document that is there and does not read as its shape.
 *
 * The readers that cannot work without a document raise this rather than answer
 * `null`, because for them "nothing is there" and "something is there that is
 * not this document" are opposite answers: the first is an account with no
 * automation, or a unit nobody holds, and the second is every automation of the
 * group stopped — or a live claim that must not be taken for a free one (see
 * `readDocChecked`). The type is what lets a caller tell an unreadable document
 * from a store that could not answer at all.
 */
export class UnreadableDocumentError extends Error {
  constructor(
    readonly path: string,
    what: string,
  ) {
    super(
      `the document ${path} is there but does not read as ${what}; ` +
        `refusing to report it as absent`,
    );
    this.name = "UnreadableDocumentError";
  }
}

/**
 * How many times the audit's append retries, with a pause and jitter between
 * tries.
 *
 * More than the ordinary four attempts, because the state it compares against is the whole
 * account's (`appFolderState`), so a write that has nothing to do with the
 * audit invalidates it just as well; and a pause, because four attempts
 * back-to-back all land inside the same collision they just lost to.
 */
const AUDIT_CAS_ATTEMPTS = 6;

function backoffMs(attempt: number): number {
  const base = Math.min(400, 25 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Audit entries that could not be written, per account, until the next try.
 *
 * In memory, deliberately: the alternative to holding a line in the process is
 * losing it, and a restart costs the queue while the documents the line
 * describes are durable anyway (ADR 0003 resolution 20 records the limit).
 * Bounded, because a queue that grows without limit in a process that cannot
 * write is a memory leak that hides its own cause.
 */
const PENDING_AUDITS = new Map<string, AgentAuditEntry[]>();
const PENDING_AUDIT_LIMIT = 100;

function pendingAudits(accountId: string): AgentAuditEntry[] {
  return PENDING_AUDITS.get(accountId) ?? [];
}

function setPendingAudits(accountId: string, entries: AgentAuditEntry[]): void {
  if (entries.length) PENDING_AUDITS.set(accountId, entries);
  else PENDING_AUDITS.delete(accountId);
}

function queuePendingAudit(accountId: string, entry: AgentAuditEntry): void {
  const queued = [...pendingAudits(accountId), entry];
  const kept = queued.slice(-PENDING_AUDIT_LIMIT);
  if (kept.length < queued.length) {
    console.warn(
      `[gilbert] ${accountId}: dropped ${queued.length - kept.length} audit entr(ies), ` +
        `${PENDING_AUDIT_LIMIT} already waiting to be written`,
    );
  }
  setPendingAudits(accountId, kept);
}

/** How many audit entries this account is holding back for a later attempt. */
export function pendingAuditCount(accountId: string): number {
  return pendingAudits(accountId).length;
}

/**
 * The documents of one account. Construct it for the group's account to work
 * on a group's rules and jobs, or for the agent's own account for its
 * configuration and heartbeats — the folder layout is the same either way.
 */
export class AgentStore {
  constructor(
    private readonly ctx: Ctx,
    readonly accountId: string,
  ) {}

  private path(...segments: string[]): string {
    return [AGENT_DIR, ...segments].join("/");
  }

  /** The FileNode state of the account: the token a conditional write takes. */
  async state(): Promise<string> {
    return appFolderState(this.ctx, this.accountId);
  }

  /**
   * Create the folder tree the agent's documents live in, once per account.
   *
   * Worth calling when a worker takes an account rather than leaving it to
   * the first write: creating a folder moves the account's FileNode state, so
   * a conditional write that had read the state before the folder existed
   * loses its compare-and-set for a reason that has nothing to do with the
   * document it is writing. Doing it up front makes every later lease and job
   * update a clean one. Idempotent — an account that already has them pays a
   * read.
   */
  async provision(): Promise<void> {
    for (const dir of [AGENT_JOBS_DIR, AGENT_DECISIONS_DIR, AGENT_AUDIT_DIR]) {
      await ensureFolderPath(this.ctx, this.accountId, this.path(dir));
    }
  }

  /**
   * A document, `null` meaning "nothing at this path **or** something that does
   * not read as this document". That is the answer for a caller that works on
   * what it can read and nothing else — a listed record it cannot parse is one
   * it does not act on — and it is the wrong answer wherever the two mean
   * opposite things: those readers use `readDocChecked`.
   */
  private async readDoc<T>(
    path: string,
    valid: (x: unknown) => x is T,
  ): Promise<AgentDoc<T> | null> {
    // The state is read before the document: a state newer than the data
    // would let a conditional write pass while the data is already stale.
    const state = await this.state();
    const raw = await readAppJsonAt(this.ctx, this.accountId, path);
    if (raw === null || !valid(raw)) return null;
    return { doc: raw, state };
  }

  /**
   * A document, with "nothing is at this path" told apart from "something is
   * there that is not this document".
   *
   * Missing is an empty account and unreadable is a fault, and for the rules and
   * the claim the two are opposites. No rules document is a group with no
   * automation; a rules document nobody can read is every automation of the
   * group stopped, and a reader that reported the second as the first would stop
   * the group's work with nothing anywhere saying so. The claim is sharper
   * still: a claim read as absent is a unit nobody holds, so the next worker
   * takes it and writes `epoch: 0` over an ownership it could not read — the
   * fence of the run that still holds it stops matching. `readAudit` raises for
   * the same reason, and this is the same answer for the documents whose callers
   * record what they could not read instead of carrying on.
   */
  private async readDocChecked<T>(
    path: string,
    valid: (x: unknown) => x is T,
    what: string,
  ): Promise<AgentDoc<T> | null> {
    const state = await this.state();
    const raw = await readAppJsonAt(this.ctx, this.accountId, path);
    if (raw === null) return null;
    if (!valid(raw)) throw new UnreadableDocumentError(path, what);
    return { doc: raw, state };
  }

  private async listDocs<T>(
    dir: string,
    valid: (x: unknown) => x is T,
  ): Promise<Array<AgentDoc<T>>> {
    const nodes = await listAppDir(this.ctx, this.accountId, dir);
    const out: Array<AgentDoc<T>> = [];
    for (const node of nodes) {
      if (node.nodeType !== "file" || typeof node.name !== "string") continue;
      const found = await this.readDoc(`${dir}/${node.name}`, valid);
      if (found) out.push(found);
    }
    return out;
  }

  /**
   * Remove a document by path. Absent is success.
   *
   * `ifInState` makes the removal conditional on the state the caller decided
   * against: a caller removing something it must still own — a claim above all
   * — passes the state it read, and a mismatch throws, so the removal never
   * lands on a node somebody else has replaced.
   */
  private async destroyDoc(
    path: string,
    opts: { ifInState?: string } = {},
  ): Promise<void> {
    const { file } = await findAppFileAt(this.ctx, this.accountId, path);
    if (!file?.id) return;
    await destroyAppNode(this.ctx, this.accountId, String(file.id), opts);
  }

  /* ---------------- rules (group account) ---------------- */

  /**
   * The group's rules, raising when the document is there and does not read.
   *
   * "No rules" and "rules nobody can read" are opposite answers
   * (`readDocChecked`), and the callers that must act on the difference — the
   * pending sweep and the reconcile — record this instead of taking the group
   * for one with no automation.
   */
  async readRules(): Promise<AgentDoc<AgentRule[]> | null> {
    const found = await this.readDocChecked<AgentRulesDoc>(
      this.path(AGENT_RULES_FILE),
      isAgentRulesDoc,
      "a rules document",
    );
    return found ? { doc: found.doc.rules, state: found.state } : null;
  }

  /* ---------------- the group's standing instruction ---------------- */

  async readInstruction(): Promise<AgentDoc<AgentInstructionDoc> | null> {
    return this.readDoc<AgentInstructionDoc>(
      this.path(AGENT_INSTRUCTION_FILE),
      isAgentInstructionDoc,
    );
  }

  async writeInstruction(
    text: string,
    by: string,
    opts: { ifInState?: string } = {},
    notes?: string,
  ): Promise<AgentInstructionDoc> {
    const trimmed = (notes ?? "").trim();
    const doc: AgentInstructionDoc = {
      v: 1,
      text,
      // The author's remarks ride the document and never the prompt: an empty
      // note is no note at all, so the field is absent rather than empty.
      ...(trimmed ? { notes: trimmed } : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: by,
    };
    await writeAppFileAt(
      this.ctx,
      this.accountId,
      this.path(AGENT_INSTRUCTION_FILE),
      doc,
      opts,
    );
    return doc;
  }

  /* ---------------- the group's notebook ---------------- */

  async readNotebook(): Promise<AgentDoc<AgentNotebookDoc> | null> {
    return this.readDoc<AgentNotebookDoc>(
      this.path(AGENT_NOTEBOOK_FILE),
      isAgentNotebookDoc,
    );
  }

  /**
   * Write the group's notebook.
   *
   * The whole list goes at once: the surface reads the facts, changes one, and
   * writes them back, and the document is the group's own — so a lost race is a
   * lost race, and the surface re-reads rather than merging behind a person's
   * back.
   */
  async writeNotebook(
    facts: ReadonlyArray<AgentNotebookFact>,
    by: string,
    opts: { ifInState?: string } = {},
  ): Promise<AgentNotebookDoc> {
    const doc: AgentNotebookDoc = {
      v: 1,
      facts: [...facts],
      updatedAt: new Date().toISOString(),
      updatedBy: by,
    };
    await writeAppFileAt(
      this.ctx,
      this.accountId,
      this.path(AGENT_NOTEBOOK_FILE),
      doc,
      opts,
    );
    return doc;
  }

  /** Remove the group's standing instruction. Absent is success. */
  async removeInstruction(): Promise<void> {
    await this.destroyDoc(this.path(AGENT_INSTRUCTION_FILE));
  }

  async writeRules(rules: AgentRule[], opts: { ifInState?: string } = {}): Promise<void> {
    const doc: AgentRulesDoc = { v: 1, rules };
    await writeAppFileAt(
      this.ctx,
      this.accountId,
      this.path(AGENT_RULES_FILE),
      doc,
      opts,
    );
  }

  /* ---------------- schedule (group account) ---------------- */

  async readSchedule(): Promise<AgentDoc<AgentScheduleEntry[]> | null> {
    const found = await this.readDoc<AgentScheduleDoc>(
      this.path(AGENT_SCHEDULE_FILE),
      isAgentScheduleDoc,
    );
    return found ? { doc: found.doc.entries, state: found.state } : null;
  }

  async writeSchedule(
    entries: AgentScheduleEntry[],
    opts: { ifInState?: string } = {},
  ): Promise<void> {
    const doc: AgentScheduleDoc = { v: 1, entries };
    await writeAppFileAt(
      this.ctx,
      this.accountId,
      this.path(AGENT_SCHEDULE_FILE),
      doc,
      opts,
    );
  }

  /* ---------------- configuration (agent account) ---------------- */

  async readConfig(): Promise<AgentDoc<AgentConfigDoc> | null> {
    return this.readDoc<AgentConfigDoc>(this.path(AGENT_CONFIG_FILE), isAgentConfigDoc);
  }

  async writeConfig(
    config: AgentConfigDoc,
    opts: { ifInState?: string } = {},
  ): Promise<void> {
    await writeAppFileAt(
      this.ctx,
      this.accountId,
      this.path(AGENT_CONFIG_FILE),
      config,
      opts,
    );
  }

  /* ---------------- the stream claim (agent account) ---------------- */

  async readStreamClaim(): Promise<AgentDoc<AgentStreamClaim> | null> {
    return this.readDoc<AgentStreamClaim>(
      this.path(AGENT_STREAM_FILE),
      isAgentStreamClaim,
    );
  }

  async writeStreamClaim(
    claim: AgentStreamClaim,
    opts: { ifInState?: string } = {},
  ): Promise<void> {
    await writeAppFileAt(
      this.ctx,
      this.accountId,
      this.path(AGENT_STREAM_FILE),
      claim,
      opts,
    );
  }

  async destroyStreamClaim(opts: { ifInState?: string } = {}): Promise<void> {
    await this.destroyDoc(this.path(AGENT_STREAM_FILE), opts);
  }

  /* ---------------- claim (group account) ---------------- */

  /**
   * The account's claim, raising when the document is there and does not read.
   *
   * A claim nobody can read is not a free unit: `claimAccount` takes a missing
   * claim as its own to create, and treating an unreadable one the same way
   * would replace a live ownership with a new claim at `epoch: 0`, which is the
   * answer every fence of the run that holds it stops agreeing with (see
   * `readDocChecked`).
   */
  async readClaim(): Promise<AgentDoc<AgentClaim> | null> {
    return this.readDocChecked<AgentClaim>(
      this.path(AGENT_CLAIM_FILE),
      isAgentClaim,
      "a claim",
    );
  }

  async writeClaim(claim: AgentClaim, opts: { ifInState?: string } = {}): Promise<void> {
    await writeAppFileAt(
      this.ctx,
      this.accountId,
      this.path(AGENT_CLAIM_FILE),
      claim,
      opts,
    );
  }

  async destroyClaim(opts: { ifInState?: string } = {}): Promise<void> {
    await this.destroyDoc(this.path(AGENT_CLAIM_FILE), opts);
  }

  /* ---------------- jobs (group account) ---------------- */

  async listJobs(): Promise<Array<AgentDoc<AgentJob>>> {
    return this.listDocs<AgentJob>(this.path(AGENT_JOBS_DIR), isAgentJob);
  }

  async readJob(id: string): Promise<AgentDoc<AgentJob> | null> {
    return this.readDoc<AgentJob>(
      this.path(AGENT_JOBS_DIR, agentDocName(id)),
      isAgentJob,
    );
  }

  async writeJob(job: AgentJob, opts: { ifInState?: string } = {}): Promise<void> {
    await writeAppFileAt(
      this.ctx,
      this.accountId,
      this.path(AGENT_JOBS_DIR, agentDocName(job.id)),
      { ...job, updatedAt: new Date().toISOString() },
      opts,
    );
  }

  async destroyJob(id: string): Promise<void> {
    await this.destroyDoc(this.path(AGENT_JOBS_DIR, agentDocName(id)));
  }

  /* ---------------- decisions (group account) ---------------- */

  async listDecisions(): Promise<Array<AgentDoc<AgentDecision>>> {
    return this.listDocs<AgentDecision>(this.path(AGENT_DECISIONS_DIR), isAgentDecision);
  }

  async readDecision(id: string): Promise<AgentDoc<AgentDecision> | null> {
    return this.readDoc<AgentDecision>(
      this.path(AGENT_DECISIONS_DIR, agentDocName(id)),
      isAgentDecision,
    );
  }

  async writeDecision(
    decision: AgentDecision,
    opts: { ifInState?: string } = {},
  ): Promise<void> {
    await writeAppFileAt(
      this.ctx,
      this.accountId,
      this.path(AGENT_DECISIONS_DIR, agentDocName(decision.id)),
      { ...decision, updatedAt: new Date().toISOString() },
      opts,
    );
  }

  async destroyDecision(id: string): Promise<void> {
    await this.destroyDoc(this.path(AGENT_DECISIONS_DIR, agentDocName(id)));
  }

  /* ---------------- audit (group account) ---------------- */

  /**
   * The month's audit document.
   *
   * A document that is **there but does not read as an audit** is an error, not
   * an empty month: the trail is what an agent's work is answered from, and a
   * surface that shows "nothing happened" for a month nobody can read is
   * telling the wrong story about work that may well have happened. Missing
   * really is empty; unreadable is loud — the same line the writer already
   * holds.
   */
  async readAudit(month: string): Promise<AgentAuditDoc | null> {
    const path = this.path(AGENT_AUDIT_DIR, auditDocName(month));
    const raw = await readAppJsonAt(this.ctx, this.accountId, path);
    if (raw === null) return null;
    if (!isAgentAuditDoc(raw)) {
      throw new Error(
        `the audit document ${path} is there but does not read as an audit; ` +
          `refusing to report it as an empty month`,
      );
    }
    return raw;
  }

  /** The audit document for an instant's month. */
  async readAuditAt(at: Date): Promise<AgentAuditDoc | null> {
    return this.readAudit(monthOf(at));
  }

  /**
   * The month's authoring document, in the account that holds it.
   *
   * A document that is **there but does not read as one** is an error, not an
   * empty month, for the same reason the trail's is: replacing what an
   * installation spent with a count that lies about it is the one failure a
   * meter cannot have.
   */
  async readAuthoring(month: string): Promise<AgentAuthoringDoc | null> {
    const path = this.path(AGENT_AUTHORING_DIR, auditDocName(month));
    const raw = await readAppJsonAt(this.ctx, this.accountId, path);
    if (raw === null) return null;
    if (!isAgentAuthoringDoc(raw)) {
      throw new Error(
        `the authoring document ${path} is there but does not read as one; ` +
          `refusing to report it as an empty month`,
      );
    }
    return raw;
  }

  /**
   * Append one authoring call to the month's document.
   *
   * Simpler than the trail's append on purpose: a count that lost a race is
   * repaired by asking again, while a run's record is what a group's work is
   * answered from. Missing is empty, unreadable is loud, and a lost race is
   * retried the ordinary number of times before it fails in the open.
   */
  async appendAuthoring(entry: AgentAuthoringEntry, at = new Date()): Promise<void> {
    const month = monthOf(at);
    const path = this.path(AGENT_AUTHORING_DIR, auditDocName(month));
    for (let attempt = 0; attempt < AUDIT_CAS_ATTEMPTS; attempt++) {
      if (attempt) await sleep(backoffMs(attempt));
      const state = await this.state();
      const raw = await readAppJsonAt(this.ctx, this.accountId, path);
      if (raw !== null && !isAgentAuthoringDoc(raw)) {
        throw new Error(
          `the authoring document ${path} is there but does not read as one; ` +
            `refusing to write over it`,
        );
      }
      const doc: AgentAuthoringDoc = isAgentAuthoringDoc(raw)
        ? raw
        : { v: 1, month, entries: [] };
      doc.entries = [...doc.entries, entry];
      try {
        await writeAppFileAt(this.ctx, this.accountId, path, doc, { ifInState: state });
        return;
      } catch (err) {
        if (!isStateMismatch(err)) throw err;
      }
    }
    throw new Error(
      `the authoring document ${path} kept changing under the writer; ` +
        `the call is not counted`,
    );
  }

  /**
   * Reserve one authoring call against the month's ceiling, before the call is
   * paid for.
   *
   * The plain read-then-append `appendAuthoring` does after the call is what
   * let two overlapping readings each read "room under the ceiling" and both
   * spend: neither write disagreed with what it had read, so both landed.
   * Here the check and the write are the same compare-and-set attempt — on
   * every retry the ceiling is tested against the document as it now reads,
   * so a second caller that raced the first and lost re-reads a document that
   * already carries the first's reservation and is refused by the same rule
   * that would have refused a third call arriving after both had finished.
   * `token` names the reservation so the caller can settle it once the call
   * either answers (`finalizeAuthoring`) or never happens
   * (`cancelAuthoring`).
   */
  async reserveAuthoring(
    max: number,
    entry: { token: string; about: string; group?: string; by?: string },
    at = new Date(),
  ): Promise<boolean> {
    const month = monthOf(at);
    const path = this.path(AGENT_AUTHORING_DIR, auditDocName(month));
    for (let attempt = 0; attempt < AUDIT_CAS_ATTEMPTS; attempt++) {
      if (attempt) await sleep(backoffMs(attempt));
      const state = await this.state();
      const raw = await readAppJsonAt(this.ctx, this.accountId, path);
      if (raw !== null && !isAgentAuthoringDoc(raw)) {
        throw new Error(
          `the authoring document ${path} is there but does not read as one; ` +
            `refusing to write over it`,
        );
      }
      const doc: AgentAuthoringDoc = isAgentAuthoringDoc(raw)
        ? raw
        : { v: 1, month, entries: [] };
      if (doc.entries.length >= max) return false;
      doc.entries = [...doc.entries, { at: at.toISOString(), pending: true, ...entry }];
      try {
        await writeAppFileAt(this.ctx, this.accountId, path, doc, { ifInState: state });
        return true;
      } catch (err) {
        if (!isStateMismatch(err)) throw err;
      }
    }
    throw new Error(
      `the authoring document ${path} kept changing under the writer; ` +
        `the reservation could not be made`,
    );
  }

  /** Settle a reservation with the call's usage, once it has answered. */
  async finalizeAuthoring(
    token: string,
    usage: AgentUsage | undefined,
    at = new Date(),
  ): Promise<void> {
    await this.updateAuthoringEntry(token, at, (found) => {
      const { pending: _pending, ...rest } = found;
      return usage ? { ...rest, usage } : rest;
    });
  }

  /** Drop a reservation whose call never happened: it must not count. */
  async cancelAuthoring(token: string, at = new Date()): Promise<void> {
    await this.updateAuthoringEntry(token, at, () => null);
  }

  /**
   * Find the reservation by its token and replace or remove it, retrying
   * across the same contention `appendAuthoring` retries.
   *
   * Throws past the last attempt, the same as `appendAuthoring`: the call
   * this reservation stood for already happened (or was refused before it
   * did), so the caller decides how to answer the person waiting on it — the
   * ledger falling behind must not become their problem too.
   */
  private async updateAuthoringEntry(
    token: string,
    at: Date,
    change: (entry: AgentAuthoringEntry) => AgentAuthoringEntry | null,
  ): Promise<void> {
    const month = monthOf(at);
    const path = this.path(AGENT_AUTHORING_DIR, auditDocName(month));
    for (let attempt = 0; attempt < AUDIT_CAS_ATTEMPTS; attempt++) {
      if (attempt) await sleep(backoffMs(attempt));
      const state = await this.state();
      const raw = await readAppJsonAt(this.ctx, this.accountId, path);
      if (!isAgentAuthoringDoc(raw)) return;
      const idx = raw.entries.findIndex((entry) => entry.token === token);
      const current = idx < 0 ? undefined : raw.entries[idx];
      if (!current) return;
      const replaced = change(current);
      const doc: AgentAuthoringDoc = {
        ...raw,
        entries:
          replaced === null
            ? raw.entries.filter((_, i) => i !== idx)
            : raw.entries.map((entry, i) => (i === idx ? replaced : entry)),
      };
      try {
        await writeAppFileAt(this.ctx, this.accountId, path, doc, { ifInState: state });
        return;
      } catch (err) {
        if (!isStateMismatch(err)) throw err;
      }
    }
    throw new Error(
      `the authoring document ${path} kept changing under the writer; ` +
        `the reservation for ${token} could not be settled`,
    );
  }

  /**
   * Append one entry to the month's audit document.
   *
   * A read-modify-write against a shared document, where the shared state is
   * the **whole account's** FileNode state (JMAP offers no narrower one), so an
   * unrelated write — a file a member uploads, another document, the prune of
   * finished jobs in the same pass — invalidates it just as well. The audit is
   * the record an agent's work is answered from, so losing one is the failure
   * it must not have, and that costs three things here:
   *
   * - more than the ordinary four attempts, with a pause and jitter between
   *   them: four back-to-back retries all land inside the same collision;
   * - on a loss that survives them, the entry is **queued** (see
   *   `pendingAudits`) and the next write for this account tries it again;
   * - the queue is drained by the worker each pass, which also means an entry
   *   can be reported as pending rather than silently gone.
   *
   * What is not solved here is size: the document holds a whole month, so the
   * blob re-uploaded on every attempt, and the window with it, grow as the
   * month fills. That is recorded as a cost in ADR 0003 resolution 20.
   */
  async appendAudit(entry: AgentAuditEntry, at = new Date()): Promise<void> {
    const month = monthOf(at);
    const path = this.path(AGENT_AUDIT_DIR, auditDocName(month));
    await this.flushPendingAudits();
    if (await this.tryAppendAudit(entry, path, month)) return;
    queuePendingAudit(this.accountId, entry);
    throw new Error(
      `the audit document ${path} kept changing under the writer; ` +
        `the entry is held and retried on the next pass`,
    );
  }

  /** One entry, with the retries the shared state needs. False means give up. */
  private async tryAppendAudit(
    entry: AgentAuditEntry,
    path: string,
    month: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < AUDIT_CAS_ATTEMPTS; attempt++) {
      if (attempt) await sleep(backoffMs(attempt));
      const state = await this.state();
      const raw = await readAppJsonAt(this.ctx, this.accountId, path);
      // A document that is there but does not validate is **not** an empty
      // month. Treating it as one would replace a month of the trail with a
      // single entry — the one failure the audit cannot have. Missing is empty;
      // unreadable is loud, and a person decides what to do with it.
      if (raw !== null && !isAgentAuditDoc(raw)) {
        throw new Error(
          `the audit document ${path} is there but does not read as an audit; ` +
            `refusing to write over it`,
        );
      }
      const doc: AgentAuditDoc = isAgentAuditDoc(raw)
        ? raw
        : { v: 1, month, entries: [] };
      doc.entries = [...doc.entries, entry];
      try {
        await writeAppFileAt(this.ctx, this.accountId, path, doc, { ifInState: state });
        return true;
      } catch (err) {
        if (!isStateMismatch(err)) throw err;
      }
    }
    return false;
  }

  /**
   * Write the entries this account could not write earlier, oldest first.
   *
   * Entries that fail again stay queued. Returns how many are still waiting,
   * so the caller can say so instead of leaving the trail quietly short.
   */
  async flushPendingAudits(): Promise<number> {
    let waiting = pendingAudits(this.accountId);
    while (waiting.length) {
      const entry = waiting[0];
      if (!entry) break;
      const rest = waiting.slice(1);
      const month = monthOf(new Date(entry.at));
      const path = this.path(AGENT_AUDIT_DIR, auditDocName(month));
      if (!(await this.tryAppendAudit(entry, path, month))) return waiting.length;
      waiting = rest;
      setPendingAudits(this.accountId, rest);
    }
    return 0;
  }

  /* ---------------- workers (agent account) ---------------- */

  async listWorkers(): Promise<AgentWorkerRecord[]> {
    const found = await this.listDocs<AgentWorkerRecord>(
      this.path(AGENT_WORKERS_DIR),
      isAgentWorkerRecord,
    );
    return found.map((w) => w.doc);
  }

  async writeWorker(record: AgentWorkerRecord): Promise<void> {
    await writeAppFileAt(
      this.ctx,
      this.accountId,
      this.path(AGENT_WORKERS_DIR, agentDocName(record.id)),
      record,
    );
  }

  async destroyWorker(id: string): Promise<void> {
    await this.destroyDoc(this.path(AGENT_WORKERS_DIR, agentDocName(id)));
  }
}
