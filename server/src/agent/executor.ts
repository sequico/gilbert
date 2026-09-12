/**
 * The executor: from a durable trigger to a recorded outcome.
 *
 * Everything here is derived from documents, so a crash costs only the work in
 * flight: the trigger is a job document, the pinned rule version is on it, the
 * pause is a decision document, and the lease is an owner plus a heartbeat. A
 * worker that dies mid-run leaves the job where the next worker finds it, and
 * the next worker reaches the same conclusion from the same state.
 *
 * The model's role (ADR 0003 resolution 7) is bounded twice: it decides only
 * inside the rule's own capability list, and every decision passes the review
 * policy before a single effect happens. `G-` labels are checked against the
 * group's own catalog before anything runs, because a keyword nobody renders
 * would be a state nobody can see.
 */
import { randomUUID } from "node:crypto";
import {
  type Ctx,
  destroyAppNode,
  FILENODE_CAP,
  filesAccountId,
  findAppFolder,
  findFolderPath,
  listAppDir,
  readVisibleFileBytes,
} from "../appFolder.js";
import { config } from "../config.js";
import { isStateMismatch, JMAP_MAIL, type JmapClient, JmapError } from "../jmap.js";
import {
  CHAT_FOLDER,
  type ChatMessage,
  compareMessages,
  mentionsName,
  participantsOf,
} from "../shared/chat.js";
import { AGENT_LABEL } from "../shared/labels.js";
import {
  type ActionOpts,
  type ActionResult,
  draftRefOf,
  fetchEmailRecord,
  fetchEmailView,
  findMailboxByName,
  runActions,
  undefinedAgentLabels,
} from "./actions.js";
import {
  type AuditRule,
  auditEntry,
  decisionAuditEntry,
  errorMessage,
  missedAuditEntry,
  recordAudit,
  refusedAuditEntry,
  refusedSubject,
  unreadableDocumentAuditEntry,
} from "./audit.js";
import {
  conversationContext,
  folderRequest,
  indexChat,
  pendingRequests,
  postMessage,
  readApproval,
  readChat,
  widenRequested,
} from "./chat.js";
import {
  type DocumentContent,
  DocumentError,
  documentContent,
  documentKindOf,
} from "./documentFamily.js";
import type { AgentUsage } from "./documents.js";
import {
  AGENT_AUDIT_DIR,
  AGENT_DIR,
  AGENT_RULES_FILE,
  type AgentAction,
  type AgentClaim,
  type AgentDecision,
  type AgentDraftRef,
  type AgentEffect,
  type AgentEmailView,
  type AgentJob,
  type AgentProposal,
  type AgentRule,
  type AgentScheduleEntry,
  type AgentTriggerRecord,
  agentActionSpec,
  CHAT_CONTEXT_DEFAULT,
  CHAT_CONTEXT_MAX,
  changeIdOf,
  claimEpoch,
  EMPTY_USAGE,
  filterNeedsBody,
  filterProblems,
  hopOf,
  instructionFor,
  leaseExpired,
  leavesTheProcess,
  matchEmailFilter,
  monthOf,
  newDecision,
  newJob,
  notebookFor,
  reviewOutcome,
  ruleProblem,
  UnsupportedFilterError,
} from "./documents.js";
import { claimStillMine, saveClaimStates } from "./lease.js";
import { decideActions, type ModelContext, providerFor } from "./llm.js";
import {
  advance,
  armTimers,
  carryingForeign,
  dueEntries,
  planSchedule,
  unrunEntries,
  unrunEntry,
} from "./scheduler.js";
import { type AgentDoc, AgentStore, UnreadableDocumentError } from "./store.js";

/** The JMAP types the executor reconciles, plus the schedule. */
export type ChangeType = "Email" | "FileNode";

/**
 * How many times a job is attempted before it is dead-lettered. A failure that
 * can be retried leaves the job `pending` with the message recorded, and a
 * later pass picks it up; the third failure is the end of it.
 */
export const JOB_MAX_ATTEMPTS = 3;

/**
 * How long a finished job or a decided decision is kept before the worker
 * prunes it. The audit is the record that lasts (12 months, ADR 0003); a job
 * document is working state and does not need to outlive an operator's look at
 * yesterday's run.
 */
export const DOCUMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long the audit is kept, in the ADR's own terms: twelve months. It is the
 * record that outlives every job and decision document, so it is pruned on its
 * own clock and by whole months.
 */
export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** How many messages of a thread a run reads as context: bounded, never bulk. */
export const THREAD_CONTEXT_MAX = 20;

/** What the model decided to do, before the review gate saw it. */
interface RunPlan {
  actions: AgentAction[];
  confidence: number;
  summary: string;
  rationale?: string;
  /** What the deciding call cost, for the group's own meter (ADR 0010). */
  usage: AgentUsage;
}

/**
 * A refusal: the rule cannot run as it is written, so retrying it changes
 * nothing. A transient failure (an unreachable provider, a refused key) is not
 * one of these and keeps its bounded retries.
 */
class RefusedError extends Error {}

export interface ExecutorDeps {
  /** The agent's own session context: the worker's, never a member's. */
  ctx: Ctx;
  client: JmapClient;
  /** The agent's address, which chat posts are written as. */
  address: string;
  /** The worker holding this executor, recorded on every lease it takes. */
  workerId: string;
  now: () => Date;
  log: (line: string) => void;
}

export class Executor {
  /** The agent's own account: configuration, the stream claim, heartbeats. */
  private readonly agentStore: AgentStore;

  /**
   * The documents this process has already reported as unreadable, by what
   * said so. Per process, because the report is a line in the trail and a
   * sentence in the group's chat, and an unreadable document is a state every
   * pass finds again rather than an event that happened once.
   */
  private readonly reportedUnreadable = new Set<string>();

  constructor(private readonly deps: ExecutorDeps) {
    this.agentStore = new AgentStore(deps.ctx, filesAccountId(deps.ctx));
  }

