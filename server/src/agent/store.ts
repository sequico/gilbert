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

/** How many times a read-modify-write retries after losing a compare-and-set. */
const CAS_ATTEMPTS = 4;

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

  async readAudit(month: string): Promise<AgentAuditDoc | null> {
    const found = await this.readDoc<AgentAuditDoc>(
      this.path(AGENT_AUDIT_DIR, auditDocName(month)),
      isAgentAuditDoc,
    );
    return found?.doc ?? null;
  }

  /** The audit document for an instant's month. */
  async readAuditAt(at: Date): Promise<AgentAuditDoc | null> {
    return this.readAudit(monthOf(at));
  }

  /**
   * Append one entry to the month's audit document.
   *
   * A read-modify-write against a shared document: the write is conditional,
   * so two workers appending at once make one of them retry rather than
   * silently drop an entry. The audit is the record that an agent's work can
   * be answered from, so losing one is the failure it must not have.
   */
  async appendAudit(entry: AgentAuditEntry, at = new Date()): Promise<void> {
    const month = monthOf(at);
    const path = this.path(AGENT_AUDIT_DIR, auditDocName(month));
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
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
        return;
      } catch (err) {
        if (!isStateMismatch(err)) throw err;
      }
    }
    throw new Error("the audit document kept changing under the writer");
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
