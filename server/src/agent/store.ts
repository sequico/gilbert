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
  AGENT_CLAIMS_DIR,
  AGENT_CONFIG_FILE,
  AGENT_DECISIONS_DIR,
  AGENT_DIR,
  AGENT_INSTRUCTION_FILE,
  AGENT_JOBS_DIR,
  AGENT_RULES_FILE,
  AGENT_SCHEDULE_FILE,
  AGENT_STREAM_FILE,
  AGENT_WORKERS_DIR,
  type AgentArea,
  type AgentAuditDoc,
  type AgentAuditEntry,
  type AgentClaim,
  type AgentConfigDoc,
  type AgentDecision,
  type AgentInstructionDoc,
  type AgentJob,
  type AgentRule,
  type AgentRulesDoc,
  type AgentScheduleDoc,
  type AgentScheduleEntry,
  type AgentStreamClaim,
  type AgentWorkerRecord,
  agentDocName,
  auditDocName,
  claimDocName,
  isAgentAuditDoc,
  isAgentClaim,
  isAgentConfigDoc,
  isAgentDecision,
  isAgentInstructionDoc,
  isAgentJob,
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
    for (const dir of [
      AGENT_JOBS_DIR,
      AGENT_DECISIONS_DIR,
      AGENT_CLAIMS_DIR,
      AGENT_AUDIT_DIR,
    ]) {
      await ensureFolderPath(this.ctx, this.accountId, this.path(dir));
    }
  }

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

  async readRules(): Promise<AgentDoc<AgentRule[]> | null> {
    const found = await this.readDoc<AgentRulesDoc>(
      this.path(AGENT_RULES_FILE),
      isAgentRulesDoc,
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
  ): Promise<AgentInstructionDoc> {
    const doc: AgentInstructionDoc = {
      v: 1,
      text,
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

  /* ---------------- claims (group account) ---------------- */

  async readClaim(area: AgentArea): Promise<AgentDoc<AgentClaim> | null> {
    return this.readDoc<AgentClaim>(
      this.path(AGENT_CLAIMS_DIR, claimDocName(area)),
      isAgentClaim,
    );
  }

  async listClaims(): Promise<Array<AgentDoc<AgentClaim>>> {
    return this.listDocs<AgentClaim>(this.path(AGENT_CLAIMS_DIR), isAgentClaim);
  }

  async writeClaim(claim: AgentClaim, opts: { ifInState?: string } = {}): Promise<void> {
    await writeAppFileAt(
      this.ctx,
      this.accountId,
      this.path(AGENT_CLAIMS_DIR, claimDocName(claim.area)),
      claim,
      opts,
    );
  }

  async destroyClaim(area: AgentArea, opts: { ifInState?: string } = {}): Promise<void> {
    await this.destroyDoc(this.path(AGENT_CLAIMS_DIR, claimDocName(area)), opts);
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