  /* ---------------------------------------------------------------- */
  /* Reconcile                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Re-read one changed type from the state the claim recorded and run what
   * matches.
   *
   * An event is a signal, never a payload (ADR §3), so nothing is trusted from
   * it: the records are fetched again, matched against the account's enabled
   * rules, and turned into jobs. A record a rule has already handled is not
   * turned into a second job — the durable job document is the deduplication,
   * which is what makes at-least-once delivery harmless.
   */
  async reconcile(accountId: string, type: ChangeType, claim: AgentClaim): Promise<void> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const since = claim.states[type] ?? "0";
    // When that anchor was observed: the window this pass reports is everything
    // after it, and only a write inside that window explains a change in it
    // (ADR 0010).
    const observedAt = this.deps.now().toISOString();
    const changes = await this.changes(accountId, type, since);
    if (!changes) {
      // The server cannot answer from that far back: record where the account
      // is now, so the next change is the first thing this claim acts on.
      this.deps.log(
        `${accountId}: ${type}/changes cannot reach back to the recorded state; anchoring at the current one`,
      );
      await this.recordState(
        store,
        claim,
        type,
        await this.currentState(accountId, type),
        observedAt,
      );
      return;
    }
    const ids = [...new Set([...changes.created, ...changes.updated])];
    if (ids.length) {
      const rules = await this.rulesOrReport(store, accountId, `the ${type} reconcile`);
      // A group whose rules nobody can read is not a group with no automation:
      // the anchor is left where it is, so the changes this pass could not act
      // on are read again once the document can be read, instead of being
      // consumed by a pass that had nothing to match them against.
      if (!rules) return;
      const pass = await this.jobIndex(store, claim.statesAt?.[type]);
      if (type === "Email")
        await this.emailRecords(store, accountId, ids, rules, pass, claim);
      else await this.fileRecords(store, accountId, ids, rules, pass, claim);
    }
    await this.recordState(store, claim, type, changes.newState, observedAt);
  }

  /**
   * The group's rules, with a document nobody can read recorded rather than
   * taken for no automation.
   *
   * `null` is the account having no rules document at all; a document that is
   * there and does not read as rules raises out of `readRules` (see
   * `UnreadableDocumentError`). The two are opposites — a group with no
   * automation, against every automation of the group stopped — and a caller
   * that took the second for the first would let the group's work stop with no
   * audit row and no word in the chat: a `?doc ?? []` at the call site reads the
   * two as the same thing.
   *
   * The line is written once per process and cause, because an unreadable
   * document is a state and not an event: it is still unreadable on the next
   * pass, and the group's chat would carry the same sentence every poll. The
   * log carries the pass it happened in either way.
   */
  private async rulesOrReport(
    store: AgentStore,
    accountId: string,
    where: string,
  ): Promise<AgentRule[] | null> {
    try {
      return (await store.readRules())?.doc ?? [];
    } catch (err) {
      // Anything that is not the unreadable document itself — a server that
      // could not answer, a refused read — keeps its own handling: this path is
      // about a document a person has to fix, not about a read that failed.
      if (!(err instanceof UnreadableDocumentError)) throw err;
      const detail = errorMessage(err);
      this.deps.log(
        `${accountId}: ${where} cannot read the group's automation: ${detail}`,
      );
      if (this.reportedUnreadable.has(detail)) return null;
      this.reportedUnreadable.add(detail);
      await recordAudit(store, unreadableDocumentAuditEntry(AGENT_RULES_FILE, detail));
      await this.tellChat(
        accountId,
        "I cannot read this group's automations, so nothing of them runs here " +
          `until a person fixes it: ${detail}`,
      );
      return null;
    }
  }

  /**
   * Record the state a pass has reconciled up to, and the instant it read it.
   *
   * `observedAt` is when the changes were asked for — before the jobs of that
   * pass ran — which is what lets the pass after it see those jobs' writes as
   * the explanation of the changes it reports.
   */
  private async recordState(
    store: AgentStore,
    claim: AgentClaim,
    type: string,
    state: string,
    observedAt: string,
  ): Promise<void> {
    await saveClaimStates(store, claim, { [type]: state }, { [type]: observedAt });
  }

  /** `Email/changes`, or null when the server cannot answer from `since`. */
  private async changes(
    accountId: string,
    type: "Email" | "FileNode",
    since: string,
  ): Promise<{ created: string[]; updated: string[]; newState: string } | null> {
    const using = type === "Email" ? [JMAP_MAIL] : [FILENODE_CAP];
    const result = await this.deps.client.chain(
      [[`${type}/changes`, { accountId, sinceState: since }, "c"]],
      using,
    );
    const raw = result.raw("c");
    if (!raw) return null;
    if (raw[0] === "error") {
      const body = raw[1] as { type?: unknown; description?: unknown };
      const errorType = String(body.type ?? "error");
      if (errorType === "cannotCalculateChanges" || errorType === "invalidArguments")
        return null;
      throw new JmapError(errorType, String(body.description ?? ""), "c");
    }
    const body = raw[1];
    return {
      created: idList(body.created),
      updated: idList(body.updated),
      newState: typeof body.newState === "string" ? body.newState : since,
    };
  }

  private async currentState(
    accountId: string,
    type: "Email" | "FileNode",
  ): Promise<string> {
    const using = type === "Email" ? [JMAP_MAIL] : [FILENODE_CAP];
    const res = await this.deps.client.call<{ state?: unknown }>(
      `${type}/get`,
      { accountId, ids: [] },
      using,
    );
    return typeof res.state === "string" ? res.state : "";
  }

  /** One job per (changed message × enabled rule that matches it). */
  private async emailRecords(
    store: AgentStore,
    accountId: string,
    ids: ReadonlyArray<string>,
    rules: ReadonlyArray<AgentRule>,
    pass: Pass,
    claim: AgentClaim,
  ): Promise<void> {
    const candidates = rules.filter(
      (rule) => rule.enabled && rule.trigger.on === "email",
    );
    if (!candidates.length) return;
    // A filter this executor cannot evaluate is a fault of the rule, not of the
    // message: it is refused once, before any record is considered. Failing per
    // message would bury the one cause under a failed job for every arrival.
    const usable: AgentRule[] = [];
    for (const rule of candidates) {
      // A filter this executor cannot evaluate is a fault of the rule, not of
      // the message, and the list asked here is the one the form asks, so an
      // automation refused when it is written is refused when it runs.
      const problems = filterProblems(rule.trigger.filter, "the filter");
      if (!problems.length) {
        usable.push(rule);
        continue;
      }
      await this.refuseTrigger(
        store,
        accountId,
        rule,
        { on: "email", at: this.deps.now().toISOString() },
        problems.join("; "),
      );
    }
    if (!usable.length) return;
    const needsBody = usable.some((rule) => filterNeedsBody(rule.trigger.filter));
    for (const id of ids) {
      const view = await fetchEmailView(this.deps.client, accountId, id, {
        body: needsBody,
      });
      if (!view) continue;
      // A draft is work in progress, not delivered mail: without this, a run
      // that prepares a draft would wake itself on the draft it created.
      if (view.keywords?.$draft === true) continue;
      for (const rule of usable) {
        const trigger: AgentTriggerRecord = {
          on: "email",
          emailId: view.id,
          at: view.receivedAt ?? this.deps.now().toISOString(),
        };
        const sender = view.from?.[0];
        if (sender?.email) trigger.by = sender.email;
        let matched: boolean;
        try {
          matched = matchEmailFilter(rule.trigger.filter, view);
        } catch (err) {
          if (!(err instanceof UnsupportedFilterError)) throw err;
          await this.refuseTrigger(store, accountId, rule, trigger, errorMessage(err));
          continue;
        }
        if (!matched) continue;
        await this.startJob(store, accountId, rule, trigger, pass, claim);
      }
    }
  }

  /** FileNodes: a chat message wakes the chat rules, a file wakes the file ones. */
  private async fileRecords(
    store: AgentStore,
    accountId: string,
    ids: ReadonlyArray<string>,
    rules: ReadonlyArray<AgentRule>,
    pass: Pass,
    claim: AgentClaim,
  ): Promise<void> {
    const chatRules = rules.filter((rule) => rule.enabled && rule.trigger.on === "chat");
    const nodeRules = rules.filter(
      (rule) => rule.enabled && rule.trigger.on === "filenode",
    );
    if (!chatRules.length && !nodeRules.length) return;
    const nodes = await this.nodeRecords(accountId, ids);
    if (!nodes.length) return;
    const chatFolderId = chatRules.length
      ? await findFolderPath(this.deps.ctx, accountId, CHAT_FOLDER)
      : null;
    const appFolderId = nodeRules.length
      ? await findAppFolder(this.deps.ctx, accountId)
      : null;

    if (chatRules.length && chatFolderId) {
      const chatIds = new Set(
        nodes
          .filter((node) => node.parentId === chatFolderId)
          .map((node) => String(node.id)),
      );
      if (chatIds.size) {
        const messages = await this.readChatOf(accountId);
        const requests = pendingRequests(
          messages,
          this.deps.address,
          indexChat(messages),
        );
        const byId = new Map(messages.map((message) => [message.id, message]));
        for (const request of requests) {
          if (!chatIds.has(request.messageId)) continue;
          const message = byId.get(request.messageId);
          const trigger: AgentTriggerRecord = {
            on: "chat",
            chatId: request.messageId,
            at: message?.created ?? this.deps.now().toISOString(),
          };
          if (request.author) trigger.by = request.author;
          for (const rule of chatRules)
            await this.startJob(store, accountId, rule, trigger, pass, claim);
        }
      }
    }

    if (!nodeRules.length) return;
    for (const node of nodes) {
      const id = String(node.id);
      if (node.nodeType !== "file") continue;
      if (chatFolderId && node.parentId === chatFolderId) continue;
      if (await this.underAppFolder(accountId, id, appFolderId)) continue;
      const trigger: AgentTriggerRecord = {
        on: "filenode",
        nodeId: id,
        at: this.deps.now().toISOString(),
      };
      for (const rule of nodeRules)
        await this.startJob(store, accountId, rule, trigger, pass, claim);
    }
  }

  private async nodeRecords(
    accountId: string,
    ids: ReadonlyArray<string>,
  ): Promise<FileNodeRecord[]> {
    const res = await this.deps.client.call<{ list?: FileNodeRecord[] }>(
      "FileNode/get",
      { accountId, ids, properties: ["id", "name", "parentId", "nodeType", "size"] },
      [FILENODE_CAP],
    );
    return res.list ?? [];
  }

  private async nodeRecord(
    accountId: string,
    id: string,
  ): Promise<FileNodeRecord | null> {
    const list = await this.nodeRecords(accountId, [id]);
    return list[0] ?? null;
  }

  /**
   * Whether a node lives anywhere under the account's `gilbert` app folder.
   *
   * The app folder holds Gilbert's own documents — rules, jobs, decisions,
   * audit, chat. Rules act on the group's Files, so a document the agent wrote
   * must not wake it again; the chat folder is the one exception and is
   * handled by the chat trigger before this is asked.
   */
  private async underAppFolder(
    accountId: string,
    id: string,
    appFolderId: string | null,
  ): Promise<boolean> {
    if (!appFolderId) return false;
    let current = id;
    for (let depth = 0; depth < 8; depth++) {
      const record = await this.nodeRecord(accountId, current);
      const parentId = typeof record?.parentId === "string" ? record.parentId : "";
      if (!parentId) return false;
      if (parentId === appFolderId) return true;
      current = parentId;
    }
    return false;
  }

  /**
   * What one pass knows about the changes it is reporting: the account's jobs,
   * and when the state it reads from was observed (ADR 0010).
   */
  private async jobIndex(store: AgentStore, since?: string): Promise<Pass> {
    const jobs = (await store.listJobs()).map((entry) => entry.doc);
    const pass: Pass = {
      keys: new Set(jobs.map((job) => jobKey(job.ruleId, job.trigger))),
      producers: producersOf(jobs),
    };
    if (since) pass.since = since;
    return pass;
  }

  private async startJob(
    store: AgentStore,
    accountId: string,
    rule: AgentRule,
    trigger: AgentTriggerRecord,
    pass: Pass,
    claim: AgentClaim,
  ): Promise<void> {
    const key = jobKey(rule.id, trigger);
    if (pass.keys.has(key)) return;
    pass.keys.add(key);
    /*
     * The lineage, and the bound it is read against (ADR 0010). `wokenBy` is the
     * run whose own write caused this change, when the account's own documents
     * still say so, and this run is one hop further than that one. A trigger no
     * run wrote — an arrival, a file, the clock, a person's ask — wakes its rule
     * at hop one.
     *
     * The count is read from the run that woke this one, so a wake whose run
     * cannot be named stops at hop one. That is what a job document pruned a
     * month after the run finished, a job written before the effect ledger
     * existed, and a run dead-lettered without recording the effect it had
     * already made each cost.
     */
    const woke = wokenBy(trigger, pass);
    const hop = woke ? woke.hop + 1 : 1;
    if (hop > config.agent.maxChainHops) {
      await this.refuseChain(store, accountId, rule, trigger, woke, hop);
      return;
    }
    const job = newJob({
      id: randomUUID(),
      accountId,
      rule,
      trigger: { ...trigger, hop, ...(woke ? { parentJobId: woke.jobId } : {}) },
      now: this.deps.now().toISOString(),
    });
    await store.writeJob(job);
    // The claim travels with the job: a run started by a trigger is fenced the
    // same way a retried one is, and without this the fencing would only ever
    // apply to the pending sweep.
    await this.runJob(accountId, job, rule, claim);
  }

  /**
   * The hop past the bound, refused loudly rather than quietly dropped
   * (ADR 0010): nothing runs, and the group is told which automation could not
   * run and why.
   *
   * No job document is written. A job is a run that is going to happen, and this
   * one must not: what the trail records is the refusal itself, under its own
   * outcome, because nothing failed. The one sentence names the automation, the
   * hop it was woken at and the bound, and it goes to the log and the group's
   * chat as well as being the entry's detail, so an operator reading either sees
   * the same line about the same refusal.
   *
   * A refusal that is already in the trail is not made twice: nothing but the
   * trail remembers one, so a change the worker reads again would otherwise
   * refuse again, with a second entry and the same sentence in the group's chat.
   */
  private async refuseChain(
    store: AgentStore,
    accountId: string,
    rule: AgentRule,
    trigger: AgentTriggerRecord,
    woke: Producer | null,
    hop: number,
  ): Promise<void> {
    const subject = refusedSubject(rule.id, trigger);
    const refused = (await store.readAuditAt(this.deps.now()))?.entries ?? [];
    if (refused.some((entry) => entry.outcome === "refused" && entry.jobId === subject))
      return;
    const bound = config.agent.maxChainHops;
    const line =
      `I did not run "${rule.name}": it was woken ${hop} hops into a chain ` +
      `started by ${describeTrigger(trigger)}, and this installation refuses a run ` +
      `past ${bound} hops.`;
    await recordAudit(
      store,
      refusedAuditEntry(
        rule,
        trigger,
        woke ? `${line} The run that woke it was ${woke.jobId}.` : line,
      ),
    );
    this.deps.log(line);
    await this.tellChat(accountId, line);
  }

  /* ---------------------------------------------------------------- */
  /* Running one job                                                  */
  /* ---------------------------------------------------------------- */

  async runJob(
    accountId: string,
    job: AgentJob,
    rule: AgentRule,
    claim: AgentClaim,
  ): Promise<void> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const found = await store.readJob(job.id);
    if (!found) return;
    const current = found.doc;
    // Only work that is waiting for a worker: a finished job is finished, and a
    // job paused on a person waits for that person, never for a lease timeout.
    if (current.state !== "pending" && current.state !== "running") return;
    const now = this.deps.now();
    const lease = current.lease;
    if (
      lease &&
      lease.owner !== this.deps.workerId &&
      !leaseExpired(lease.heartbeatAt, now.getTime(), config.agent.leaseMs)
    )
      return;
    if (rule.version !== current.ruleVersion) {
      await this.failLoudly(
        store,
        current,
        rule,
        `the job pins rule version ${current.ruleVersion}, and the rule is at version ${rule.version}: a job never runs a version nobody approved`,
        { deadLetter: true },
      );
      return;
    }
    const running: AgentJob = {
      ...current,
      state: "running",
      attempts: current.attempts + 1,
      lease: { owner: this.deps.workerId, heartbeatAt: now.toISOString() },
    };
    delete running.error;
    try {
      // The lease and the state move together, conditionally: whoever loses
      // this write leaves the job to whoever won it.
      await store.writeJob(running, { ifInState: found.state });
    } catch (err) {
      if (isStateMismatch(err)) return;
      throw err;
    }
    try {
      // A job that already carries a plan keeps it. Re-planning a retry would
      // run a plan nobody approved — an approved job would go back to the model
      // for a second opinion — and it would make `applied` mean nothing, since
      // what it holds is the prefix of the very plan that produced it.
      const plan = current.proposal?.actions?.length
        ? planOf(current.proposal)
        : await this.planFor(store, accountId, running, rule);
      // The plan is written before it is run: a retry resumes this same work,
      // and a failure can name what was about to happen instead of guessing.
      const planned = await this.writeJobIfCurrent(store, job.id, (latest) => ({
        ...latest,
        proposal: proposalOf(plan),
      }));
      if (!planned) return;
      // Fencing, at the last moment before anything leaves the process: a run
      // whose unit was taken over while it was deciding has had its lease
      // lapse, and what it is about to do — send, post, file — would be done a
      // second time by the worker that replaced it.
      if (!(await claimStillMine(store, this.deps.workerId, claimEpoch(claim)))) {
        this.deps.log(
          `${rule.name}: ${job.id} was taken over while it was deciding, so nothing is run`,
        );
        return;
      }
      if (reviewOutcome(rule.review, plan.actions, plan.confidence) === "execute") {
        await this.execute(store, accountId, planned, rule, plan, claim);
      } else {
        await this.pause(store, accountId, planned, rule, plan, claim);
      }
    } catch (err) {
      const latest = (await store.readJob(job.id))?.doc ?? running;
      await this.failLoudly(store, latest, rule, errorMessage(err), {
        deadLetter: err instanceof RefusedError,
      });
    }
  }

  /**
   * Write the job against the state it is read in, and write nothing when the
   * write is refused.
   *
   * The token a job write carries is the account's whole FileNode state, and
   * every write in the account moves it — this run's own audit line and the
   * action that just landed included — so the state is read here, immediately
   * before the write it guards. The change is applied to the document as it is
   * read rather than to the copy a run has carried since it claimed the job,
   * because a write onto that copy would put a lapsed worker's `applied` and
   * `attempts` over the view its successor is working on. A refusal means the
   * document moved in that window, and the answer is to write nothing: `null`
   * says so, and a job document that is no longer there answers the same way.
   *
   * A caller that must not stop (a failure being reported, a rejection being
   * recorded) may go on with its report; a caller that is working a run stops.
   */
  private async writeJobIfCurrent(
    store: AgentStore,
    id: string,
    change: (job: AgentJob) => AgentJob,
  ): Promise<AgentJob | null> {
    const found = await store.readJob(id);
    if (!found) return null;
    const next = change(found.doc);
    try {
      await store.writeJob(next, { ifInState: found.state });
    } catch (err) {
      if (isStateMismatch(err)) return null;
      throw err;
    }
    return next;
  }

  /** What the run should do: the model decides, inside the rule's own grant. */
  private async planFor(
    store: AgentStore,
    accountId: string,
    job: AgentJob,
    rule: AgentRule,
  ): Promise<RunPlan> {
    const problem = ruleProblem(rule);
    if (problem) throw new RefusedError(`the rule cannot run: ${problem}`);
    const context = await this.contextFor(accountId, job, rule);
    const configDoc = (await this.agentStore.readConfig())?.doc ?? null;
    // The group's standing instruction rides every model call this group's
    // agent makes (ADR 0003 resolution 17): read once per run, first in the
    // prompt.
    const standing = instructionFor((await store.readInstruction())?.doc ?? null);
    // The group's notebook rides every call too, before the standing
    // instruction: what is true about the group, then how it wants work done.
    const notebook = notebookFor((await store.readNotebook())?.doc ?? null);
    const answer = await decideActions(
      providerFor(configDoc),
      rule,
      context,
      rule.capabilities,
      standing,
      notebook,
      // The call's own shape: the installation's ceiling on an answer, and the
      // agent's own decision about paying for a chain of thought.
      { maxOutputTokens: configDoc?.maxOutputTokens, thinking: config.agent.thinking },
    );
    await this.guardLabels(accountId, answer.actions);
    return {
      actions: answer.actions,
      confidence: answer.confidence,
      summary: answer.summary,
      usage: answer.usage,
      ...(answer.rationale ? { rationale: answer.rationale } : {}),
    };
  }

  /** The `G-` catalog guard: refuse the run before it has any effect at all. */
  private async guardLabels(
    accountId: string,
    actions: ReadonlyArray<AgentAction>,
  ): Promise<void> {
    const missing = await undefinedAgentLabels(this.deps.ctx, accountId, actions);
    if (missing.length)
      throw new RefusedError(
        `the group's label catalog does not define ${missing.join(", ")}; ` +
          "a keyword nobody renders is a state nobody can see",
      );
  }

  /**
   * The fence asked before an action that leaves the process.
   *
   * A lease can lapse during a long run, and a run whose unit was taken over
   * must not send, post, draft or file what its successor is doing too. Both
   * paths that run actions — the plan itself and the draft a paused run leaves
   * for a person — ask through this one hook, so a new call site cannot run
   * effects unfenced by forgetting it.
   */
  private leavingProcessFence(
    store: AgentStore,
    claim: AgentClaim,
  ): (action: AgentAction) => Promise<void> {
    return async (action: AgentAction) => {
      if (!leavesTheProcess(action)) return;
      const mine = await claimStillMine(store, this.deps.workerId, claimEpoch(claim));
      if (!mine)
        throw new RefusedError(
          "the unit was taken over while this run was working: nothing more is run",
        );
    };
  }

  private async execute(
    store: AgentStore,
    accountId: string,
    job: AgentJob,
    rule: AgentRule,
    plan: RunPlan,
    claim: AgentClaim,
  ): Promise<void> {
    // Intent first: the trail says what was about to run before it runs, so an
    // effect can never exist without a line that accounts for it, even if the
    // process dies between the two.
    await recordAudit(
      store,
      auditEntry(job, rule, "running", plan.actions, plan.summary, {
        // The cost sits beside the work that spent it (ADR 0010): the agent
        // that held the group, whether this run paid for a chain of thought,
        // and the counts the provider reported.
        agent: this.deps.address,
        reasoned: config.agent.thinking,
        usage: plan.usage,
      }),
    );
    // What already landed is a prefix of this plan — the actions run in order
    // and stop at the first failure — so the remainder is what is left to do.
    const applied = job.applied ?? [];
    const todo = plan.actions.slice(applied.length);
    if (!todo.length) {
      // Everything the plan asked for had already run: the failure was in the
      // bookkeeping, not in the work, and closing the job is its honest ending.
      // A second pass here would be the double effect, not the repair.
      const closed = await this.writeJobIfCurrent(store, job.id, (latest) =>
        closeState({ ...latest, applied: [...applied] }, "done"),
      );
      if (!closed) return;
      await recordAudit(
        store,
        auditEntry(closed, rule, "done", plan.actions, plan.summary),
      );
      this.deps.log(`${rule.name}: ${job.id} had already run everything it planned`);
      return;
    }
    const landed: string[] = [...applied];
    const results = await runActions(
      this.deps.ctx,
      accountId,
      todo,
      await this.actionOpts(accountId, plan.actions, job),
      {
        // Recorded as each action lands, so a retry resumes after it.
        onApplied: async (action: AgentAction, result: ActionResult) => {
          landed.push(action.do);
          const wrote = effectsOf(result, this.deps.now().toISOString());
          const recorded = await this.writeJobIfCurrent(store, job.id, (latest) => ({
            ...latest,
            applied: [...landed],
            // The record the action wrote, beside the action that wrote it: a
            // change naming that id is how the next run of a chain knows which
            // job woke it (ADR 0010).
            ...(wrote.length ? { effects: [...(latest.effects ?? []), ...wrote] } : {}),
          }));
          // What just landed is not recorded, so the run stops here rather than
          // running the rest of a plan whose prefix nobody can read — and a
          // retry would start the whole plan again.
          if (!recorded)
            throw new RefusedError(
              "the job document moved while this run was working, so what it did " +
                "is not recorded: nothing more is run",
            );
        },
        beforeAction: this.leavingProcessFence(store, claim),
      },
    );
    const done = await this.writeJobIfCurrent(store, job.id, (latest) =>
      closeState({ ...latest, applied: [...landed] }, "done"),
    );
    if (!done) return;
    await recordAudit(store, auditEntry(done, rule, "done", plan.actions, plan.summary));
    this.deps.log(
      `${rule.name}: ${describeActions(results)} for ${describeTrigger(job.trigger)}`,
    );
    /*
     * A run somebody asked for says so where the group reads (ADR 0010). Every
     * other trigger is the group's own mail, chat or clock, which needs no
     * announcement — but "I ran this because a person asked me to" is a fact
     * about the group's agent that its members should not have to infer from a
     * document they cannot open. A failure already tells the chat; this is the
     * half that was missing.
     */
    if (done.trigger.on === "manual")
      await this.tellChat(
        accountId,
        `I ran "${rule.name}" as asked: ${describeActionsInWords(results)}`,
      );
  }

  /**
   * Pause the run on a person (ADR resolution 10): the proposal becomes a
   * decision document, the group chat carries it, and a proposal that would
   * send mail leaves a draft in the group's Drafts where a member can read it —
   * unread, so it is seen.
   */
  private async pause(
    store: AgentStore,
    accountId: string,
    job: AgentJob,
    rule: AgentRule,
    plan: RunPlan,
    claim: AgentClaim,
  ): Promise<void> {
    // The proposal is written down before the draft exists: a draft is an
    // effect in a mailbox the group shares, and nothing the agent leaves behind
    // may exist without a line that accounts for it and a decision a person can
    // answer.
    const proposal = proposalOf(plan);
    const opening: AgentJob = { ...job, state: "awaiting_approval", proposal };
    // The decision document is written **before** the proposal is posted: the
    // other order leaves a proposal in the group's chat that no answer can
    // resolve, because the reader that settles answers only walks decisions
    // that exist. The id comes from the decision itself, so the job names the
    // document that was actually written.
    const decision = newDecision(opening);
    // A paused job belongs to a person now, not to a worker: clearing the lease
    // keeps it out of the takeover path while it waits. A refused write stops
    // the pause before a decision a person could answer exists.
    const paused = await this.writeJobIfCurrent(store, job.id, (latest) => {
      const waiting: AgentJob = {
        ...latest,
        state: "awaiting_approval",
        proposal,
        decisionId: decision.id,
      };
      delete waiting.lease;
      return waiting;
    });
    if (!paused) return;
    // The decision is written once more as it learns things: the draft it will
    // send, then the chat message that carries it. Both live on the decision —
    // the sweep that notices a sent or deleted draft walks decisions, not jobs
    // — so each write carries what the previous ones established.
    let open = decision;
    await store.writeDecision(open);
    await recordAudit(
      store,
      auditEntry(paused, rule, "awaiting_approval", plan.actions, plan.summary),
    );
    // Only now the draft, and both documents carry its reference: the answer
    // submits what the person read instead of preparing it a second time.
    const draft = await this.prepareDraft(store, accountId, claim, plan);
    if (draft) {
      paused.proposal = { ...proposal, draft };
      const recorded = await this.writeJobIfCurrent(store, job.id, (latest) => ({
        ...latest,
        proposal: { ...proposal, draft },
      }));
      if (recorded) {
        open = { ...open, draft };
        await store.writeDecision(open);
      }
    }
    const chatId = await postMessage(
      this.deps.ctx,
      accountId,
      this.deps.address,
      proposalText(rule, paused),
      job.trigger.on === "chat" ? job.trigger.chatId : undefined,
    );
    await store.writeDecision({ ...open, chatId });
    this.deps.log(`${rule.name}: waiting for a person (${job.id})`);
  }

  /**
   * The draft a paused run leaves in the group's Drafts. A proposal that sends
   * mail needs something a member can read and send themselves, and a proposal
   * that only prepares a draft has already named it.
   *
   * A draft is an effect a person reads, so it passes the same fence the plan's
   * own actions pass: a run whose unit was taken over while it was writing the
   * decision leaves no draft beside the one its successor is preparing.
   */
  private async prepareDraft(
    store: AgentStore,
    accountId: string,
    claim: AgentClaim,
    plan: RunPlan,
  ): Promise<AgentDraftRef | null> {
    const draft = plan.actions.find((action) => action.do === "mail.draft");
    const send = plan.actions.find((action) => action.do === "mail.send");
    if (!draft && !send) return null;
    const source = draft ?? send!;
    const text = typeof source.with?.text === "string" ? source.with.text : "";
    if (!text.trim()) return null;
    const action: AgentAction = {
      do: "mail.draft",
      with: {
        to: source.with?.to,
        ...(source.with?.subject ? { subject: source.with.subject } : {}),
        text,
      },
    };
    const [result] = await runActions(
      this.deps.ctx,
      accountId,
      [action],
      {
        from: this.deps.address,
        now: this.deps.now(),
      },
      { beforeAction: this.leavingProcessFence(store, claim) },
    );
    const ref = draftRefOf(result);
    if (!ref) return null;
    await this.labelQuietly(
      accountId,
      { do: "keyword.add", with: { keyword: AGENT_LABEL.awaiting } },
      ref.emailId,
    );
    return ref;
  }

  /* ---------------------------------------------------------------- */
  /* Context                                                          */
  /* ---------------------------------------------------------------- */

  private async contextFor(
    accountId: string,
    job: AgentJob,
    rule: AgentRule,
  ): Promise<ModelContext> {
    const trigger = job.trigger;
    if (trigger.on === "email" && trigger.emailId) {
      const view = await fetchEmailView(this.deps.client, accountId, trigger.emailId, {
        body: true,
      });
      const thread = await this.threadContext(accountId, trigger.emailId);
      const parts = [
        view ? renderEmail("THE MESSAGE THIS RUN READS", view) : "(the message is gone)",
      ];
      if (thread.length)
        parts.push(
          `ITS CONVERSATION (the ${thread.length} most recent other messages):\n\n${thread
            .map((message) => renderEmail("", message))
            .join("\n\n")}`,
        );
      const context: ModelContext = { text: parts.join("\n\n") };
      if (trigger.by) context.by = trigger.by;
      return context;
    }
    if (trigger.on === "chat" && trigger.chatId) {
      const messages = await this.readChatOf(accountId);
      const anchor = messages.find((message) => message.id === trigger.chatId);
      // Only a person asking widens the window; the run never does it itself.
      // The second step is one folder slice, and only when one is named.
      const asked = anchor ? anchor.text : "";
      const requested = widenRequested(asked) ? CHAT_CONTEXT_MAX : undefined;
      // The anchor is named, not inferred: the run answers *this* message, and
      // `conversationContext` refuses a transcript that does not hold it.
      const window = conversationContext(
        messages,
        anchor?.created ?? this.deps.now().toISOString(),
        requested,
        trigger.chatId,
      );
      const parts = [window.map(renderChatMessage).join("\n")];
      const folder = folderRequest(asked);
      if (folder) parts.push(await this.folderSlice(accountId, folder));
      const context: ModelContext = {
        text: parts.filter(Boolean).join("\n\n"),
      };
      if (trigger.by) context.by = trigger.by;
      return context;
    }
    if (trigger.on === "filenode" && trigger.nodeId) {
      const node = await this.nodeRecord(accountId, trigger.nodeId);
      const path = node ? await this.pathOfNode(accountId, trigger.nodeId) : null;
      const named = path ?? String(node?.name ?? "");
      const context: ModelContext = {
        text: node
          ? `A file changed: "${named}" (${String(node.size ?? 0)} bytes).`
          : "(the file this run was triggered by is gone)",
      };
      if (node && path) await this.readTheFile(accountId, path, rule, context);
      return context;
    }
    return {
      text: `The automation "${rule.name}" runs on its own, every ${
        rule.trigger.everyMinutes ?? 0
      } minutes.`,
    };
  }

  /**
   * What a run reads of the file that woke it (ADR 0010), into its own context.
   *
   * A rule that holds `document.read` reads the document: its own text layer
   * comes back as text, and the pages that carry no text layer at all are
   * rasterised in the process and handed to the call as images — the model
   * reads them, because it has eyes. How many pages one run may hand over is
   * `GILBERT_AGENT_MAX_PAGES`, and the bound is stated rather than hidden.
   *
   * A kind this family does not read is said in the run's own notes rather than
   * failing it: a file arriving is not an instruction to read it. A document a
   * library refuses is another matter, and is refused loudly with its own code,
   * because the run was woken to read something this deployment cannot read.
   */
  private async readTheFile(
    accountId: string,
    path: string,
    rule: AgentRule,
    context: ModelContext,
  ): Promise<void> {
    if (!rule.capabilities.includes("document.read")) return;
    const found = await readVisibleFileBytes(this.deps.ctx, accountId, path);
    if (!found) {
      context.text += `\n\n"${path}" is no longer in the group's Files.`;
      return;
    }
    const type =
      typeof found.file.type === "string" && found.file.type ? found.file.type : "";
    const kind = documentKindOf(found.name, type);
    if (!kind) {
      context.text += `\n\n"${found.name}" is neither a PDF nor a .docx, so nothing of it is read here.`;
      return;
    }
    let content: DocumentContent;
    try {
      content = await documentContent(found.bytes, kind, config.agent.maxPages);
    } catch (err) {
      // A library refusing these bytes refuses them again on a retry, so the
      // run stops here, once, with the code: an action this deployment cannot
      // do is refused, never silently dropped (ADR 0010).
      if (err instanceof DocumentError) throw new RefusedError(err.message);
      throw err;
    }
    const read = content.read;
    if (read.text) context.text += `\n\nIts own text:\n\n${read.text}`;
    if (!read.pixelPages.length) return;
    const handed = content.images.map((image) => image.page).join(", ");
    context.text +=
      `\n\nPages ${read.pixelPages.join(", ")} of ${read.pages} carry no text layer: ` +
      (handed
        ? `pages ${handed} are handed to you as images`
        : "none of them fits this call") +
      (content.omitted
        ? `, and ${content.omitted} more are past the ${config.agent.maxPages} pages one run may hand over`
        : "") +
      ".";
    context.images = content.images;
  }

  /**
   * The path of a node in the group's Files: the names from the root down to
   * it, joined as every surface writes a path.
   *
   * A run told the path of the file it was woken by can name that file to a
   * document action, or name another beside it. A node whose parents do not
   * reach the root within the walk's depth is not named at all, rather than
   * named wrongly.
   */
  private async pathOfNode(accountId: string, nodeId: string): Promise<string | null> {
    const names: string[] = [];
    let current = nodeId;
    for (let depth = 0; depth < 32; depth++) {
      const record = await this.nodeRecord(accountId, current);
      if (!record) return null;
      names.unshift(String(record.name ?? ""));
      const parentId = typeof record.parentId === "string" ? record.parentId : "";
      if (!parentId) return names.join("/");
      current = parentId;
    }
    return null;
  }

  /** A bounded slice of the message's thread: at most `THREAD_CONTEXT_MAX`. */
  private async threadContext(
    accountId: string,
    emailId: string,
  ): Promise<AgentEmailView[]> {
    const record = await fetchEmailRecord(this.deps.client, accountId, emailId, {});
    const threadId = typeof record?.threadId === "string" ? record.threadId : "";
    if (!threadId) return [];
    const res = await this.deps.client.call<{
      list?: Array<{ emailIds?: unknown[] }>;
    }>("Thread/get", { accountId, ids: [threadId] }, [JMAP_MAIL]);
    const ids = (res.list?.[0]?.emailIds ?? [])
      .map(String)
      .filter((id) => id !== emailId)
      .slice(-(THREAD_CONTEXT_MAX - 1));
    const out: AgentEmailView[] = [];
    for (const id of ids) {
      const view = await fetchEmailView(this.deps.client, accountId, id, { body: false });
      if (view) out.push(view);
    }
    return out;
  }

  private async readChatOf(accountId: string): Promise<ChatMessage[]> {
    return readChat(this.deps.ctx, accountId, this.deps.client);
  }

  private async actionOpts(
    accountId: string,
    actions: ReadonlyArray<AgentAction>,
    job: AgentJob | null,
  ): Promise<ActionOpts> {
    const opts: ActionOpts = { from: this.deps.address, now: this.deps.now() };
    if (job?.trigger.emailId) opts.emailId = job.trigger.emailId;
    if (job?.trigger.chatId) opts.replyTo = job.trigger.chatId;
    if (job?.proposal?.draft) {
      opts.draftEmailId = job.proposal.draft.emailId;
      opts.draftMailboxId = job.proposal.draft.mailboxId;
    }
    if (actions.some((action) => action.do === "chat.post"))
      opts.participants = await this.chatParticipants(accountId);
    if (job?.trigger.nodeId) {
      const path = await this.pathOfNode(accountId, job.trigger.nodeId);
      if (path) opts.filePath = path;
    }
    return opts;
  }

  /** Who a chat post may mention: the transcript's participants, plus the agent. */
  private async chatParticipants(accountId: string): Promise<string[]> {
    try {
      const messages = await this.readChatOf(accountId);
      return participantsOf(messages, this.deps.address);
    } catch (err) {
      this.deps.log(`could not read the chat participants: ${errorMessage(err)}`);
      return [this.deps.address];
    }
  }

  /* ---------------------------------------------------------------- */
  /* Failure                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Failure is loud (ADR 0003): the trail records it, the message is marked for
   * a person and the group chat says which automation could not finish. A
   * failure that may still succeed on another attempt stays `pending` instead,
   * so a retry never becomes chatter.
   */
  async failLoudly(
    store: AgentStore,
    job: AgentJob,
    rule: AuditRule,
    message: string,
    opts: { deadLetter?: boolean; outcome?: "failed" | "timeout" } = {},
  ): Promise<void> {
    const attempted = job.proposal?.actions ?? [];
    // A retry is only safe for work that stayed inside the group's own state.
    // A plan that sends mail — or writes where people look — has an effect
    // nobody can take back, so a second pass either repeats it or runs a
    // freshly decided plan in its place, and both are worse than stopping and
    // asking. Those failures are final, and they are loud.
    const repeatable = !attempted.some(leavesTheProcess);
    const final =
      opts.deadLetter === true || job.attempts >= JOB_MAX_ATTEMPTS || !repeatable;
    const failed = await this.writeJobIfCurrent(store, job.id, (latest) => {
      const next: AgentJob = {
        ...latest,
        state: final ? "failed" : "pending",
        error: message,
      };
      delete next.lease;
      // A job that may still succeed waits a while first: three attempts taken
      // back to back are one attempt against a provider that is down.
      if (!final) {
        next.nextAttemptAt = this.retryAt(job.attempts);
      } else {
        delete next.nextAttemptAt;
      }
      return next;
    });
    // A refused write is the job being somebody else's now, and the failure is
    // still recorded: the trail and the group's chat are the report, and a
    // report is not a write onto the document.
    if (!failed)
      this.deps.log(
        `${rule.name}: the job document moved under the failing run, so its failure is not written onto it`,
      );
    await recordAudit(
      store,
      auditEntry(
        failed ?? { ...job, state: final ? "failed" : "pending", error: message },
        rule,
        opts.outcome ?? "failed",
        attempted,
        `${message} (attempt ${job.attempts || 1} of ${JOB_MAX_ATTEMPTS})`,
      ),
    );
    this.deps.log(`${rule.name} failed: ${message}`);
    if (!final) return;
    await this.labelQuietly(
      store.accountId,
      { do: "keyword.add", with: { keyword: AGENT_LABEL.needAttention } },
      job.trigger.on === "email" ? job.trigger.emailId : undefined,
    );
    await this.tellChat(store.accountId, `I could not finish "${rule.name}": ${message}`);
  }

  /** A rule the executor cannot honour still fails loudly, not silently. */
  private async refuseTrigger(
    store: AgentStore,
    accountId: string,
    rule: AgentRule,
    trigger: AgentTriggerRecord,
    message: string,
  ): Promise<void> {
    const job = newJob({
      id: randomUUID(),
      accountId,
      rule,
      trigger,
      now: this.deps.now().toISOString(),
    });
    await store.writeJob(job);
    await this.failLoudly(store, job, rule, message, { deadLetter: true });
  }

  private async labelQuietly(
    accountId: string,
    action: AgentAction,
    emailId: string | undefined,
  ): Promise<void> {
    if (!emailId) return;
    try {
      await runActions(this.deps.ctx, accountId, [action], {
        emailId,
        from: this.deps.address,
      });
    } catch (err) {
      // A label that cannot be applied never masks the run it describes.
      this.deps.log(
        `could not apply ${String(action.with?.keyword)}: ${errorMessage(err)}`,
      );
    }
  }

  private async tellChat(accountId: string, text: string): Promise<void> {
    try {
      await postMessage(this.deps.ctx, accountId, this.deps.address, text);
    } catch (err) {
      this.deps.log(`could not post to the group chat: ${errorMessage(err)}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Approvals                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * The single arbiter of a decision.
   *
   * The decision document is patched with an expected-state write, so exactly
   * one caller — a member's reply, the admin queue, or the draft that left
   * Drafts — gets to act on it, and the others find a decision that is no
   * longer pending. Any member may approve: this is never an admin check.
   *
   * An approval is consumed once. The stamp that records it (`appliedAt`) is
   * written in the same conditional write that moves the decision out of
   * `pending`, **before** any effect runs, so two answers arriving together
   * cannot send the same mail twice: the loser of that write finds a decision
   * that already has an owner. Should the process die between the stamp and the
   * effects, the trail carries the intent line written just before them, and
   * the answer is a person reading it — never a silent second send.
   *
   * `by` is the chat author's own account of who they are. Membership is the
   * grant in Stalwart and every member of the group may approve, so this is
   * recorded as a conversational attribution, not as an authenticated identity.
   */
  async resolveApproval(
    accountId: string,
    decision: AgentDecision,
    approved: boolean,
    by: string,
  ): Promise<void> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const found = await store.readDecision(decision.id);
    if (found?.doc.state !== "pending") return;
    const current = found.doc;
    const decidedAt = this.deps.now().toISOString();
    const decided: AgentDecision = {
      ...current,
      state: approved ? "approved" : "rejected",
      decidedBy: by,
      decidedAt,
      ...(approved ? { appliedAt: decidedAt } : {}),
    };
    try {
      await store.writeDecision(decided, { ifInState: found.state });
    } catch (err) {
      if (isStateMismatch(err)) return;
      throw err;
    }
    const jobFound = await store.readJob(decided.jobId);
    const job = jobFound?.doc ?? null;
    const rule = await this.ruleOf(store, decided.ruleId);
    const auditRule: AuditRule = rule ?? {
      id: decided.ruleId,
      name: "the rule is gone",
      version: decided.ruleVersion,
    };
    if (!approved) {
      // The rejection is recorded either way; the job is closed only when the
      // write is still a write that run may make.
      if (job)
        await this.writeJobIfCurrent(store, job.id, (latest) =>
          closeState(latest, "done"),
        );
      await recordAudit(
        store,
        job
          ? auditEntry(job, auditRule, "rejected", [], `rejected by ${by}`)
          : decisionAuditEntry(decided, auditRule, "rejected", [], `rejected by ${by}`),
      );
      if (job) await this.labelQuietly(accountId, rejectLabel(), job.trigger.emailId);
      await this.tellChat(accountId, `Rejected by ${by}: ${decided.summary}`);
      return;
    }
    // The pin reaches a run resumed from an approval too (ADR 0003 §4): an
    // answer is about the plan a person read, and the rule it came from has
    // moved on since. The run is refused rather than started, and the person
    // who answered is told why.
    if (rule && rule.version !== decided.ruleVersion) {
      const message =
        `the decision pins rule version ${decided.ruleVersion} and the rule is ` +
        `at version ${rule.version}: a run never starts under a version nobody approved`;
      if (job) {
        await this.failLoudly(store, job, auditRule, message, { deadLetter: true });
      } else {
        await recordAudit(
          store,
          decisionAuditEntry(
            decided,
            auditRule,
            "failed",
            approvedActions(decided),
            message,
          ),
        );
        await this.tellChat(accountId, `Approved by ${by}, but nothing ran: ${message}`);
      }
      return;
    }
    const actions = approvedActions(decided);
    try {
      const opts = await this.actionOpts(accountId, actions, job);
      // The draft the run left is what an approval sends, even when the job
      // document that recorded it is already pruned.
      if (decided.draft) {
        opts.draftEmailId = decided.draft.emailId;
        opts.draftMailboxId = decided.draft.mailboxId;
      }
      // The job is marked in flight, carrying the plan it is about to run, and
      // the intent is in the trail before the effects: a crash here is readable
      // rather than invisible, and a retry knows what was left to do.
      const approvedPlan: AgentProposal = {
        summary: decided.summary,
        actions,
        confidence: 1,
        draft: decided.draft ?? null,
      };
      if (job) {
        const marked = await this.writeJobIfCurrent(store, job.id, (latest) => ({
          ...latest,
          state: "running",
          proposal: approvedPlan,
        }));
        // The approval stands and nothing is run: with the document in somebody
        // else's hands, what a person approved is not this run's to run, and a
        // guess at it would be the effect nobody approved. The spent approval
        // is recorded by the pass the sweep makes.
        if (!marked) {
          this.deps.log(
            `${auditRule.name}: the job document moved under the approval, so nothing is run`,
          );
          return;
        }
      }
      await recordAudit(
        store,
        job
          ? auditEntry(job, auditRule, "running", actions, byLine(by, decided))
          : decisionAuditEntry(
              decided,
              auditRule,
              "running",
              actions,
              byLine(by, decided),
            ),
      );
      const landed: string[] = [];
      await runActions(this.deps.ctx, accountId, actions, opts, {
        onApplied: async (action: AgentAction, result: ActionResult) => {
          landed.push(action.do);
          if (!job) return;
          const wrote = effectsOf(result, this.deps.now().toISOString());
          const recorded = await this.writeJobIfCurrent(store, job.id, (latest) => ({
            ...latest,
            applied: [...landed],
            ...(wrote.length ? { effects: [...(latest.effects ?? []), ...wrote] } : {}),
          }));
          if (!recorded)
            throw new RefusedError(
              "the job document moved while this approval was running, so what it " +
                "did is not recorded: nothing more is run",
            );
        },
      });
      if (job)
        await this.writeJobIfCurrent(store, job.id, (latest) =>
          closeState({ ...latest, applied: [...landed] }, "done"),
        );
      await recordAudit(
        store,
        job
          ? auditEntry(job, auditRule, "done", actions, byLine(by, decided))
          : decisionAuditEntry(decided, auditRule, "done", actions, byLine(by, decided)),
      );
      if (job) await this.labelQuietly(accountId, processedLabel(), job.trigger.emailId);
      await this.tellChat(accountId, `Approved by ${by}: ${decided.summary}`);
    } catch (err) {
      const message = errorMessage(err);
      if (job) await this.failLoudly(store, job, auditRule, message);
      else {
        await recordAudit(
          store,
          decisionAuditEntry(decided, auditRule, "failed", actions, message),
        );
        await this.tellChat(accountId, `Approved by ${by}, but it failed: ${message}`);
      }
    }
  }

  /**
   * The draft-leaving-Drafts rule (ADR resolution 10).
   *
   * A pending decision whose draft is no longer in the Drafts mailbox was sent
   * by a person, and what they sent — edits included — is what was approved.
   * That wins over the conversational reply, so it is settled here, and a draft
   * that vanished entirely is not an approval at all: nothing can be sent from
   * it.
   */
  async sweepDrafts(
    accountId: string,
    decisionIds: ReadonlyArray<string>,
  ): Promise<string[]> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const closed: string[] = [];
    for (const id of decisionIds) {
      const found = await store.readDecision(id);
      const decision = found?.doc;
      if (!found || !decision || decision.state !== "pending" || !decision.draft)
        continue;
      const record = await fetchEmailRecord(
        this.deps.client,
        accountId,
        decision.draft.emailId,
        {},
      );
      const inDrafts = record?.mailboxIds?.[decision.draft.mailboxId] === true;
      if (inDrafts) continue;
      if (!record) {
        const expired: AgentDecision = {
          ...decision,
          state: "expired",
          decidedBy: "draft",
          decidedAt: this.deps.now().toISOString(),
        };
        try {
          await store.writeDecision(expired, { ifInState: found.state });
        } catch (err) {
          if (isStateMismatch(err)) continue;
          throw err;
        }
        const job = (await store.readJob(decision.jobId))?.doc;
        if (job)
          await this.writeJobIfCurrent(store, job.id, (latest) =>
            closeState(latest, "done"),
          );
        closed.push(decision.id);
        continue;
      }
      await this.settleSentDraft(store, accountId, found, "draft");
      closed.push(decision.id);
    }
    return closed;
  }

  /**
   * Close a decision a person settled by sending the draft themselves.
   *
   * The send already happened — they did it — so the send action is not run
   * again; everything else the proposal asked for still is. What they sent,
   * edits included, is what was approved (ADR resolution 10).
   */
  private async settleSentDraft(
    store: AgentStore,
    accountId: string,
    found: AgentDoc<AgentDecision>,
    by: string,
  ): Promise<void> {
    const decision = found.doc;
    const decided: AgentDecision = {
      ...decision,
      state: "approved",
      decidedBy: by,
      decidedAt: this.deps.now().toISOString(),
    };
    // The stamp every consumption path leaves: the decision has been acted on,
    // once, at this instant. Sending the draft is a way of answering, and it
    // consumes the decision exactly as a "yes" in the chat does.
    decided.appliedAt = decided.decidedAt;
    try {
      await store.writeDecision(decided, { ifInState: found.state });
    } catch (err) {
      if (isStateMismatch(err)) return;
      throw err;
    }
    const job = (await store.readJob(decision.jobId))?.doc ?? null;
    const rule = await this.ruleOf(store, decision.ruleId);
    const auditRule: AuditRule = rule ?? {
      id: decision.ruleId,
      name: "the rule is gone",
      version: decision.ruleVersion,
    };
    const actions = decision.actions.filter(
      (action) =>
        action.do !== "mail.send" && !(action.do === "mail.draft" && decision.draft),
    );
    if (rule && rule.version !== decided.ruleVersion) {
      const message =
        `the decision pins rule version ${decided.ruleVersion} and the rule is ` +
        `at version ${rule.version}: a run never starts under a version nobody approved`;
      if (job) {
        await this.failLoudly(store, job, auditRule, message, { deadLetter: true });
      } else {
        await recordAudit(
          store,
          decisionAuditEntry(decided, auditRule, "failed", actions, message),
        );
        await this.tellChat(
          accountId,
          `Sent from the group's Drafts, but nothing ran: ${message}`,
        );
      }
      return;
    }
    const detail = `sent from the group's Drafts by ${by} at ${decided.appliedAt}`;
    try {
      // Intent before effect, as everywhere else: the trail says what is about
      // to run before it runs, so a crash between the two leaves a line that
      // accounts for the effect instead of an effect nobody can read.
      await recordAudit(
        store,
        job
          ? auditEntry(job, auditRule, "running", actions, detail)
          : decisionAuditEntry(decided, auditRule, "running", actions, detail),
      );
      if (actions.length)
        await runActions(
          this.deps.ctx,
          accountId,
          actions,
          await this.actionOpts(accountId, actions, job),
        );
      if (job)
        await this.writeJobIfCurrent(store, job.id, (latest) =>
          closeState(latest, "done"),
        );
      await recordAudit(
        store,
        job
          ? auditEntry(job, auditRule, "done", actions, detail)
          : decisionAuditEntry(decided, auditRule, "done", actions, detail),
      );
      if (job) await this.labelQuietly(accountId, processedLabel(), job.trigger.emailId);
      await this.tellChat(accountId, `Sent from the group's Drafts: ${decided.summary}`);
    } catch (err) {
      const message = errorMessage(err);
      if (job) await this.failLoudly(store, job, auditRule, message);
      else
        await recordAudit(
          store,
          decisionAuditEntry(decided, auditRule, "failed", actions, message),
        );
    }
  }

  /**
   * Answer the pending decisions a member's chat message resolves.
   *
   * Approval is conversational: a direct reply to the proposal, or — when
   * exactly one decision is pending — a message that mentions the agent. An
   * answer that is not an unambiguous yes or no gets one closed question back,
   * asked once, because a guessed approval is exactly what resolution 10
   * forbids.
   */
  async answerDecisions(
    accountId: string,
    messages: ReadonlyArray<ChatMessage>,
  ): Promise<string[]> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const pending = (await store.listDecisions())
      .map((entry) => entry.doc)
      .filter((decision) => decision.state === "pending" && decision.chatId);
    if (!pending.length) return [];
    const byId = indexChat(messages);
    const answered: string[] = [];
    for (const decision of pending) {
      const proposal = decision.chatId ? byId.get(decision.chatId) : undefined;
      if (!proposal) continue;
      const candidates = messages
        .filter(
          (message) =>
            message.from !== this.deps.address && message.created > proposal.created,
        )
        .sort(compareMessages);
      const replies = candidates.filter((message) => message.replyTo === proposal.id);
      const fallback =
        pending.length === 1
          ? candidates.filter((message) => mentionsName(message.text, this.deps.address))
          : [];
      const answer = replies[replies.length - 1] ?? fallback[fallback.length - 1];
      if (!answer) continue;
      const verdict = readApproval(answer.text);
      if (verdict === "unclear") {
        const alreadyAsked = messages.some(
          (message) =>
            message.from === this.deps.address && message.replyTo === answer.id,
        );
        if (!alreadyAsked)
          await postMessage(
            this.deps.ctx,
            accountId,
            this.deps.address,
            `Answer "yes" to approve or "no" to reject this, please.`,
            answer.id,
          );
        continue;
      }
      await this.resolveApproval(accountId, decision, verdict === "yes", answer.from);
      answered.push(decision.id);
    }
    return answered;
  }

  /**
   * One folder slice, for a run a person asked to widen (ADR 0003 resolution
   * 11). Bounded twice: the newest `CHAT_CONTEXT_DEFAULT` messages of that
   * folder, and headers only — a folder can hold years of a group's mail, and
   * the smallest slice that answers the question is the right one.
   */
  private async folderSlice(accountId: string, name: string): Promise<string> {
    const mailboxId = await findMailboxByName(this.deps.client, accountId, name);
    if (!mailboxId) return `(there is no folder called "${name}" in this account)`;
    const result = await this.deps.client.chain(
      [
        [
          "Email/query",
          {
            accountId,
            filter: { inMailbox: mailboxId },
            sort: [{ property: "receivedAt", isAscending: false }],
            limit: CHAT_CONTEXT_DEFAULT,
          },
          "q",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["id", "from", "subject", "receivedAt"],
          },
          "g",
        ],
      ],
      [JMAP_MAIL],
    );
    return renderFolderSlice(name, result.list<AgentEmailView>("g"));
  }

  private async ruleOf(store: AgentStore, ruleId: string): Promise<AgentRule | null> {
    const rules = (await store.readRules())?.doc ?? [];
    return rules.find((rule) => rule.id === ruleId) ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Schedule                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Plan the account's time triggers and arm the timers. The worker holds the
   * disposer; the entries are re-planned from the document every time, so a
   * crash costs only the wait until the next pass.
   *
   * A timer that has fired is spent, and the entry it fired for has moved on in
   * the document by then: the next arming is planned again from what the
   * document says, so a rule due every week fires every week rather than once
   * in the life of the process.
   */
  async armSchedule(
    accountId: string,
    opts: { maxDelayMs: number },
  ): Promise<() => void> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const rules = (await store.readRules())?.doc ?? [];
    const scheduleDoc = await store.readSchedule();
    const stored = scheduleDoc?.doc ?? [];
    const owned = await this.ownScheduleRules(store, rules);
    const planned = planSchedule(rules, this.deps.now(), stored);
    await this.writeSchedule(
      store,
      carryingForeign(planned, stored, rules, owned),
      scheduleDoc?.state,
    );
    let stopped = false;
    let dispose: (() => void) | null = null;
    const arm = async (): Promise<void> => {
      if (stopped) return;
      // The rules and the document are read again at every arming, the same
      // pass-shaped read the catch-up does, so a schedule edited while the
      // worker waited is armed as it now is — and only the entries of the
      // account this worker holds are armed: nothing else is its own to fire.
      dispose?.();
      const current = (await store.readRules())?.doc ?? [];
      const doc = await store.readSchedule();
      const mine = await this.ownScheduleRules(store, current);
      dispose = armTimers(
        planSchedule(current, this.deps.now(), doc?.doc ?? []).filter((entry) =>
          mine.has(entry.ruleId),
        ),
        (entry) => {
          void this.fireScheduled(accountId, entry)
            .then(() => arm())
            .catch((err: unknown) =>
              this.deps.log(`scheduled run failed: ${errorMessage(err)}`),
            );
        },
        { maxDelayMs: opts.maxDelayMs },
      );
    };
    await arm();
    return () => {
      stopped = true;
      dispose?.();
    };
  }

  /**
   * The schedule rules this worker holds.
   *
   * A claim is the account's and the schedule is one document per account, so
   * the worker that holds the account holds every entry of its schedule.
   * Planning, firing or advancing an entry it does not hold would take a run
   * away from the worker that does — and leave nothing anywhere saying the
   * group's automation did not happen.
   */
  private async ownScheduleRules(
    store: AgentStore,
    rules: ReadonlyArray<AgentRule>,
  ): Promise<Set<string>> {
    const mine = new Set<string>();
    const claim = (await store.readClaim())?.doc;
    if (claim?.worker !== this.deps.workerId) return mine;
    for (const rule of rules) mine.add(rule.id);
    return mine;
  }

  /**
   * Put the due runs nothing could run in the trail.
   *
   * A due run is normally fired late rather than dropped, so what vanishes is
   * the run whose rule is off: the schedule moves on and the group's automation
   * simply did not happen. That is worth a line.
   */
  private async recordMissedRuns(
    store: AgentStore,
    rules: ReadonlyArray<AgentRule>,
    due: ReadonlyArray<AgentScheduleEntry>,
  ): Promise<void> {
    for (const entry of unrunEntries(due, rules)) {
      const found = rules.find((candidate) => candidate.id === entry.ruleId);
      const rule: AuditRule = found ?? {
        id: entry.ruleId,
        name: "the rule is gone",
        version: 0,
      };
      await recordAudit(
        store,
        missedAuditEntry(
          rule,
          entry.at,
          found
            ? "the run was due and its rule was not enabled, so nothing ran"
            : "the run was due and its rule is no longer there, so nothing ran",
        ),
      );
      this.deps.log(`${entry.ruleId}: the run due at ${entry.at} did not happen`);
    }
  }

  /**
   * The entries that are already due: catch-up after a worker was away.
   *
   * A pass is what reaches it — a time trigger is not a change, so nothing
   * wakes the worker for one — and each due run is started with the claim on
   * its own account's claim, because the schedule is the account's.
   */
  async runDueSchedules(accountId: string): Promise<number> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const rules = (await store.readRules())?.doc ?? [];
    const scheduleDoc = await store.readSchedule();
    const stored = scheduleDoc?.doc ?? [];
    // Due is read from what the document says, not from the re-planned entries:
    // planning moves a past entry to its next instant, so asking the planned
    // list what is due answers "nothing" for ever.
    const due = dueEntries(stored, this.deps.now());
    const planned = planSchedule(rules, this.deps.now(), stored);
    if (!due.length) {
      if (!scheduleDoc) await this.writeSchedule(store, planned, undefined);
      return 0;
    }
    const owned = await this.ownScheduleRules(store, rules);
    // Only the entries this worker holds are fired from here: a due entry it does
    // not hold keeps its instant for the worker that does, rather than being
    // moved on and run nowhere.
    const mine = due.filter((entry) => owned.has(entry.ruleId));
    const next = carryingForeign(
      advance(planned, mine, rules, this.deps.now()),
      stored,
      rules,
      owned,
    );
    await this.writeSchedule(store, next, scheduleDoc?.state);
    const pass = await this.jobIndex(store);
    let started = 0;
    for (const entry of mine) {
      const rule = rules.find((candidate) => candidate.id === entry.ruleId);
      // The entry is not started here when no rule can run it: the run is
      // recorded as missed by the pass instead of being started under a rule
      // the clock no longer wakes (see `unrunEntry`).
      if (!rule || unrunEntry(entry, rules)) continue;
      // Read again where the run starts: the lease can lapse between the read
      // that chose the entry and this one, and a unit that is not this worker's
      // is not this worker's to start.
      const claim = (await store.readClaim())?.doc;
      if (claim?.worker !== this.deps.workerId) {
        this.deps.log(
          `${rule.name}: the account's automation is not held by this worker, so the run due at ${entry.at} is not started`,
        );
        continue;
      }
      await this.startJob(
        store,
        accountId,
        rule,
        { on: "schedule", at: entry.at },
        pass,
        claim,
      );
      started += 1;
    }
    // Recorded **after** the schedule write: an audit write is a write to the
    // same account, and doing it first would invalidate the state the
    // conditional schedule write carries.
    await this.recordMissedRuns(store, rules, due);
    return started;
  }

  /**
   * One entry fired by its timer: run the rule and move the entry on.
   *
   * The entry is moved on only by the worker that holds the account. One
   * that does not is left where it is, still due, for the worker that does —
   * and one whose rule can no longer run is left for the pass, which drops it
   * and records it as a missed run.
   */
  private async fireScheduled(
    accountId: string,
    entry: AgentScheduleEntry,
  ): Promise<void> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const rules = (await store.readRules())?.doc ?? [];
    const rule = rules.find((candidate) => candidate.id === entry.ruleId);
    const scheduleDoc = await store.readSchedule();
    // A rule that is off, gone, or no longer on the clock leaves the entry to
    // the pass, which drops it from the document and records it as a missed
    // run; nothing here consumes it.
    if (!rule || unrunEntry(entry, rules)) return;
    // A timer fires outside any reconcile, so the unit is read where the
    // worker's claim lives: a schedule that outlived the worker's lease does
    // not start a run nobody can fence, and it does not consume the entry
    // either — its holder fires it.
    const claim = (await store.readClaim())?.doc;
    if (claim?.worker !== this.deps.workerId) {
      this.deps.log(
        `${rule.name}: the account's automation is not held by this worker, so the run due at ${entry.at} is left to its holder`,
      );
      return;
    }
    const stored = scheduleDoc?.doc ?? [];
    const owned = await this.ownScheduleRules(store, rules);
    const next = carryingForeign(
      advance(
        planSchedule(rules, this.deps.now(), stored),
        [entry],
        rules,
        this.deps.now(),
      ),
      stored,
      rules,
      owned,
    );
    await this.writeSchedule(store, next, scheduleDoc?.state);
    const pass = await this.jobIndex(store);
    await this.startJob(
      store,
      accountId,
      rule,
      { on: "schedule", at: entry.at },
      pass,
      claim,
    );
  }

  private async writeSchedule(
    store: AgentStore,
    entries: ReadonlyArray<AgentScheduleEntry>,
    ifInState: string | undefined,
  ): Promise<void> {
    try {
      await store.writeSchedule([...entries], ifInState ? { ifInState } : {});
    } catch (err) {
      // Losing the write means somebody else planned it first; the schedule is
      // re-planned from the document on the next pass either way.
      if (!isStateMismatch(err)) throw err;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Housekeeping                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * An approval that was consumed and no run accounts for.
   *
   * A decision is stamped as consumed — `state: approved`, `appliedAt` — in the
   * write that takes it out of `pending`, before any effect runs, so that two
   * answers arriving together cannot act on it twice. A process that dies
   * between that stamp and the effects leaves the approval spent and silent:
   * the job it names still waits on the person who answered, nothing walks it,
   * and the trail says only that an approval was given. This is where that
   * decision is found and recorded: the failure, the message marked for a
   * person, and the group's chat naming the rule — the same three the failing
   * run writes, because a spent approval belongs in the same place.
   *
   * What the decision asked for is never run here. The stamp says the effects
   * were about to happen, not that they did, and an effect nobody can account
   * for is worse than one that did not happen: the message may already have
   * gone out, and a second send is the one thing an approval is arranged to
   * prevent.
   */
  private async recoverSpentApprovals(
    store: AgentStore,
    rules: ReadonlyArray<AgentRule>,
  ): Promise<number> {
    let recovered = 0;
    for (const { doc: decision } of await store.listDecisions()) {
      if (decision.state !== "approved" && !decision.appliedAt) continue;
      const job = (await store.readJob(decision.jobId))?.doc;
      // A job that is gone has nothing left to close: the documents a finished
      // run leaves are pruned together, decision and job alike.
      if (!job) continue;
      // A closed job is a run that happened, and a `running` one is a worker's:
      // the sweep resumes that, and the outcome it writes is the one to read.
      if (job.state === "done" || job.state === "failed") continue;
      if (job.state === "running") continue;
      const rule = rules.find((candidate) => candidate.id === decision.ruleId) ?? {
        id: decision.ruleId,
        name: "the rule is gone",
        version: decision.ruleVersion,
      };
      const at =
        decision.appliedAt ?? decision.decidedAt ?? "an instant it did not record";
      await this.failLoudly(
        store,
        job,
        rule,
        `this run was approved by ${decision.decidedBy ?? "a person"} at ${at} and ` +
          "no effect of it was ever recorded: nothing is run a second time on a guess",
        { deadLetter: true },
      );
      recovered += 1;
    }
    return recovered;
  }

  /**
   * Retry the jobs a failed run left pending, and record the approvals that
   * were consumed with no run to account for them.
   */
  async runPending(accountId: string): Promise<number> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const rules = await this.rulesOrReport(store, accountId, "the pending sweep");
    if (!rules) return 0;
    const spent = await this.recoverSpentApprovals(store, rules);
    if (spent) this.deps.log(`${accountId}: ${spent} spent approval(s) recorded`);
    if (!rules.length) return 0;
    let ran = 0;
    for (const entry of await store.listJobs()) {
      const job = entry.doc;
      const rule = rules.find((candidate) => candidate.id === job.ruleId);
      if (job.state === "running") {
        // A job still `running` belongs to the worker that wrote that state.
        // Only when its heartbeat is older than the tolerance is it anybody
        // else's — and then it is picked up here, which is what makes a crash
        // mid-run recoverable instead of a document nobody ever closes (it
        // also holds the deduplication key for its trigger, so leaving it open
        // stops every later run of the same rule).
        if (!this.abandoned(job)) continue;
        if (!rule?.enabled || job.attempts >= JOB_MAX_ATTEMPTS) {
          await this.expire(store, job, rule);
          continue;
        }
      } else if (job.state !== "pending") {
        continue;
      }
      if (!rule?.enabled) continue;
      // A failure waits before its next attempt; the wait is the job's, not the
      // pass's, so a job inside its backoff is simply not due yet.
      if (
        job.nextAttemptAt &&
        Date.parse(job.nextAttemptAt) > this.deps.now().getTime()
      ) {
        continue;
      }
      // One job's failure is that job's: `runJob` reports its own and the sweep
      // goes on, so a job that cannot be recorded — a rule document nobody can
      // read, a store that refused a write — does not hold back the ones behind
      // it in the list.
      // The fence is the worker's claim on the unit, so a job is run only by a
      // worker that holds one: a sweep that ran work it does not own would be
      // the very double execution the fence exists to stop.
      const claim = (await store.readClaim())?.doc;
      if (!claim) {
        this.deps.log(
          `${accountId}: nothing holds the account's automation, so job ${job.id} is not run`,
        );
        continue;
      }
      try {
        await this.runJob(accountId, job, rule, claim);
        ran += 1;
      } catch (err) {
        this.deps.log(
          `${accountId}: job ${job.id} failed outside the job's own handling: ${errorMessage(err)}`,
        );
      }
    }
    return ran;
  }

  /**
   * Whether a `running` job has lost the worker that wrote that state.
   *
   * The heartbeat is the only witness: a worker that crashed leaves no note,
   * and a lease that has not been renewed for longer than the tolerance means
   * nobody is holding the unit it belonged to.
   */
  private abandoned(job: AgentJob): boolean {
    const lease = job.lease;
    if (!lease) return true;
    return leaseExpired(
      lease.heartbeatAt,
      this.deps.now().getTime(),
      config.agent.leaseMs,
    );
  }

  /** When a failed job may try again: exponential, with jitter, and bounded. */
  private retryAt(attempts: number): string {
    const step = RETRY_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
    const base = Math.min(RETRY_BACKOFF_MAX_MS, step);
    const wait = base + Math.floor(Math.random() * base);
    return new Date(this.deps.now().getTime() + wait).toISOString();
  }

  /**
   * Close a run nobody came back for, with an outcome that says so.
   */
  private async expire(
    store: AgentStore,
    job: AgentJob,
    rule: AgentRule | undefined,
  ): Promise<void> {
    const why = rule
      ? `no worker came back for this run (attempt ${job.attempts || 1} of ${JOB_MAX_ATTEMPTS})`
      : `the automation this run belongs to is gone, so nothing will resume it`;
    await this.failLoudly(
      store,
      job,
      rule ?? {
        id: job.ruleId,
        name: "the deleted automation",
        version: job.ruleVersion,
      },
      why,
      { outcome: "timeout", deadLetter: true },
    );
  }

  /**
   * Drop the job and decision documents that are finished and old. The audit is
   * what lasts (ADR 0003: one document per month, 12 months); these are the
   * working documents an operator reads for a while.
   */
  /**
   * Drop audit documents older than the declared retention.
   *
   * The audit is the record of what an agent did and it lasts twelve months
   * (ADR 0003). The documents sit in the group's own hidden `gilbert` app
   * folder — where a member reads them through the group's agent surface, and
   * where an administrator takes the copy `groupAuditExport` hands over — so
   * this is the only thing that ever removes one, and it removes whole months,
   * never entries inside one.
   */
  async pruneAudit(accountId: string, keepFrom: Date): Promise<number> {
    const nodes = await listAppDir(
      this.deps.ctx,
      accountId,
      `${AGENT_DIR}/${AGENT_AUDIT_DIR}`,
    );
    const limit = monthOf(keepFrom);
    let removed = 0;
    for (const node of nodes) {
      const name = typeof node.name === "string" ? node.name : "";
      const month = name.replace(/\.json$/, "");
      // `YYYY-MM` sorts as it reads, so the comparison is the whole rule.
      if (!/^\d{4}-\d{2}$/.test(month) || month >= limit) continue;
      await destroyAppNode(this.deps.ctx, accountId, String(node.id));
      removed++;
    }
    return removed;
  }

  async prune(accountId: string, olderThan: Date): Promise<number> {
    const store = new AgentStore(this.deps.ctx, accountId);
    /*
     * A finished job whose own write the account has still to report is what
     * names the wake its change makes, so its document waits for the pass that
     * reads past the write: pruning it first would reset that chain to hop one
     * (ADR 0010). Once a pass has read past it, the ordinary retention applies.
     */
    const anchors = (await store.readClaim())?.doc.statesAt ?? {};
    let removed = 0;
    for (const { doc } of await store.listJobs()) {
      if (doc.state !== "done" && doc.state !== "failed") continue;
      if (Date.parse(doc.updatedAt) > olderThan.getTime()) continue;
      if (stillUnread(doc, anchors)) continue;
      await store.destroyJob(doc.id);
      removed += 1;
    }
    for (const { doc } of await store.listDecisions()) {
      if (doc.state === "pending") continue;
      if (Date.parse(doc.updatedAt) > olderThan.getTime()) continue;
      await store.destroyDecision(doc.id);
      removed += 1;
    }
    return removed;
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

interface FileNodeRecord {
  id?: unknown;
  name?: unknown;
  parentId?: unknown;
  nodeType?: unknown;
  size?: unknown;
}

/** One job per rule and trigger: the durable half of at-least-once delivery. */
function jobKey(ruleId: string, trigger: AgentTriggerRecord): string {
  return `${ruleId}:${trigger.on}:${changeIdOf(trigger)}`;
}

/**
 * A record an action wrote, read from the result the action handed back.
 *
 * The result is the only place the ids are: an action reports what it changed,
 * and the change the executor is told about later names the same id. The instant
 * is when the action returned, which is what tells that write from an earlier
 * one to the same record. An action whose result names nothing — a `noop`, a
 * write the server gave no node for — contributes nothing rather than a guess.
 */
function effectsOf(result: ActionResult, at: string): AgentEffect[] {
  const wrote: AgentEffect[] = [];
  const named = result.result ?? {};
  if (typeof named.emailId === "string" && named.emailId)
    wrote.push({ type: "Email", id: named.emailId, at });
  const nodes = [named.nodeId, ...(Array.isArray(named.nodeIds) ? named.nodeIds : [])];
  for (const node of nodes)
    if (typeof node === "string" && node) wrote.push({ type: "FileNode", id: node, at });
  return wrote;
}

/** What one pass knows about the changes it is reporting. */
interface Pass {
  /** Which triggers are already a job: the durable half of at-least-once. */
  keys: Set<string>;
  /** The write that moved each record, by `kind:id`. */
  producers: ReadonlyMap<string, Producer>;
  /** When the state this pass reads from was observed, when the claim says. */
  since?: string;
}

/**
 * A write that moved a record, and the run that made it.
 *
 * The hop is that run's own, so a run woken by it is one hop further, and the
 * instant is when the write landed, which is what makes it the explanation of a
 * change rather than an earlier write to the same record (ADR 0010).
 */
interface Producer {
  jobId: string;
  hop: number;
  at: string;
}

/** The key a record's producer is looked up by: its kind, then its id. */
function producerKey(type: AgentEffect["type"], id: string): string {
  return `${type}:${id}`;
}

/**
 * Which write moved each record, by `kind:id`.
 *
 * A chain's lineage is read from the account's own job documents: a change names
 * the record that moved, and this says which run moved it and when. Two runs can
 * have written the same record — two automations reacting to one message both
 * label it — so the later write wins, and two writes at one instant are ordered
 * by depth and then by the job, which makes the answer the same one on every
 * worker that reads the same documents.
 *
 * A write with no instant recorded is left out: it cannot be told from a write
 * that came before the change being reported, so it explains nothing.
 */
function producersOf(jobs: ReadonlyArray<AgentJob>): Map<string, Producer> {
  const out = new Map<string, Producer>();
  for (const job of jobs) {
    const hop = hopOf(job.trigger);
    for (const effect of job.effects ?? []) {
      if (!effect.at) continue;
      const candidate: Producer = { jobId: job.id, hop, at: effect.at };
      const key = producerKey(effect.type, effect.id);
      const found = out.get(key);
      if (!found || later(candidate, found)) out.set(key, candidate);
    }
  }
  return out;
}

/** Whether one write to a record outranks another: later first, then deeper. */
function later(candidate: Producer, found: Producer): boolean {
  if (candidate.at !== found.at) return candidate.at > found.at;
  if (candidate.hop !== found.hop) return candidate.hop > found.hop;
  return candidate.jobId > found.jobId;
}

/**
 * The run whose own write caused this wake, or null when no run's write did.
 *
 * Two triggers name a record a run's own effect can write: a message change and
 * a file change. A chat rule wakes when a person addresses the agent — the
 * agent's own messages are not requests, so a chat turn always has somebody in
 * it — and the clock and a person's ask wake theirs with nothing behind them.
 * Those are hop one, which is what the count starting at the trigger means.
 *
 * The write explains the change only when it landed inside the window this pass
 * reports: a record a run wrote before the state the pass reads from has moved
 * for some other reason since — a person who labelled or read it, a rule of
 * another group, the mail store itself — and that change is not the run's.
 * JMAP's changes name no instant per record, so the anchor is what stands in for
 * one: a write after the anchor is inside what this pass is reporting, and one
 * before it has already been reported.
 */
function wokenBy(trigger: AgentTriggerRecord, pass: Pass): Producer | null {
  const key =
    trigger.on === "email" && trigger.emailId
      ? producerKey("Email", trigger.emailId)
      : trigger.on === "filenode" && trigger.nodeId
        ? producerKey("FileNode", trigger.nodeId)
        : "";
  if (!key) return null;
  const producer = pass.producers.get(key);
  if (!producer || !pass.since || producer.at < pass.since) return null;
  return producer;
}

/**
 * Whether a pass still has to report a finished run's own write.
 *
 * A change is reported from the state a pass reads from, so a run whose effect
 * landed after that state is the run whose change is still to come: its document
 * is kept until the pass of that kind has read past the write. An effect with no
 * instant, or a kind the claim records no anchor for, is nothing to wait for.
 */
function stillUnread(job: AgentJob, anchors: Readonly<Record<string, string>>): boolean {
  for (const effect of job.effects ?? []) {
    const anchor = anchors[effect.type];
    if (!anchor || !effect.at) continue;
    if (effect.at >= anchor) return true;
  }
  return false;
}

/** A job in a terminal state, with the lease cleared. */
function closeState(job: AgentJob, state: "done" | "failed"): AgentJob {
  const closed: AgentJob = { ...job, state };
  delete closed.lease;
  return closed;
}

/** How long a failed job waits before trying again, and the ceiling on that. */
export const RETRY_BACKOFF_MS = 30_000;
export const RETRY_BACKOFF_MAX_MS = 5 * 60_000;

/** The plan a run has to execute, as the job stores it. */
function proposalOf(plan: RunPlan): AgentProposal {
  const proposal: AgentProposal = {
    summary: plan.summary,
    actions: plan.actions,
    confidence: plan.confidence,
    draft: null,
  };
  if (plan.rationale) proposal.rationale = plan.rationale;
  return proposal;
}

/** The plan a job already carries, so a retry resumes it rather than redeciding. */
function planOf(proposal: AgentProposal): RunPlan {
  const plan: RunPlan = {
    actions: proposal.actions,
    confidence: proposal.confidence,
    summary: proposal.summary,
    // A resumed run spends nothing on this pass: the deciding call it resumes
    // was already counted when it was made.
    usage: EMPTY_USAGE,
  };
  if (proposal.rationale) plan.rationale = proposal.rationale;
  return plan;
}

/**
 * How an approval reads in the trail: who answered, and the instant the
 * decision was consumed.
 *
 * The stamp (`appliedAt`) is what makes "answered once" checkable rather than
 * merely written, so the trail carries it instead of leaving it a field nobody
 * reads.
 */
function byLine(by: string, decision: AgentDecision): string {
  const at = decision.appliedAt ?? decision.decidedAt;
  return at ? `approved by ${by} at ${at}` : `approved by ${by}`;
}

/** The proposal as approved: a draft the run already left is not prepared twice. */
function approvedActions(decision: AgentDecision): AgentAction[] {
  return decision.actions.filter(
    (action) => !(action.do === "mail.draft" && decision.draft),
  );
}

function processedLabel(): AgentAction {
  return { do: "keyword.add", with: { keyword: AGENT_LABEL.processed } };
}

function rejectLabel(): AgentAction {
  return { do: "keyword.add", with: { keyword: AGENT_LABEL.rejected } };
}

/** Whether a filter reads the body: only then is the body fetched for matching. */

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function describeActions(results: ReadonlyArray<ActionResult>): string {
  return results.map((result) => result.action).join(", ") || "nothing";
}

/**
 * What a run did, in the words a person reads rather than the codes a log
 * keeps — the action catalogue's own labels, which is the one vocabulary the
 * server and the admin surface already share (ADR 0010: a run somebody asked
 * for says what it did where the group can read it).
 */
function describeActionsInWords(results: ReadonlyArray<ActionResult>): string {
  const words = results.map(
    (result) => agentActionSpec(result.action)?.label ?? result.action,
  );
  return words.join(", ") || "nothing";
}

function describeTrigger(trigger: AgentTriggerRecord): string {
  if (trigger.on === "manual")
    return `message ${trigger.emailId ?? "(gone)"}, asked for by a person`;
  if (trigger.on === "email") return `message ${trigger.emailId ?? "(gone)"}`;
  if (trigger.on === "filenode") return `file ${trigger.nodeId ?? "(gone)"}`;
  if (trigger.on === "chat") return `chat message ${trigger.chatId ?? "(gone)"}`;
  return `the schedule of ${trigger.at}`;
}

/**
 * A folder's messages as context: one header line each, never their bodies.
 *
 * The slice is a hint about what the group's mail looks like, not a second
 * read of it: the run that needs a message reads that message.
 */
export function renderFolderSlice(
  name: string,
  views: ReadonlyArray<AgentEmailView>,
): string {
  if (!views.length) return `FOLDER "${name}": no messages`;
  const lines = views.map((view) => {
    const from = (view.from ?? []).map((a) => a.email ?? a.name ?? "").join(", ");
    return `- ${view.receivedAt ?? "unknown"}  ${from}  ${view.subject ?? "(no subject)"}`;
  });
  return `FOLDER "${name}" (the ${views.length} most recent):\n\n${lines.join("\n")}`;
}

function renderEmail(heading: string, view: AgentEmailView): string {
  const from = (view.from ?? [])
    .map((address) => address.email ?? address.name ?? "")
    .join(", ");
  const subject = view.subject ?? "(no subject)";
  const body = view.body ?? "";
  return [
    heading,
    `From: ${from}`,
    `Subject: ${subject}`,
    `Received: ${view.receivedAt ?? "unknown"}`,
    "",
    body,
  ].join("\n");
}

function renderChatMessage(message: ChatMessage): string {
  return `${message.from} (${message.created}): ${message.text}`;
}

/** The proposal a member reads in the chat, and answers. */
function proposalText(rule: AgentRule, job: AgentJob): string {
  const proposal = job.proposal;
  if (!proposal) return `"${rule.name}" has something to ask.`;
  const lines = [`"${rule.name}" suggests: ${proposal.summary}`];
  if (proposal.rationale) lines.push(proposal.rationale);
  lines.push(
    `What it would do: ${proposal.actions.map((action) => action.do).join(", ")}.`,
  );
  if (proposal.draft)
    lines.push(
      "The message it prepared is in the group's Drafts, marked G-awaiting; sending it there counts as approval.",
    );
  lines.push('Answer "yes" or "no" in a reply.');
  return lines.join("\n");
}
