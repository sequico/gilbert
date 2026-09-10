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
  recordAudit,
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
  AGENT_AUDIT_DIR,
  AGENT_DIR,
  type AgentAction,
  type AgentArea,
  type AgentClaim,
  type AgentDecision,
  type AgentDraftRef,
  type AgentEmailView,
  type AgentJob,
  type AgentProposal,
  type AgentRule,
  type AgentScheduleEntry,
  type AgentTriggerRecord,
  CHAT_CONTEXT_DEFAULT,
  CHAT_CONTEXT_MAX,
  leaseExpired,
  matchEmailFilter,
  monthOf,
  newDecision,
  newJob,
  reviewOutcome,
  ruleProblem,
  UnsupportedFilterError,
  unsupportedFilterKey,
} from "./documents.js";
import { saveClaimStates } from "./lease.js";
import {
  classifyCategory,
  decideActions,
  type ModelContext,
  providerForTier,
} from "./llm.js";
import { advance, armTimers, dueEntries, planSchedule } from "./scheduler.js";
import { type AgentDoc, AgentStore } from "./store.js";

/** The JMAP types the executor reconciles, plus the schedule. */
export type ChangeType = "Email" | "FileNode" | "schedule";

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

/** What a tier decided to do, before the review gate saw it. */
interface RunPlan {
  actions: AgentAction[];
  confidence: number;
  summary: string;
  rationale?: string;
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
    if (type === "schedule") {
      await this.fireDueSchedule(store, accountId);
      return;
    }
    const since = claim.states[type] ?? "0";
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
      );
      return;
    }
    const ids = [...new Set([...changes.created, ...changes.updated])];
    if (ids.length) {
      const rules = (await store.readRules())?.doc ?? [];
      if (type === "Email") await this.emailRecords(store, accountId, ids, rules);
      else await this.fileRecords(store, accountId, ids, rules);
    }
    await this.recordState(store, claim, type, changes.newState);
  }

  private async recordState(
    store: AgentStore,
    claim: AgentClaim,
    type: string,
    state: string,
  ): Promise<void> {
    await saveClaimStates(store, claim, { [type]: state });
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
      const bad = unsupportedFilterKey(rule.trigger.filter);
      if (!bad) {
        usable.push(rule);
        continue;
      }
      await this.refuseTrigger(
        store,
        accountId,
        rule,
        { on: "email", at: this.deps.now().toISOString() },
        `this executor does not understand the filter "${bad}"`,
      );
    }
    if (!usable.length) return;
    const keys = await this.jobKeys(store);
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
        await this.startJob(store, accountId, rule, trigger, keys);
      }
    }
  }

  /** FileNodes: a chat message wakes the chat rules, a file wakes the file ones. */
  private async fileRecords(
    store: AgentStore,
    accountId: string,
    ids: ReadonlyArray<string>,
    rules: ReadonlyArray<AgentRule>,
  ): Promise<void> {
    const chatRules = rules.filter((rule) => rule.enabled && rule.trigger.on === "chat");
    const nodeRules = rules.filter(
      (rule) => rule.enabled && rule.trigger.on === "filenode",
    );
    if (!chatRules.length && !nodeRules.length) return;
    const nodes = await this.nodeRecords(accountId, ids);
    if (!nodes.length) return;
    const keys = await this.jobKeys(store);
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
            await this.startJob(store, accountId, rule, trigger, keys);
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
        await this.startJob(store, accountId, rule, trigger, keys);
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

  /** The deduplication key: one job per rule and trigger, whatever arrives twice. */
  private async jobKeys(store: AgentStore): Promise<Set<string>> {
    const jobs = await store.listJobs();
    return new Set(jobs.map((job) => jobKey(job.doc.ruleId, job.doc.trigger)));
  }

  private async startJob(
    store: AgentStore,
    accountId: string,
    rule: AgentRule,
    trigger: AgentTriggerRecord,
    keys: Set<string>,
  ): Promise<void> {
    const key = jobKey(rule.id, trigger);
    if (keys.has(key)) return;
    keys.add(key);
    const job = newJob({
      id: randomUUID(),
      accountId,
      area: rule.area,
      rule,
      trigger,
      now: this.deps.now().toISOString(),
    });
    await store.writeJob(job);
    await this.runJob(accountId, job, rule);
  }

  /* ---------------------------------------------------------------- */
  /* Running one job                                                  */
  /* ---------------------------------------------------------------- */

  async runJob(accountId: string, job: AgentJob, rule: AgentRule): Promise<void> {
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
      const plan = await this.planFor(accountId, running, rule);
      if (reviewOutcome(rule.review, plan.actions, plan.confidence) === "execute") {
        await this.execute(store, accountId, running, rule, plan);
      } else {
        await this.pause(store, accountId, running, rule, plan);
      }
    } catch (err) {
      const latest = (await store.readJob(job.id))?.doc ?? running;
      await this.failLoudly(store, latest, rule, errorMessage(err), {
        deadLetter: err instanceof RefusedError,
      });
    }
  }

  /** What the run should do: deterministic, classified, or decided by a model. */
  private async planFor(
    accountId: string,
    job: AgentJob,
    rule: AgentRule,
  ): Promise<RunPlan> {
    const problem = ruleProblem(rule);
    if (problem) throw new RefusedError(`the rule cannot run: ${problem}`);
    const context = await this.contextFor(accountId, job, rule);
    if (rule.tier === "T0") {
      const actions = rule.actions ?? [];
      await this.guardLabels(accountId, actions);
      return { actions, confidence: 1, summary: rule.name };
    }
    const configDoc = (await this.agentStore.readConfig())?.doc ?? null;
    if (rule.tier === "T1") {
      const answer = await classifyCategory(
        providerForTier(configDoc, "T1"),
        rule,
        context,
      );
      const category = (rule.categories ?? []).find((c) => c.name === answer.category);
      if (!category)
        throw new RefusedError(
          `no category named "${answer.category}" is defined on the rule any more`,
        );
      await this.guardLabels(accountId, category.actions);
      return {
        actions: category.actions,
        confidence: answer.confidence,
        summary: `${rule.name}: ${answer.category}`,
        ...(answer.rationale ? { rationale: answer.rationale } : {}),
      };
    }
    const answer = await decideActions(
      providerForTier(configDoc, "T2"),
      rule,
      context,
      rule.capabilities ?? [],
    );
    await this.guardLabels(accountId, answer.actions);
    return {
      actions: answer.actions,
      confidence: answer.confidence,
      summary: answer.summary,
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

  private async execute(
    store: AgentStore,
    accountId: string,
    job: AgentJob,
    rule: AgentRule,
    plan: RunPlan,
  ): Promise<void> {
    const results = await runActions(
      this.deps.ctx,
      accountId,
      plan.actions,
      await this.actionOpts(accountId, plan.actions, job),
    );
    const done = closeState(job, "done");
    await store.writeJob(done);
    await recordAudit(store, auditEntry(done, rule, "done", plan.actions, plan.summary));
    this.deps.log(
      `${rule.name}: ${describeActions(results)} for ${describeTrigger(job.trigger)}`,
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
  ): Promise<void> {
    const proposal: AgentProposal = {
      summary: plan.summary,
      actions: plan.actions,
      confidence: plan.confidence,
      draft: null,
    };
    if (plan.rationale) proposal.rationale = plan.rationale;
    const draft = await this.prepareDraft(accountId, plan);
    if (draft) proposal.draft = draft;
    const paused: AgentJob = {
      ...job,
      state: "awaiting_approval",
      proposal,
      decisionId: `${job.id}-d`,
    };
    // A paused job belongs to a person now, not to a worker: clearing the lease
    // keeps it out of the takeover path while it waits.
    delete paused.lease;
    await store.writeJob(paused);
    const chatId = await postMessage(
      this.deps.ctx,
      accountId,
      this.deps.address,
      proposalText(rule, paused),
      job.trigger.on === "chat" ? job.trigger.chatId : undefined,
    );
    await store.writeDecision(newDecision(paused, chatId));
    await recordAudit(
      store,
      auditEntry(paused, rule, "awaiting_approval", plan.actions, plan.summary),
    );
    this.deps.log(`${rule.name}: waiting for a person (${job.id})`);
  }

  /**
   * The draft a paused run leaves in the group's Drafts. A proposal that sends
   * mail needs something a member can read and send themselves, and a proposal
   * that only prepares a draft has already named it.
   */
  private async prepareDraft(
    accountId: string,
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
    const [result] = await runActions(this.deps.ctx, accountId, [action], {
      from: this.deps.address,
      now: this.deps.now(),
    });
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
      const window = conversationContext(
        messages,
        anchor?.created ?? this.deps.now().toISOString(),
        requested,
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
      return {
        text: node
          ? `A file changed: "${String(node.name ?? "")}" (${String(node.size ?? 0)} bytes).`
          : "(the file this run was triggered by is gone)",
      };
    }
    return {
      text: `The automation "${rule.name}" runs on its own, every ${
        rule.trigger.everyMinutes ?? 0
      } minutes.`,
    };
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
    opts: { deadLetter?: boolean } = {},
  ): Promise<void> {
    const final = opts.deadLetter === true || job.attempts >= JOB_MAX_ATTEMPTS;
    const failed: AgentJob = {
      ...job,
      state: final ? "failed" : "pending",
      error: message,
    };
    delete failed.lease;
    await store.writeJob(failed);
    const attempted = job.proposal?.actions ?? [];
    await recordAudit(
      store,
      auditEntry(
        failed,
        rule,
        "failed",
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
      area: rule.area,
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
   */
  async resolveApproval(
    accountId: string,
    decision: AgentDecision,
    approved: boolean,
    by: string,
  ): Promise<void> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const found = await store.readDecision(decision.id);
    if (!found || found.doc.state !== "pending") return;
    const current = found.doc;
    const decided: AgentDecision = {
      ...current,
      state: approved ? "approved" : "rejected",
      decidedBy: by,
      decidedAt: this.deps.now().toISOString(),
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
      if (job) await store.writeJob(closeState(job, "done"));
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
    const actions = approvedActions(decided);
    try {
      const opts = await this.actionOpts(accountId, actions, job);
      // The draft the run left is what an approval sends, even when the job
      // document that recorded it is already pruned.
      if (decided.draft) {
        opts.draftEmailId = decided.draft.emailId;
        opts.draftMailboxId = decided.draft.mailboxId;
      }
      await runActions(this.deps.ctx, accountId, actions, opts);
      if (job) await store.writeJob(closeState(job, "done"));
      await recordAudit(
        store,
        job
          ? auditEntry(job, auditRule, "done", actions, `approved by ${by}`)
          : decisionAuditEntry(decided, auditRule, "done", actions, `approved by ${by}`),
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
        if (job) await store.writeJob(closeState(job, "done"));
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
    const detail = `sent from the group's Drafts by ${by}`;
    try {
      if (actions.length)
        await runActions(
          this.deps.ctx,
          accountId,
          actions,
          await this.actionOpts(accountId, actions, job),
        );
      if (job) await store.writeJob(closeState(job, "done"));
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
   */
  async armSchedule(
    accountId: string,
    opts: { maxDelayMs: number },
  ): Promise<() => void> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const rules = (await store.readRules())?.doc ?? [];
    const scheduleDoc = await store.readSchedule();
    const planned = planSchedule(rules, this.deps.now(), scheduleDoc?.doc ?? []);
    await this.writeSchedule(store, planned, scheduleDoc?.state);
    return armTimers(
      planned,
      (entry) => {
        void this.fireScheduled(accountId, entry).catch((err: unknown) =>
          this.deps.log(`scheduled run failed: ${errorMessage(err)}`),
        );
      },
      { maxDelayMs: opts.maxDelayMs },
    );
  }

  /** The entries that are already due: catch-up after a worker was away. */
  private async fireDueSchedule(store: AgentStore, accountId: string): Promise<void> {
    const rules = (await store.readRules())?.doc ?? [];
    const scheduleDoc = await store.readSchedule();
    const stored = scheduleDoc?.doc ?? [];
    // Due is read from what the document says, not from the re-planned entries:
    // planning moves a past entry to its next instant, so asking the planned
    // list what is due answers "nothing" for ever.
    const due = dueEntries(stored, this.deps.now());
    const planned = planSchedule(rules, this.deps.now(), stored);
    if (due.length) {
      const next = advance(planned, due, rules, this.deps.now());
      await this.writeSchedule(store, next, scheduleDoc?.state);
      const keys = await this.jobKeys(store);
      for (const entry of due) {
        const rule = rules.find((candidate) => candidate.id === entry.ruleId);
        if (!rule?.enabled) continue;
        await this.startJob(
          store,
          accountId,
          rule,
          { on: "schedule", at: entry.at },
          keys,
        );
      }
      return;
    }
    if (!scheduleDoc) await this.writeSchedule(store, planned, undefined);
  }

  /** One entry fired by its timer: run the rule and move the entry on. */
  private async fireScheduled(
    accountId: string,
    entry: AgentScheduleEntry,
  ): Promise<void> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const rules = (await store.readRules())?.doc ?? [];
    const rule = rules.find((candidate) => candidate.id === entry.ruleId);
    const scheduleDoc = await store.readSchedule();
    const next = advance(
      planSchedule(rules, this.deps.now(), scheduleDoc?.doc ?? []),
      [entry],
      rules,
      this.deps.now(),
    );
    await this.writeSchedule(store, next, scheduleDoc?.state);
    if (!rule?.enabled) return;
    await this.startJob(
      store,
      accountId,
      rule,
      { on: "schedule", at: entry.at },
      await this.jobKeys(store),
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

  /** Retry the jobs a failed run left pending, in the areas this worker serves. */
  async runPending(accountId: string, areas: ReadonlyArray<AgentArea>): Promise<number> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const rules = (await store.readRules())?.doc ?? [];
    if (!rules.length) return 0;
    let ran = 0;
    for (const entry of await store.listJobs()) {
      const job = entry.doc;
      if (job.state !== "pending" || !areas.includes(job.area)) continue;
      const rule = rules.find((candidate) => candidate.id === job.ruleId);
      if (!rule?.enabled) continue;
      await this.runJob(accountId, job, rule);
      ran += 1;
    }
    return ran;
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
   * (ADR 0003). The documents sit in the group's own Files — which is also
   * where a member reads them and where an operator takes a copy before the
   * oldest goes — so this is the only thing that ever removes one, and it
   * removes whole months, never entries inside one.
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
    let removed = 0;
    for (const { doc } of await store.listJobs()) {
      if (doc.state !== "done" && doc.state !== "failed") continue;
      if (Date.parse(doc.updatedAt) > olderThan.getTime()) continue;
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
  const what = trigger.emailId ?? trigger.nodeId ?? trigger.chatId ?? trigger.at;
  return `${ruleId}:${what}`;
}

/** A job in a terminal state, with the lease cleared. */
function closeState(job: AgentJob, state: "done" | "failed"): AgentJob {
  const closed: AgentJob = { ...job, state };
  delete closed.lease;
  return closed;
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
function filterNeedsBody(filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return false;
  if (typeof filter.text === "string" || typeof filter.body === "string") return true;
  const conditions = filter.conditions;
  if (!Array.isArray(conditions)) return false;
  return conditions.some((condition) =>
    filterNeedsBody(condition as Record<string, unknown>),
  );
}

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function describeActions(results: ReadonlyArray<ActionResult>): string {
  return results.map((result) => result.action).join(", ") || "nothing";
}

function describeTrigger(trigger: AgentTriggerRecord): string {
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
