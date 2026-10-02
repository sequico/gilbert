/**
 * The executor: from a durable trigger to a recorded outcome.
 *
 * Everything here is derived from documents, so a crash costs only the work in
 * flight: the trigger is a job document, the pinned rule version is on it, the
 * pause is a decision document, and the lease is an owner plus a heartbeat. A
 * agent that dies mid-run leaves the job where the next agent finds it, and
 * the next agent reaches the same conclusion from the same state.
 *
 * The model's role (ADR 0003 resolution 7) is bounded twice: it decides only
 * inside the rule's own capability list, and every decision passes the review
 * policy before a single effect happens. `G-` labels are checked against the
 * group's own catalog before anything runs, because a keyword nobody renders
 * would be a state nobody can see.
 */
import { randomUUID } from "node:crypto";
import { readGroupLabels } from "../account.js";
import {
  AppFolderError,
  type Ctx,
  destroyAppNode,
  FILENODE_CAP,
  type FileNodeLike,
  fileChildren,
  filesAccountId,
  findAppFolder,
  findFolderPath,
  findVisibleFolder,
  listAppDir,
  readAppJsonAt,
  readVisibleFileBytes,
} from "../appFolder.js";
import { config } from "../config.js";
import { isStateMismatch, JMAP_MAIL, type JmapClient, JmapError } from "../jmap.js";
import { APP_FOLDER_NAME } from "../shared/appFolder.js";
import {
  CHAT_FOLDER,
  type ChatMessage,
  compareMessages,
  mentionsName,
  participantsOf,
} from "../shared/chat.js";
import {
  DRAFT_FILE,
  isKnowledgeDraft,
  isKnowledgeState,
  isReservedArticleName,
  isRetired,
  KNOWLEDGE_FOLDER,
  type KnowledgeState,
  plainTextFromBlocks,
  STATE_FILE,
} from "../shared/knowledge.js";
import { AGENT_LABEL, DRAFT_KEYWORD, SEEN_KEYWORD } from "../shared/labels.js";
import { buildFilter, parseQuery, resolveMailbox } from "../shared/search.js";
import {
  type ActionOpts,
  type ActionResult,
  draftRefOf,
  type EmailRecord,
  fetchEmailRecord,
  fetchEmailView,
  mailboxesOf,
  mailboxIdByRole,
  RefusedError,
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
  AGENT_CHAIN_HOPS_CEILING,
  AGENT_DIR,
  AGENT_DOCUMENT_BYTES_MAX,
  AGENT_INSTRUCTION_FILE,
  AGENT_LOOKUP_ARTICLES_MAX,
  AGENT_LOOKUP_DEPTH_MAX,
  AGENT_LOOKUP_FILES_MAX,
  AGENT_LOOKUP_MESSAGES_MAX,
  AGENT_LOOKUP_ROUNDS,
  AGENT_LOOKUP_TEXT_MAX,
  AGENT_PAGES_CEILING,
  AGENT_PREAMBLE_FILE,
  AGENT_RULES_FILE,
  type AgentAction,
  type AgentClaim,
  type AgentConfigDoc,
  type AgentDecision,
  type AgentDraftRef,
  type AgentEffect,
  type AgentEmailView,
  type AgentJob,
  type AgentKnowledgePlanPage,
  type AgentLookup,
  type AgentProposal,
  type AgentProvider,
  type AgentRule,
  type AgentScheduleEntry,
  type AgentTriggerRecord,
  actionParamsText,
  agentActionSpec,
  automationLabel,
  CHAT_CONTEXT_MAX,
  changeIdOf,
  claimEpoch,
  effectiveCapabilities,
  hopOf,
  leaseExpired,
  leavesTheProcess,
  lookupLabel,
  monthOf,
  newDecision,
  newJob,
  notebookFor,
  policyOf,
  proseFor,
  reviewOutcome,
  ruleProblem,
  rulesProblem,
  scheduleMinutesOf,
} from "./documents.js";
import { claimStillMine, saveClaimStates } from "./lease.js";
import {
  assertUsableProvider,
  decideActions,
  type ModelContext,
  providerFor,
} from "./llm.js";
import {
  type ArmTimersOpts,
  advance,
  armTimers,
  carryingForeign,
  dueEntries,
  planSchedule,
  unrunEntries,
  unrunEntry,
} from "./scheduler.js";
import { type AgentDoc, AgentDocumentError, AgentStore } from "./store.js";

/** The JMAP types the executor reconciles, plus the schedule. */
export type ChangeType = "Email" | "FileNode";

/**
 * What a guarded unit of work did.
 *
 * `ran` is the work having happened; `deferred` is the account's lock being
 * held by another unit of work, so nothing of this call happened and the unit
 * in flight owns the account until it finishes. A caller that cannot tell the
 * two apart takes a deferral for a fire that ran — which is how an entry that
 * is still due gets armed again and again against a busy account.
 */
export type GuardOutcome = "ran" | "deferred";

/** How one fire reaches the account it belongs to: `withAccountLock`, or a test. */
export type ScheduleGuard = (work: () => Promise<void>) => Promise<GuardOutcome>;

/**
 * What a fire runs inside when its caller gives no guard: the work itself.
 *
 * A agent always gives one — the account's lock, so a fire and a reconcile
 * cannot run this account at once — and running it directly is what a test that
 * arms a schedule without a live agent around it wants.
 */
const runUnguarded: ScheduleGuard = async (work) => {
  await work();
  return "ran";
};

/**
 * How many times a job is attempted before it is dead-lettered. A failure that
 * can be retried leaves the job `pending` with the message recorded, and a
 * later pass picks it up; the third failure is the end of it.
 */
export const JOB_MAX_ATTEMPTS = 3;

/**
 * How long a finished job or a decided decision is kept before the agent
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
  /**
   * What the deciding call cost, for the group's own meter (ADR 0003).
   *
   * Absent when this pass did not decide anything: a plan a job already carried
   * is resumed rather than decided again, and it was counted where it was made.
   */
  usage?: AgentUsage;
  /** Set on a plan a job already carried, so the meter counts the run once. */
  resumed?: true;
}

/**
 * How many times a decision's settle is retried after losing a compare-and-set.
 *
 * Three attempts cover the ordinary race — the account's own bookkeeping moving
 * between the read and the write — and a longer fight means something else is
 * wrong, which the log is the place for rather than an unbounded loop.
 */
const DECISION_SETTLE_ATTEMPTS = 3;

export interface ExecutorDeps {
  /** The agent's own session context: the agent's, never a member's. */
  ctx: Ctx;
  client: JmapClient;
  /** The agent's address, which chat posts are written as. */
  address: string;
  /** The agent holding this executor, recorded on every lease it takes. */
  agentId: string;
  now: () => Date;
  log: (line: string) => void;
}

/** The findings one `knowledge.review` recorded, or null. */
function knowledgeFindings(action: AgentAction, result: ActionResult): string | null {
  if (action.do !== "knowledge.review") return null;
  const r = result.result ?? {};
  return typeof r.findings === "string" && r.findings ? r.findings : null;
}

/** One knowledge page the run applied, from the action's own result. */
function knowledgePlanPage(
  action: AgentAction,
  result: ActionResult,
): AgentKnowledgePlanPage | null {
  if (action.do !== "knowledge.write") return null;
  const r = result.result ?? {};
  const folder = typeof r.folder === "string" ? r.folder : "";
  const title = typeof r.title === "string" ? r.title : folder;
  const outcome =
    r.outcome === "created" || r.outcome === "written" || r.outcome === "moved"
      ? r.outcome
      : "written";
  const basedOn = typeof r.basedOn === "string" && r.basedOn ? r.basedOn : undefined;
  const intent = typeof r.intent === "string" && r.intent ? r.intent : undefined;
  const account = typeof r.account === "string" && r.account ? r.account : undefined;
  const detail = typeof r.detail === "string" ? r.detail : undefined;
  return {
    folder,
    title,
    outcome,
    ...(basedOn ? { basedOn } : {}),
    ...(intent ? { intent } : {}),
    ...(account ? { account } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Fold a knowledge action's outcome into the run's own record.
 *
 * The KB's plan and a review's findings live on the job, not in the KB (ADR
 * 0024 Q23): a multi-document change records which page was created, written or
 * refused because it moved, and a review records its prose. Every other action
 * leaves the job as it was.
 */
function withKnowledgeOutcome(
  latest: AgentJob,
  action: AgentAction,
  result: ActionResult,
  at: string,
): AgentJob {
  const raw = knowledgePlanPage(action, result);
  const findings = knowledgeFindings(action, result);
  if (!raw && !findings) return latest;
  // A plan is one owner's (ADR 0024 Q24): a page in another account cannot be
  // part of it, so it is recorded as failed rather than silently folded in.
  const owner = latest.plan?.pages.find((p) => p.account)?.account;
  const page =
    raw?.account && owner && raw.account !== owner
      ? {
          ...raw,
          outcome: "failed" as const,
          detail: "a plan is one owner's; this page is in another account",
        }
      : raw;
  return {
    ...latest,
    ...(page ? { plan: { at, pages: [...(latest.plan?.pages ?? []), page] } } : {}),
    ...(findings ? { findings: [...(latest.findings ?? []), findings] } : {}),
  };
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

  /**
   * How to plan and arm one account's schedule again, by account.
   *
   * A fire the account's lock defers arms nothing, so the reconcile that runs
   * the entry is what returns its schedule to the clock — and this is where it
   * finds the armer. The armer is this process's, registered by `armSchedule`
   * and removed by the disposer it hands back.
   */
  private readonly scheduleArms = new Map<string, () => Promise<void>>();

  /**
   * The accounts whose fire a deferral left unrun and unarmed.
   *
   * The deferral is remembered rather than retried: the entry is still due in
   * the document, and what runs it is the reconcile the deferral leads to
   * (see `rearmAfterDeferredFire`).
   */
  private readonly deferredFires = new Set<string>();

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
   * An event is a signal, never a payload (ADR 0003), so nothing is trusted from
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
    // (ADR 0003).
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
      // Only this agent's own bookkeeping moved: the anchor stays where it is,
      // so the next pass reads the same nothing-to-do and writes nothing again.
      // See `onlyBookkeeping` for why writing it would be a loop.
      if (await this.onlyBookkeeping(accountId, type, ids)) return;
    }
    await this.recordState(store, claim, type, changes.newState, observedAt);
  }

  /**
   * Whether everything this pass read is a document the agent wrote itself.
   *
   * The claim, the jobs, the decisions and the audit are files in the very
   * account whose state they report, so writing the anchor **is** the next
   * change the next pass reads — record it, and the pass after that records it
   * again. Nothing in the group is happening and the account is charged a blob
   * a minute for it, forever, and Stalwart never gives one back: that is the
   * quota the fleet ran a save into. A change of the group's own is news and
   * still anchors here, and so is a message in the group's chat — the one part
   * of the app folder that is somebody talking rather than us bookkeeping.
   *
   * Only `FileNode` can be our own writing: nothing here sends or files mail.
   */
  private async onlyBookkeeping(
    accountId: string,
    type: ChangeType,
    ids: ReadonlyArray<string>,
  ): Promise<boolean> {
    if (type !== "FileNode") return false;
    const appFolderId = await findAppFolder(this.deps.ctx, accountId);
    if (!appFolderId) return false;
    const chatFolderId = await findFolderPath(this.deps.ctx, accountId, CHAT_FOLDER);
    for (const id of ids) {
      // A file anywhere else in the account is the group's own work.
      if (!(await this.underAppFolder(accountId, id, appFolderId))) return false;
      if (chatFolderId && (await this.underAppFolder(accountId, id, chatFolderId)))
        return false;
    }
    return true;
  }

  /**
   * The group's rules, with a document that could not be brought to the current
   * shape recorded rather than taken for no automation.
   *
   * `null` is the account having no rules document at all; a document in an
   * older shape is replaced with an empty, current one on read, and only a
   * replacement that cannot land raises out of `readRules` (see
   * `AgentDocumentError`). The last is a state a caller must not read as "nothing
   * to run": the group's work would stop with no audit row and no word in the
   * chat, which is what this records.
   *
   * The line is written once per process and cause, because a document that
   * cannot be replaced is a state and not an event: it is still so on the next
   * pass, and the group's chat would carry the same sentence every poll. The
   * log carries the pass it happened in either way.
   */
  private async rulesOrReport(
    store: AgentStore,
    accountId: string,
    where: string,
  ): Promise<AgentRule[] | null> {
    try {
      const rules = (await store.readRules())?.doc ?? [];
      /*
       * One enabled automation per trigger is a rule of the product (ADR 0006
       * decision one), enforced where automations are written — and the fan-out
       * below is what it exists for: this pass starts a job for **every**
       * enabled automation on the trigger, so a document that carries two would
       * answer one arrival twice. The save guard is the enforcer; a document
       * written by hand, restored from a backup, or written by a build that
       * predates the guard reaches the executor anyway, and a person has to hear
       * about it. The line is said once per process and cause, the way an
       * unreadable document is: it is a state the next pass finds again, and the
       * group's chat is not a place to repeat it every poll.
       */
      const doubled = rulesProblem(rules);
      // The key names the account as well as the cause: two groups whose
      // document fails the same way must each hear about it once, and a set
      // keyed on the sentence alone would let the second go unreported.
      const doubledKey = doubled ? `${accountId}\u0000${doubled}` : "";
      if (doubled && !this.reportedUnreadable.has(doubledKey)) {
        this.reportedUnreadable.add(doubledKey);
        this.deps.log(`${accountId}: ${where}: ${doubled}`);
        await this.tellChat(accountId, `I am not running as written: ${doubled}`);
      }
      return rules;
    } catch (err) {
      // Anything that is not the document that could not be replaced — a server
      // that could not answer, a refused read — keeps its own handling: this
      // path is about a document a person has to fix, not about a read that
      // failed.
      if (!(err instanceof AgentDocumentError)) throw err;
      const detail = errorMessage(err);
      this.deps.log(
        `${accountId}: ${where} cannot read the group's automation: ${detail}`,
      );
      const detailKey = `${accountId}\u0000${detail}`;
      if (this.reportedUnreadable.has(detailKey)) return null;
      this.reportedUnreadable.add(detailKey);
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

  /**
   * One job per changed message, under the one automation on this trigger.
   *
   * An automation carries no filter, so every delivered message is one a mail
   * automation reads: the discrimination between cases lives in its prose, and
   * the executor's own pre-filter is gone with the field it belonged to
   * (ADR 0006). What remains a condition of the trigger is the account's own
   * bookkeeping — a draft is work in progress and must not wake the run that
   * prepares it.
   *
   * The count of automations is settled before the pass by `rulesProblem`, so
   * what this reads is either the one enabled mail automation or nothing: the
   * "every rule on the trigger" fan-out is what the guard exists to keep at
   * one.
   */
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
    for (const id of ids) {
      // Only what the trigger record needs: the instant the message arrived and
      // who sent it. The run fetches the message itself, body included, when it
      // builds its own context — nothing here reads a message to decide whether
      // to look at it.
      const view = await fetchEmailView(this.deps.client, accountId, id);
      if (!view) continue;
      // A draft is work in progress, not delivered mail: without this, a run
      // that prepares a draft would wake itself on the draft it created.
      if (view.keywords?.$draft === true) continue;
      for (const rule of candidates) {
        const trigger: AgentTriggerRecord = {
          on: "email",
          emailId: view.id,
          at: view.receivedAt ?? this.deps.now().toISOString(),
        };
        const sender = view.from?.[0];
        if (sender?.email) trigger.by = sender.email;
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
  ): Promise<FileNodeLike[]> {
    const res = await this.deps.client.call<{ list?: FileNodeLike[] }>(
      "FileNode/get",
      { accountId, ids, properties: ["id", "name", "parentId", "nodeType", "size"] },
      [FILENODE_CAP],
    );
    return res.list ?? [];
  }

  private async nodeRecord(accountId: string, id: string): Promise<FileNodeLike | null> {
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
   * and when the state it reads from was observed (ADR 0003).
   */
  private async jobIndex(store: AgentStore, since?: string): Promise<Pass> {
    const jobs = (await store.listJobs()).map((entry) => entry.doc);
    const pass: Pass = {
      keys: new Set(jobs.map((job) => jobKey(job.ruleId, job.trigger))),
      producers: producersOf(jobs, since),
      chainHops: await this.chainHops(),
    };
    if (since) pass.since = since;
    return pass;
  }

  /**
   * The installation's own bound on a chain, or the deployment's default.
   *
   * One read, from the account that holds the installation's configuration, and
   * the environment is what an installation that has said nothing runs on.
   */
  /**
   * The installation's model, with the address check the call owes: one rule,
   * applied where the key leaves the process (ADR 0003).
   */
  private usableProvider(configDoc: AgentConfigDoc | null): AgentProvider {
    const provider = providerFor(configDoc);
    assertUsableProvider(provider, config.agent.allowPrivateProvider);
    return provider;
  }

  private async chainHops(): Promise<number> {
    try {
      const doc = (await this.agentStore.readConfig())?.doc;
      // What the document says, held to what this build accepts: a value above
      // the ceiling is one no surface would have written, and a chain that ran
      // to it would be one nobody could have set from the product. The number
      // that is spent is the one that is said, so the clamp is named in the log
      // rather than a document quietly meaning something other than it says.
      const asked = doc?.maxChainHops ?? config.agent.maxChainHops;
      if (asked > AGENT_CHAIN_HOPS_CEILING)
        console.warn(
          `[gilbert] the installation asks for ${asked} hops on a chain, and this build runs at most ${AGENT_CHAIN_HOPS_CEILING}`,
        );
      return Math.min(asked, AGENT_CHAIN_HOPS_CEILING);
    } catch (err) {
      // A configuration this pass cannot read falls back to the deployment's
      // own number rather than stopping the pass: the same document fails the
      // run itself when the provider is read from it, and a chain is not the
      // place to report an unreadable configuration.
      console.warn(
        "[gilbert] could not read the installation's bound on a chain:",
        (err as Error).message,
      );
      return Math.min(config.agent.maxChainHops, AGENT_CHAIN_HOPS_CEILING);
    }
  }

  /**
   * The installation's own bound on the pages one run reads, or the
   * deployment's default.
   *
   * One read, from the account that holds the installation's configuration, and
   * the environment is what an installation that has said nothing runs on. The
   * number is stated in the prompt and spent by the page work, so both read it
   * here rather than one of them holding a bound of its own (ADR 0003).
   */
  private async maxPages(): Promise<number> {
    try {
      const doc = (await this.agentStore.readConfig())?.doc;
      const asked = doc?.maxPages ?? config.agent.maxPages;
      if (asked > AGENT_PAGES_CEILING)
        console.warn(
          `[gilbert] the installation asks for ${asked} pages of a document, and this build reads at most ${AGENT_PAGES_CEILING}`,
        );
      return Math.min(asked, AGENT_PAGES_CEILING);
    } catch (err) {
      // A configuration this pass cannot read falls back to the deployment's
      // own number rather than failing the run here: the same document is read
      // again for the provider, which is where an unreadable one is refused.
      console.warn(
        "[gilbert] could not read the installation's bound on the pages one run reads:",
        (err as Error).message,
      );
      return Math.min(config.agent.maxPages, AGENT_PAGES_CEILING);
    }
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
     * The lineage, and the bound it is read against (ADR 0003). `wokenBy` is the
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
    if (hop > pass.chainHops) {
      await this.refuseChain(store, accountId, rule, trigger, woke, hop, pass.chainHops);
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
   * (ADR 0003): nothing runs, and the group is told which automation could not
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
   * trail remembers one, so a change the agent reads again would otherwise
   * refuse again, with a second entry and the same sentence in the group's chat.
   *
   * The trail is checked in both this month's document and last month's: a
   * dedup reading only the current month finds no record of a refusal that
   * happened a few days earlier, in the previous month's document, and refuses
   * (and announces) the same chain a second time.
   */
  private async refuseChain(
    store: AgentStore,
    accountId: string,
    rule: AgentRule,
    trigger: AgentTriggerRecord,
    woke: Producer | null,
    hop: number,
    bound: number,
  ): Promise<void> {
    const subject = refusedSubject(rule.id, trigger);
    const now = this.deps.now();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const [thisMonth, previous] = await Promise.all([
      store.readAuditAt(now),
      store.readAuditAt(lastMonth),
    ]);
    const refused = [...(previous?.entries ?? []), ...(thisMonth?.entries ?? [])];
    if (refused.some((entry) => entry.outcome === "refused" && entry.jobId === subject))
      return;
    const line =
      `I did not run "${automationLabel(rule)}": it was woken ${hop} hops into a chain ` +
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
    // Only work that is waiting for a agent: a finished job is finished, and a
    // job paused on a person waits for that person, never for a lease timeout.
    if (current.state !== "pending" && current.state !== "running") return;
    const now = this.deps.now();
    const lease = current.lease;
    if (
      lease &&
      lease.owner !== this.deps.agentId &&
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
      lease: { owner: this.deps.agentId, heartbeatAt: now.toISOString() },
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
      // second time by the agent that replaced it.
      if (!(await claimStillMine(store, this.deps.agentId, claimEpoch(claim)))) {
        this.deps.log(
          `${automationLabel(rule)}: ${job.id} was taken over while it was deciding, so nothing is run`,
        );
        return;
      }
      /*
       * The gate: the group's own policy decides how cautious its runs are, and
       * it is read here — after the plan and before anything runs — so a policy
       * a member changed while a run was deciding applies to that run rather
       * than to the next one. A document nobody has written reads as the
       * default (`policyOf`), which is the one reading nobody had to choose.
       */
      const policy = policyOf((await store.readPolicy())?.doc ?? null);
      if (reviewOutcome(policy, plan.actions, plan.confidence) === "execute") {
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
   * because a write onto that copy would put a lapsed agent's `applied` and
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
    // Every checkpoint a running job's own work already writes here — planned,
    // then each landed action — is also where its lease can be renewed for
    // free. Without this the lease is only ever set once, at the moment a job
    // enters `running`, and a run whose actions take longer than `leaseMs`
    // combined looks abandoned to a peer that takes this account over mid-run,
    // which would then start the same job a second time believing the first
    // agent is gone rather than merely slow.
    if (next.state === "running" && next.lease?.owner === this.deps.agentId) {
      next.lease = {
        owner: this.deps.agentId,
        heartbeatAt: this.deps.now().toISOString(),
      };
    }
    try {
      await store.writeJob(next, { ifInState: found.state });
    } catch (err) {
      if (isStateMismatch(err)) return null;
      throw err;
    }
    return next;
  }

  /**
   * What the run should do: the model decides, inside the rule's own grant.
   *
   * The deciding call may answer with a lookup instead of actions, up to
   * `AGENT_LOOKUP_ROUNDS` times (ADR 0020): the run reads what it asked for in
   * the group's own account, appends it to the run's context and asks again.
   * Nothing about the loop loosens the rest — the capability allowlist and the
   * review gate still see the one answer that decides, and a lookup is a read
   * that changes nothing.
   */
  private async planFor(
    store: AgentStore,
    accountId: string,
    job: AgentJob,
    rule: AgentRule,
  ): Promise<RunPlan> {
    const problem = ruleProblem(rule);
    if (problem) throw new RefusedError(`the rule cannot run: ${problem}`);
    const configDoc = (await this.agentStore.readConfig())?.doc ?? null;
    // The page budget the installation set, or the one the deployment declares:
    // the same shape as every other bound, and one reader for the prompt and
    // for the page work (ADR 0003).
    const pages = await this.maxPages();
    const context = await this.contextFor(accountId, job, rule, pages);
    //
    // The prose this run carries, read once per run: the installation's own
    // rules from the agent's account, then the group's facts, then the group's
    // standing instruction. The order they reach the prompt in is `proseHead`'s
    // (ADR 0003, ADR 0019), not this call site's.
    const [preambleDoc, instructionDoc, notebookDoc] = await Promise.all([
      this.agentStore.readProse(AGENT_PREAMBLE_FILE),
      store.readProse(AGENT_INSTRUCTION_FILE),
      store.readNotebook(),
    ]);
    const provider = this.usableProvider(configDoc);
    // What the model is offered, and what its answer is checked against: the
    // rule's grant plus the answer "change nothing", which every automation
    // has. One function, so the prompt and the check cannot disagree about it.
    const allowed = effectiveCapabilities(rule);
    const prose = {
      preamble: proseFor(preambleDoc?.doc ?? null),
      standing: proseFor(instructionDoc?.doc ?? null),
      notebook: notebookFor(notebookDoc?.doc ?? null),
    };
    // The call's own shape: the installation's ceiling on an answer, how many
    // pages it may hand over, and the agent's own decision about paying for a
    // chain of thought. The page bound is stated in the prompt from this same
    // number, so what the model is told and what the run hands over cannot
    // disagree.
    const call = {
      maxOutputTokens: configDoc?.maxOutputTokens,
      maxPages: pages,
      thinking: config.agent.thinking,
    };
    // The volatile tail grows by what the run reads and the stable head never
    // moves, so widening a run cannot cost the provider a cache miss on the
    // head it already served (ADR 0003, ADR 0020).
    let text = context.text;
    let usage: AgentUsage | undefined;
    const lookups: AgentLookup[] = [];
    try {
      for (let round = 0; round <= AGENT_LOOKUP_ROUNDS; round++) {
        const answer = await decideActions(
          provider,
          rule,
          { ...context, text },
          allowed,
          prose,
          { ...call, lookupsLeft: AGENT_LOOKUP_ROUNDS - round },
        );
        usage = addUsage(usage, answer.usage);
        if (answer.kind === "lookup") {
          lookups.push(answer.lookup);
          text = `${text}\n\n${await this.lookupSlice(accountId, answer.lookup)}`;
          continue;
        }
        await this.guardLabels(accountId, answer.actions);
        if (lookups.length) await this.recordLookups(store, job, lookups);
        return {
          actions: answer.actions,
          confidence: answer.confidence,
          summary: answer.summary,
          ...(usage ? { usage } : {}),
        };
      }
    } catch (err) {
      // A run that read something and then failed still says what it read: the
      // reads happened, and a trail that hid them would make "why did it say
      // that" unanswerable (ADR 0020).
      if (lookups.length) await this.recordLookups(store, job, lookups);
      throw err;
    }
    // The last call has no lookups left, so a lookup answer is refused inside
    // `decideActions`; reaching here is a bug in that bound, and it is loud.
    throw new Error(
      `"${automationLabel(rule)}" spent its lookups without deciding anything`,
    );
  }

  /**
   * What a run asked to read, read (ADR 0020).
   *
   * One dispatcher over the closed catalogue. What lists hands over names and
   * ids and what reads hands over one item's text, bounded: a run pays for the
   * index once and for content only where it needs it, and the group's whole
   * state — its mail, folders, labels, Files, chat and knowledge base — is
   * reachable without a mailbox ever being attached wholesale (ADR 0006
   * decision three).
   */
  private async lookupSlice(accountId: string, lookup: AgentLookup): Promise<string> {
    try {
      switch (lookup.kind) {
        case "mail":
          return await this.mailLookup(accountId, lookup);
        case "message":
          return await this.messageLookup(accountId, lookup);
        case "mailboxes":
          return await this.mailboxesLookup(accountId, lookup);
        case "labels":
          return await this.labelsLookup(accountId, lookup);
        case "files":
          return await this.filesLookup(accountId, lookup);
        case "file":
          return await this.fileLookup(accountId, lookup);
        case "chat":
          return await this.chatLookup(accountId, lookup);
        case "knowledge":
          return await this.knowledgeLookup(accountId, lookup);
      }
    } catch (err) {
      // A path or a document the model chose can be refused by the layer that
      // owns it — the app folder is not a destination in Files, a library
      // cannot read a kind — and that is an answer to the run, not a failure of
      // it: the run is told what it could not read and carries on (ADR 0020).
      if (err instanceof AppFolderError || err instanceof DocumentError)
        return `${lookupHeading(lookup)}: ${errorMessage(err)}`;
      throw err;
    }
  }

  /**
   * The newest mail a run asked about: headers and ids, never bodies.
   *
   * The listing is the index the run then reads from — a `message` lookup by
   * the id one of these lines carries — which is what keeps a broad question
   * ("what is unread in the inbox") from paying for every message's text.
   */
  private async mailLookup(
    accountId: string,
    lookup: Extract<AgentLookup, { kind: "mail" }>,
  ): Promise<string> {
    // One grammar for the whole product: `is:starred`, `from:`, `in:`,
    // `has:attachment`, dates, sizes — parsed here by the same module the mail
    // client's search box reads, so the two cannot mean different things
    // (ADR 0020).
    const parsed = parseQuery(lookup.query ?? "");
    // The mailbox list is read only when the query names a folder: a lookup
    // that needs no mailbox must not depend on a `Mailbox/get` answering.
    const mailboxes = parsed.in ? await this.accountMailboxes(accountId) : null;
    if (
      parsed.in &&
      mailboxes &&
      !resolveMailbox(parsed.in, mailboxes) &&
      !["anywhere", "all"].includes(parsed.in.toLowerCase())
    )
      return `${lookupHeading(lookup)}: this account has no folder called “${parsed.in}”`;
    const filter = buildFilter(parsed, mailboxes ?? {}) as Record<string, unknown>;
    const limit = Math.min(
      lookup.limit ?? AGENT_LOOKUP_MESSAGES_MAX,
      AGENT_LOOKUP_MESSAGES_MAX,
    );
    const result = await this.deps.client.chain(
      [
        [
          "Email/query",
          {
            accountId,
            filter,
            sort: [{ property: "receivedAt", isAscending: false }],
            limit,
            calculateTotal: true,
          },
          "q",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["id", "from", "subject", "receivedAt", "keywords"],
          },
          "g",
        ],
      ],
      [JMAP_MAIL],
    );
    const raw = result.raw("q");
    const list =
      raw && raw[0] === "Email/query" ? (raw[1] as Record<string, unknown>) : {};
    const found = result.list<AgentEmailView>("g");
    const total = typeof list.total === "number" ? list.total : found.length;
    return renderItemList(lookup, total, found.map(mailListLine));
  }

  /** One message's own text, by the id a mail lookup listed. */
  private async messageLookup(
    accountId: string,
    lookup: Extract<AgentLookup, { kind: "message" }>,
  ): Promise<string> {
    const view = await fetchEmailView(this.deps.client, accountId, lookup.id, {
      body: true,
    });
    if (!view)
      return `${lookupHeading(lookup)}: there is no such message in this account`;
    return renderItem(lookup, renderEmail("", { ...view, body: boundedText(view.body) }));
  }

  /** The account's own folders, so a run can name one. */
  private async mailboxesLookup(
    accountId: string,
    lookup: Extract<AgentLookup, { kind: "mailboxes" }>,
  ): Promise<string> {
    const rows = (await mailboxesOf(this.deps.client, accountId, null)).map(
      (mailbox) =>
        `- ${String(mailbox.name ?? "(unnamed)")}${
          mailbox.role ? ` (${String(mailbox.role)})` : ""
        }`,
    );
    return renderItemList(lookup, rows.length, rows);
  }

  /** The group's own label catalog: the keywords its mail is filed under. */
  private async labelsLookup(
    accountId: string,
    lookup: Extract<AgentLookup, { kind: "labels" }>,
  ): Promise<string> {
    const read = await readGroupLabels(this.deps.ctx, accountId);
    if (read.state === "absent")
      return `${lookupHeading(lookup)}: this group has no label catalog yet`;
    if (read.state === "unreadable")
      return `${lookupHeading(lookup)}: this group's label catalog could not be read`;
    const rows = read.labels.map((label) => `- ${label.keyword}: ${label.name}`);
    return renderItemList(lookup, rows.length, rows);
  }

  /** The account's mailboxes as the shared search grammar resolves a name against. */
  private async accountMailboxes(
    accountId: string,
  ): Promise<Record<string, { id: string; name: string; role?: string | null }>> {
    const map: Record<string, { id: string; name: string; role?: string | null }> = {};
    for (const mailbox of await mailboxesOf(this.deps.client, accountId, null)) {
      if (typeof mailbox.id !== "string" || typeof mailbox.name !== "string") continue;
      map[mailbox.id] = {
        id: mailbox.id,
        name: mailbox.name,
        role: typeof mailbox.role === "string" ? mailbox.role : null,
      };
    }
    return map;
  }

  /** The group's visible Files: what is in the top level, or in one folder. */
  private async filesLookup(
    accountId: string,
    lookup: Extract<AgentLookup, { kind: "files" }>,
  ): Promise<string> {
    const folder = (lookup.folder ?? "").trim();
    const folderId = await findVisibleFolder(this.deps.ctx, accountId, folder);
    if (folderId === undefined)
      return `${lookupHeading(lookup)}: this group has no folder called “${folder}”`;
    const rows: string[] = [];
    if (lookup.deep) {
      // One listing for the whole tree, paths and all: "which file is in the
      // wrong folder" is a question about the shape of the tree, and a listing
      // that stopped at one level would make the run ask a person to walk it
      // folder by folder (ADR 0020).
      const truncated = await this.walkVisible(
        accountId,
        folderId,
        folder,
        0,
        rows,
        lookup.name,
      );
      const rendered = renderItemList(lookup, rows.length, rows);
      return truncated
        ? `${rendered}\n…(more than ${AGENT_LOOKUP_FILES_MAX} entries; list one folder to see the rest)`
        : rendered;
    }
    const nodes = await fileChildren(
      this.deps.ctx,
      accountId,
      folderId,
      undefined,
      AGENT_LOOKUP_MESSAGES_MAX,
    );
    // The app folder is not a place in a member's Files, so a listing never
    // names it: the agent's own documents are not something a run reads back
    // as the group's files (ADR 0003).
    for (const node of nodes) {
      if (node.name === APP_FOLDER_NAME) continue;
      if (!matchesName(node, lookup.name)) continue;
      rows.push(fileLine(node, ""));
    }
    return renderItemList(lookup, rows.length, rows);
  }

  /**
   * The visible tree under one folder, depth first, as listing lines.
   *
   * Bounded twice — `AGENT_LOOKUP_FILES_MAX` nodes across the walk and
   * `AGENT_LOOKUP_DEPTH_MAX` levels down — so "the whole tree" is a slice a run
   * pays for once and never an account's lifetime of files. The app folder and
   * everything under it is skipped: it is not a place in a member's Files.
   */
  private async walkVisible(
    accountId: string,
    folderId: string | null,
    prefix: string,
    depth: number,
    rows: string[],
    nameFilter?: string,
  ): Promise<boolean> {
    // True when the walk stopped because it filled its bound rather than because
    // it reached the end: the caller renders that as "more entries", and a
    // listing that happens to end exactly at the bound does not claim there are
    // more.
    if (rows.length >= AGENT_LOOKUP_FILES_MAX) return true;
    if (depth > AGENT_LOOKUP_DEPTH_MAX) return false;
    const nodes = await fileChildren(
      this.deps.ctx,
      accountId,
      folderId,
      undefined,
      AGENT_LOOKUP_FILES_MAX,
    );
    for (const node of nodes) {
      if (rows.length >= AGENT_LOOKUP_FILES_MAX) return true;
      const name = String(node.name ?? "");
      if (!name || name === APP_FOLDER_NAME) continue;
      if (matchesName(node, nameFilter)) rows.push(fileLine(node, prefix));
      if (node.nodeType === "directory" && node.id)
        if (
          await this.walkVisible(
            accountId,
            String(node.id),
            prefix ? `${prefix}/${name}` : name,
            depth + 1,
            rows,
            nameFilter,
          )
        )
          return true;
    }
    return false;
  }

  /** One file of the group's visible Files, as the text this build reads. */
  private async fileLookup(
    accountId: string,
    lookup: Extract<AgentLookup, { kind: "file" }>,
  ): Promise<string> {
    const found = await readVisibleFileBytes(this.deps.ctx, accountId, lookup.path);
    if (!found)
      return `${lookupHeading(lookup)}: this group's Files do not hold “${lookup.path}”`;
    const kind = documentKindOf(
      found.name,
      typeof found.file.type === "string" ? found.file.type : undefined,
    );
    if (!kind) return renderItem(lookup, "(a kind of file this build does not read)");
    // No page is rasterised for a lookup: reading a page as an image is an
    // action a run pays for (`document.read`), not something a listing does.
    // The page bound is the run's own capped bound (`maxPages`), so the text is
    // read within the same limit and no image is rendered — passing zero here
    // once bounded the text layer too and reported every PDF and workbook as
    // reading "(no text)".
    const content = await documentContent(found.bytes, kind, await this.maxPages(), {
      vision: false,
    });
    return renderItem(lookup, boundedText(content.read.text));
  }

  /** The group's chat, optionally narrowed to what a sender said or what it says. */
  private async chatLookup(
    accountId: string,
    lookup: Extract<AgentLookup, { kind: "chat" }>,
  ): Promise<string> {
    const messages = await this.readChatOf(accountId);
    // The same grammar, applied to what a transcript can mean: the words a
    // message says, who wrote it, and when. A field a chat has no use for (a
    // size, an attachment) narrows nothing.
    const parsed = parseQuery(lookup.query ?? "");
    const text = parsed.text.join(" ").toLowerCase();
    // `from:` is what JMAP's own filter is: a case-insensitive match on the
    // sender, so the grammar's own example (`from:ada`) finds
    // `ada@example.com`. The window is half-open — `after` inclusive,
    // `before` exclusive — exactly as `Email/query` reads it.
    const from = parsed.from?.toLowerCase();
    const after = parsed.after ? Date.parse(parsed.after) : undefined;
    const before = parsed.before ? Date.parse(parsed.before) : undefined;
    const matching = messages.filter((message) => {
      const at = Date.parse(message.created);
      return (
        (!from || message.from.toLowerCase().includes(from)) &&
        (!text || message.text.toLowerCase().includes(text)) &&
        (after === undefined || at >= after) &&
        (before === undefined || at < before)
      );
    });
    const limit = Math.min(
      lookup.limit ?? AGENT_LOOKUP_MESSAGES_MAX,
      AGENT_LOOKUP_MESSAGES_MAX,
    );
    const rows = matching
      .slice(-limit)
      .map((message) => `- ${renderChatMessage(message)}`);
    return renderItemList(lookup, matching.length, rows);
  }

  /**
   * The group's knowledge base: its articles' index, or one article's own text.
   *
   * ADR 0024. The KB is a tail read on the same terms as the rest of the
   * catalogue — a listing carries a title, an id, a lifecycle state and tags,
   * never a body, and one article's plain text is read back by the id the
   * listing gave. The account is the one the run acts on: a group's own KB is
   * read here, and the Master's company KB is the same read when the run acts
   * on the Master's account — there is no second path.
   */
  private async knowledgeLookup(
    accountId: string,
    lookup: Extract<AgentLookup, { kind: "knowledge" }>,
  ): Promise<string> {
    // The run's own tier (a group's, or the Master's when the run acts on it)
    // and the company tier, which is the Master's account in the agent's own
    // session — an agent reads everywhere (ADR 0024 Q15).
    const articles: KnowledgeArticleRef[] = [];
    const accounts = [accountId];
    const companyKb = filesAccountId(this.deps.ctx);
    if (companyKb && companyKb !== accountId) accounts.push(companyKb);
    for (const account of accounts) {
      const rootId = await findFolderPath(this.deps.ctx, account, KNOWLEDGE_FOLDER);
      if (rootId) await this.collectKnowledgeArticles(account, rootId, "", 0, articles);
    }
    if (!articles.length)
      return `${lookupHeading(lookup)}: this installation has no knowledge base`;
    if (lookup.id) {
      const found = articles.find((article) => article.id === lookup.id);
      if (!found)
        return `${lookupHeading(lookup)}: no knowledge article has the id ${lookup.id}`;
      return renderItem(lookup, boundedText(found.text));
    }
    const standing = articles.filter((article) => !article.retired);
    const needle = (lookup.query ?? "").trim().toLowerCase();
    const matching = needle
      ? standing.filter(
          (article) =>
            article.title.toLowerCase().includes(needle) ||
            article.text.toLowerCase().includes(needle),
        )
      : standing;
    const limit = Math.min(
      lookup.limit ?? AGENT_LOOKUP_ARTICLES_MAX,
      AGENT_LOOKUP_ARTICLES_MAX,
    );
    return renderItemList(
      lookup,
      matching.length,
      matching.slice(0, limit).map(knowledgeLine),
    );
  }

  /**
   * Every article under one knowledge folder, depth first and bounded.
   *
   * An article is a folder holding a `draft.json` or a `state.json`; a folder
   * with neither is not an article but may still hold sub-articles, which is
   * why the walk continues through it. `revisions` is the one reserved child
   * and is never an article (ADR 0024).
   */
  private async collectKnowledgeArticles(
    accountId: string,
    folderId: string,
    prefix: string,
    depth: number,
    out: KnowledgeArticleRef[],
    visited = { n: 0 },
  ): Promise<void> {
    // The bound is on the folders the walk *visits*, not on the articles it
    // happens to find: a KB of many plain folders would otherwise traverse far
    // past the cap while `out` stayed small.
    if (depth > AGENT_LOOKUP_DEPTH_MAX || visited.n >= AGENT_LOOKUP_FILES_MAX) return;
    const children = await fileChildren(
      this.deps.ctx,
      accountId,
      folderId,
      undefined,
      AGENT_LOOKUP_FILES_MAX,
    );
    for (const node of children) {
      if (visited.n >= AGENT_LOOKUP_FILES_MAX) return;
      if (node.nodeType !== "directory" || !node.id) continue;
      const name = String(node.name ?? "");
      if (!name || isReservedArticleName(name)) continue;
      visited.n += 1;
      const path = prefix ? `${prefix}/${name}` : name;
      const [draftRaw, stateRaw] = await Promise.all([
        readAppJsonAt(
          this.deps.ctx,
          accountId,
          `${KNOWLEDGE_FOLDER}/${path}/${DRAFT_FILE}`,
        ),
        readAppJsonAt(
          this.deps.ctx,
          accountId,
          `${KNOWLEDGE_FOLDER}/${path}/${STATE_FILE}`,
        ),
      ]);
      const draft = isKnowledgeDraft(draftRaw) ? draftRaw : null;
      const state = isKnowledgeState(stateRaw) ? stateRaw : null;
      const id = draft?.id ?? state?.id;
      if (id) {
        out.push({
          id,
          title: draft?.title ?? state?.title ?? name,
          tags: draft?.tags ?? state?.tags ?? [],
          state: knowledgeStateLabel(state),
          retired: state !== null && isRetired(state),
          // `plainTextFromBlocks` when the denormalised body is empty: the
          // editor's blocks are the source of truth and `text` is the copy a
          // search or a run reads, so a page whose copy nobody rendered still
          // has a body to hand over.
          text: draft ? draft.text || plainTextFromBlocks(draft.blocks) : "",
        });
      }
      await this.collectKnowledgeArticles(
        accountId,
        String(node.id),
        path,
        depth + 1,
        out,
        visited,
      );
    }
  }

  /** The lookups a run made, onto the job, so its record says what it read. */
  private async recordLookups(
    store: AgentStore,
    job: AgentJob,
    lookups: ReadonlyArray<AgentLookup>,
  ): Promise<void> {
    try {
      await this.writeJobIfCurrent(store, job.id, (latest) => ({
        ...latest,
        lookups: [...(latest.lookups ?? []), ...lookups],
      }));
    } catch (err) {
      // The run's record is a courtesy to whoever reads it afterwards; losing
      // it must not lose the work the run is about to do.
      this.deps.log(`could not record what ${job.id} looked up: ${errorMessage(err)}`);
    }
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
      const mine = await claimStillMine(store, this.deps.agentId, claimEpoch(claim));
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
        // The cost sits beside the work that spent it (ADR 0003): the agent
        // that held the group, whether this run paid for a chain of thought,
        // and the counts the provider reported.
        agent: this.deps.address,
        reasoned: config.agent.thinking,
        ...(plan.usage ? { usage: plan.usage } : {}),
        ...(plan.resumed ? { resumed: true } : {}),
      }),
    );
    // What already landed is a prefix of this plan — the actions run in order
    // and stop at the first failure — so the remainder is what is left to do.
    const applied = job.applied ?? [];
    const todo = remainingActions(plan.actions, applied);
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
      this.deps.log(
        `${automationLabel(rule)}: ${job.id} had already run everything it planned`,
      );
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
          const recorded = await this.writeJobIfCurrent(store, job.id, (latest) =>
            withKnowledgeOutcome(
              {
                ...latest,
                applied: [...landed],
                // The record the action wrote, beside the action that wrote it: a
                // change naming that id is how the next run of a chain knows which
                // job woke it (ADR 0003).
                ...(wrote.length
                  ? { effects: [...(latest.effects ?? []), ...wrote] }
                  : {}),
              },
              action,
              result,
              this.deps.now().toISOString(),
            ),
          );
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
      `${automationLabel(rule)}: ${describeActions(results)} for ${describeTrigger(job.trigger)}`,
    );
    /*
     * A run somebody asked for says so where the group reads (ADR 0003). Every
     * other trigger is the group's own mail, chat or clock, which needs no
     * announcement — but "I ran this because a person asked me to" is a fact
     * about the group's agent that its members should not have to infer from a
     * document they cannot open. A failure already tells the chat; this is the
     * half that was missing.
     */
    if (done.trigger.on === "manual")
      await this.tellChat(
        accountId,
        `I ran "${automationLabel(rule)}" as asked: ${describeActionsInWords(results)}`,
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
    // A paused job belongs to a person now, not to a agent: clearing the lease
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
    this.deps.log(`${automationLabel(rule)}: waiting for a person (${job.id})`);
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
    /** How many pages of a document this run reads, as the installation set it. */
    pages: number,
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
      // Only a person asking widens the window; the run never does it
      // itself.
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
      // The transcript is the run's context. Everything else about the group is
      // a lookup the model asks for, through the same grammar the search box
      // reads, so a new kind of question is not a new branch here (ADR 0020).
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
      if (node && path) await this.readTheFile(accountId, path, rule, context, pages);
      return context;
    }
    return {
      text: `The automation "${automationLabel(rule)}" runs on its own, every ${scheduleMinutesOf(
        rule,
      )} minutes.`,
    };
  }

  /**
   * What a run reads of the file that woke it (ADR 0003), into its own context.
   *
   * A rule that holds `document.read` reads the document: its own text layer
   * comes back as text, and the pages that carry no text layer at all are
   * rasterised in the process and handed to the call as images — the model
   * reads them, because it has eyes. How many pages one document is read to is
   * the installation's own bound, or the deployment's `GILBERT_AGENT_MAX_PAGES`
   * when it has set none, and the bound is stated in the prompt rather than
   * hidden. A deployment whose model cannot read an image says so
   * (`GILBERT_AGENT_VISION=0`) and the run is told that instead of being told a
   * page was handed over.
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
    /** How many pages of a document this run reads, as the installation set it. */
    pages: number,
  ): Promise<void> {
    if (!rule.capabilities.includes("document.read")) return;
    const found = await readVisibleFileBytes(this.deps.ctx, accountId, path);
    if (!found) {
      context.text += `\n\n"${path}" is no longer in the group's Files.`;
      return;
    }
    // The blob arrives whole, before anything can look at it, and a rendered
    // page is held as pixels: this is the bound on both, and a run says it
    // rather than spending the process on one file (ADR 0003).
    if (found.bytes.byteLength > AGENT_DOCUMENT_BYTES_MAX) {
      context.text += `\n\n"${found.name}" is larger than the ${AGENT_DOCUMENT_BYTES_MAX} bytes a run reads, so nothing of it is read here.`;
      return;
    }
    const type =
      typeof found.file.type === "string" && found.file.type ? found.file.type : "";
    const kind = documentKindOf(found.name, type);
    if (!kind) {
      context.text += `\n\n"${found.name}" is none of the kinds this installation reads — a PDF, a .docx, a spreadsheet (.xls, .xlsx), a text file or an image (.png, .jpg, .gif, .webp) — so nothing of it is read here.`;
      return;
    }
    // Nothing read and no page to render is said out loud: a `.docx` whose text
    // is empty, or a PDF whose pages carry none, is a document this run could
    // not read, not a document that says nothing.
    let content: DocumentContent;
    try {
      content = await documentContent(found.bytes, kind, pages, {
        vision: config.agent.vision,
      });
    } catch (err) {
      // A library refusing these bytes refuses them again on a retry, so the
      // run stops here, once, with the code: an action this deployment cannot
      // do is refused, never silently dropped (ADR 0003).
      if (err instanceof DocumentError) throw new RefusedError(err.message);
      throw err;
    }
    const read = content.read;
    // The pages this run never looked at are said beside the ones it read
    // (ADR 0003): a reading bounded to the first pages of a document is not a
    // reading of the whole of it, and a document whose pages do carry text is
    // bounded the same way as one whose pages do not.
    const scope =
      content.unreadPages && !read.pixelPages.length
        ? ` (the first ${read.looked} of its ${read.pages} pages)`
        : "";
    if (read.text) context.text += `\n\nIts own text${scope}:\n\n${read.text}`;
    if (!read.pixelPages.length) {
      // A document with no text and no page to render is one this run could not
      // read — an empty `.docx`, or a PDF the text layer of which is empty and
      // whose pages the engine would not render — and saying so is what keeps
      // "there is nothing here" from being an answer nobody checked.
      if (!read.text)
        context.text += `\n\nNothing of "${found.name}" could be read as text, and it carries no page to render.`;
      return;
    }
    const handed = config.agent.vision
      ? content.images.map((image) => image.page).join(", ")
      : "";
    context.text +=
      `\n\nPages ${read.pixelPages.join(", ")} of ${read.pages} carry no text layer: ` +
      (handed
        ? `pages ${handed} are handed to you as images`
        : config.agent.vision
          ? "none of them fits this call"
          : "this installation's model is configured without vision, so none of them can be read here") +
      (content.omitted
        ? config.agent.vision
          ? `, and ${content.omitted} more are past the ${pages} pages one run may hand over`
          : `, and ${content.omitted} more are past the ${pages} pages this run reads`
        : "") +
      (content.unreadPages
        ? `, and the last ${content.unreadPages} pages of it were not read at all`
        : "") +
      ".";
    context.images = config.agent.vision ? content.images : [];
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
    if (actions.some((action) => action.do.startsWith("document.")))
      opts.maxPages = await this.maxPages();
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
        `${automationLabel(rule)}: the job document moved under the failing run, so its failure is not written onto it`,
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
    this.deps.log(`${automationLabel(rule)} failed: ${message}`);
    if (!final) return;
    await this.labelQuietly(
      store.accountId,
      { do: "keyword.add", with: { keyword: AGENT_LABEL.needAttention } },
      job.trigger.on === "email" ? job.trigger.emailId : undefined,
    );
    await this.tellChat(
      store.accountId,
      `I could not finish "${automationLabel(rule)}": ${message}`,
    );
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
    /*
     * A decision outlives the rule it was made under: the document may be gone
     * by the time a person answers, and the trail still needs to name what was
     * approved. The job's own trigger record is what the run pinned, so the line
     * is named by the automation that actually ran rather than by a stand-in.
     */
    // A decision outlives the rule it was made under: the document may be gone
    // by the time a person answers, and the trail still names what was approved
    // — by the automation when it is still there, and by its absence when it is
    // not (`automationLabel`).
    const auditRule: AuditRule = rule ?? {
      id: decided.ruleId,
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
    /*
     * The job the approval names must still be the run a person paused. A
     * decision outlives its job, and a job another path already closed
     * (`done`, `failed`) is not this approval's to run: executing it would run
     * a plan nothing waits on and could repeat an effect. The answer is
     * consumed and recorded, and nothing is run.
     */
    if (job && job.state !== "awaiting_approval" && job.state !== "running") {
      const message = `the job is ${job.state}, so the approval is recorded and nothing is run`;
      await recordAudit(
        store,
        auditEntry(job, auditRule, "failed", approvedActions(decided), message),
      );
      await this.tellChat(accountId, `Approved by ${by}, but nothing ran: ${message}`);
      return;
    }
    // The pin reaches a run resumed from an approval too (ADR 0003): an
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
        // The lease goes in the same write as the state, so the run a person
        // approved is this agent's from the instant it is in flight: a job
        // marked `running` with no lease is one the next pass would take for
        // abandoned and start again, which is how the same mail would leave
        // twice (ADR 0003).
        const marked = await this.writeJobIfCurrent(store, job.id, (latest) => ({
          ...latest,
          state: "running",
          proposal: approvedPlan,
          lease: {
            owner: this.deps.agentId,
            heartbeatAt: this.deps.now().toISOString(),
          },
        }));
        // The approval stands and nothing is run: with the document in somebody
        // else's hands, what a person approved is not this run's to run, and a
        // guess at it would be the effect nobody approved. The spent approval
        // is recorded by the pass the sweep makes.
        if (!marked) {
          this.deps.log(
            `${automationLabel(auditRule)}: the job document moved under the approval, so nothing is run`,
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
          const recorded = await this.writeJobIfCurrent(store, job.id, (latest) =>
            withKnowledgeOutcome(
              {
                ...latest,
                applied: [...landed],
                ...(wrote.length
                  ? { effects: [...(latest.effects ?? []), ...wrote] }
                  : {}),
              },
              action,
              result,
              this.deps.now().toISOString(),
            ),
          );
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
   * A pending decision whose draft is no longer in the Drafts mailbox, and is
   * not in Trash either, was sent by a person, and what they sent — edits
   * included — is what was approved. That wins over the conversational reply,
   * so it is settled here.
   *
   * A draft that vanished entirely, or that a person moved to Trash — the
   * ordinary way to discard a draft one disagrees with, in any mail client —
   * is not an approval at all: nothing was ever submitted, so nothing is
   * settled as sent. Treating a trashed draft as "sent" would run the rest of
   * the plan anyway and have the audit trail record a send that never happened.
   */
  async sweepDrafts(
    accountId: string,
    decisionIds: ReadonlyArray<string>,
  ): Promise<string[]> {
    const store = new AgentStore(this.deps.ctx, accountId);
    const closed: string[] = [];
    for (const id of decisionIds) {
      /*
       * A decision is settled under a conditional write, and a lost
       * compare-and-set is not a rival: the account this reads is the same one
       * the agent writes its own bookkeeping into — a schedule armed, a job
       * closed, an anchor advanced — so the document moves under a read for
       * reasons that have nothing to do with the decision. Every other
       * read-modify-write here retries on that (see `saveRules` in
       * `agentAdmin.ts`); this one did not, and a settle it lost left a
       * decision pending for a person who had already answered.
       */
      for (let attempt = 0; attempt < DECISION_SETTLE_ATTEMPTS; attempt++) {
        const found = await store.readDecision(id);
        const decision = found?.doc;
        if (!found || !decision || decision.state !== "pending" || !decision.draft) break;
        const record = await fetchEmailRecord(
          this.deps.client,
          accountId,
          decision.draft.emailId,
          {},
        );
        const inDrafts = record?.mailboxIds?.[decision.draft.mailboxId] === true;
        if (inDrafts) break;
        const inTrash = record
          ? await this.inMailboxRole(accountId, record, "trash")
          : false;
        if (!record || inTrash) {
          // `false` is the document having moved: read it again and settle what
          // is actually there, rather than leaving it pending over a write that
          // landed somewhere else.
          if (await this.expireDraftDecision(store, found)) {
            closed.push(decision.id);
            break;
          }
          continue;
        }
        // Positive evidence of submission, not merely absence from Drafts: a
        // draft a person moved to another folder — Archive, a label, Spam — is
        // neither sent nor discarded, and settling it as sent would run the
        // rest of the plan and have the trail record a send that never
        // happened. It is left pending, so a person can still answer in the
        // chat.
        if (!(await this.inMailboxRole(accountId, record, "sent"))) break;
        if (await this.settleSentDraft(store, accountId, found, "draft")) {
          closed.push(decision.id);
        }
        break;
      }
    }
    return closed;
  }

  /**
   * Whether an email record sits in the account's mailbox of one role, if it
   * has one. One reader for Trash and Sent, which differ only in the role.
   */
  private async inMailboxRole(
    accountId: string,
    record: EmailRecord,
    role: string,
  ): Promise<boolean> {
    const id = await mailboxIdByRole(this.deps.client, accountId, role);
    return id ? record.mailboxIds?.[id] === true : false;
  }

  /**
   * Settle a decision whose draft is gone or discarded: nothing was sent, so
   * the job closes without running the rest of the plan.
   */
  private async expireDraftDecision(
    store: AgentStore,
    found: AgentDoc<AgentDecision>,
  ): Promise<boolean> {
    const decision = found.doc;
    const expired: AgentDecision = {
      ...decision,
      state: "expired",
      decidedBy: "draft",
      decidedAt: this.deps.now().toISOString(),
    };
    try {
      await store.writeDecision(expired, { ifInState: found.state });
    } catch (err) {
      if (isStateMismatch(err)) return false;
      throw err;
    }
    const job = (await store.readJob(decision.jobId))?.doc;
    if (job)
      await this.writeJobIfCurrent(store, job.id, (latest) => closeState(latest, "done"));
    return true;
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
  ): Promise<boolean> {
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
      // The document moved: `false` is the caller's to retry against what is
      // actually there, not a silent abandon.
      if (isStateMismatch(err)) return false;
      throw err;
    }
    const job = (await store.readJob(decision.jobId))?.doc ?? null;
    const rule = await this.ruleOf(store, decision.ruleId);
    const auditRule: AuditRule = rule ?? {
      id: decision.ruleId,
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
      return true;
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
    return true;
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

  private async ruleOf(store: AgentStore, ruleId: string): Promise<AgentRule | null> {
    const rules = (await store.readRules())?.doc ?? [];
    return rules.find((rule) => rule.id === ruleId) ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Schedule                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Plan the account's time triggers and arm the timers. The agent holds the
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
    opts: {
      maxDelayMs: number;
      /**
       * What a fired entry runs inside of. The timer is armed once per account
       * and then fires on its own clock, independent of any poll or push
       * reconcile for the same account — so without a guard here, a fire that
       * lands while a reconcile is already running this account would call
       * `startJob` concurrently with it, a second unfenced way to the same
       * duplicate-execution risk `reconciling` exists to close in `agent.ts`.
       * Defaults to running the work directly, which is what a test that arms
       * a schedule without a live agent around it wants.
       *
       * Its answer is read, never discarded: a fire the lock deferred arms no
       * successor, because the reconcile that owns the account runs the entry
       * from its own catch-up.
       */
      guard?: ScheduleGuard;
      /**
       * The clock and the timers the entries are armed with, in the shape
       * `armTimers` takes them in. Injected so a test drives the arming, the
       * cap and a fire without waiting out a rule's own minute; the globals by
       * default, which is what a agent runs on.
       */
      timers?: Omit<ArmTimersOpts, "maxDelayMs">;
    },
  ): Promise<() => void> {
    const guard: ScheduleGuard = opts.guard ?? runUnguarded;
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
      // agent waited is armed as it now is — and only the entries of the
      // account this agent holds are armed: nothing else is its own to fire.
      dispose?.();
      const current = (await store.readRules())?.doc ?? [];
      const doc = await store.readSchedule();
      const mine = await this.ownScheduleRules(store, current);
      dispose = armTimers(
        planSchedule(current, this.deps.now(), doc?.doc ?? []).filter((entry) =>
          mine.has(entry.ruleId),
        ),
        (entry) => {
          void guard(() => this.fireScheduled(accountId, entry))
            .then((outcome) => {
              // A fire the lock deferred did not happen: the entry is still due
              // in the document and the timer armed for it has fired. Arming
              // again here would arm a timer for an instant that has already
              // arrived — one that fires in the tick it was armed, defers
              // again, and turns the schedule into a request loop against the
              // account's own documents. The reconcile that owns the account
              // runs the entry from its own catch-up, and that catch-up is what
              // arms the timers again.
              if (outcome === "deferred") {
                this.deferredFires.add(accountId);
                return;
              }
              return arm();
            })
            .catch((err: unknown) =>
              this.deps.log(`scheduled run failed: ${errorMessage(err)}`),
            );
        },
        {
          maxDelayMs: opts.maxDelayMs,
          ...opts.timers,
          // A fire whose handler threw synchronously is reported here rather
          // than escaping a timer callback: one entry must not take the agent
          // down or vanish un-armed.
          onError: (err: unknown) =>
            this.deps.log(`scheduled run failed: ${errorMessage(err)}`),
        },
      );
    };
    await arm();
    // A fresh arming plans every entry from the document, so a fire deferred
    // before it is already back on the clock: this account waits for nothing.
    this.deferredFires.delete(accountId);
    this.scheduleArms.set(accountId, arm);
    return () => {
      stopped = true;
      this.scheduleArms.delete(accountId);
      this.deferredFires.delete(accountId);
      dispose?.();
    };
  }

  /**
   * Return an account's schedule to the clock after a fire its lock deferred.
   *
   * A deferral leaves the entry due in the document and the timer armed for it
   * spent, and the armer arms no successor for it: a timer armed for an instant
   * that has arrived fires in the tick it was armed, so a deferral that re-armed
   * itself would spin against the account's documents for as long as the account
   * stayed busy. What runs the entry instead is the reconcile that owns the
   * account, and this is called from that reconcile's own catch-up — so the
   * timers are planned again here, from the document the catch-up has just
   * advanced.
   *
   * Nothing is armed when this process holds no armer for the account — there is
   * no schedule to return to the clock.
   */
  private async rearmAfterDeferredFire(accountId: string): Promise<void> {
    if (!this.deferredFires.delete(accountId)) return;
    await this.scheduleArms.get(accountId)?.();
  }

  /**
   * The schedule rules this agent holds.
   *
   * A claim is the account's and the schedule is one document per account, so
   * the agent that holds the account holds every entry of its schedule.
   * Planning, firing or advancing an entry it does not hold would take a run
   * away from the agent that does — and leave nothing anywhere saying the
   * group's automation did not happen.
   */
  private async ownScheduleRules(
    store: AgentStore,
    rules: ReadonlyArray<AgentRule>,
  ): Promise<Set<string>> {
    const mine = new Set<string>();
    const claim = (await store.readClaim())?.doc;
    if (claim?.agent !== this.deps.agentId) return mine;
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
      const rule: AuditRule = found ?? { id: entry.ruleId, version: 0 };
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
   * The entries that are already due: catch-up after a agent was away.
   *
   * A pass is what reaches it — a time trigger is not a change, so nothing
   * wakes the agent for one — and each due run is started with the claim on
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
      // The same repair on this exit: a deferred fire whose entry is no longer
      // due still left the account holding no timer for it.
      await this.rearmAfterDeferredFire(accountId);
      return 0;
    }
    const owned = await this.ownScheduleRules(store, rules);
    // Only the entries this agent holds are fired from here: a due entry it does
    // not hold keeps its instant for the agent that does, rather than being
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
      // that chose the entry and this one, and a unit that is not this agent's
      // is not this agent's to start.
      const claim = (await store.readClaim())?.doc;
      if (claim?.agent !== this.deps.agentId) {
        this.deps.log(
          `${automationLabel(rule)}: the account's automation is not held by this agent, so the run due at ${entry.at} is not started`,
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
    // This pass is the catch-up the deferral leads to, so the schedule it has
    // just moved on is this pass's to put back on the clock.
    await this.rearmAfterDeferredFire(accountId);
    return started;
  }

  /**
   * One entry fired by its timer: run the rule and move the entry on.
   *
   * The entry is moved on only by the agent that holds the account. One
   * that does not is left where it is, still due, for the agent that does —
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
    // agent's claim lives: a schedule that outlived the agent's lease does
    // not start a run nobody can fence, and it does not consume the entry
    // either — its holder fires it.
    const claim = (await store.readClaim())?.doc;
    if (claim?.agent !== this.deps.agentId) {
      this.deps.log(
        `${automationLabel(rule)}: the account's automation is not held by this agent, so the run due at ${entry.at} is left to its holder`,
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
      // A closed job is a run that happened, and a `running` one is a agent's:
      // the sweep resumes that, and the outcome it writes is the one to read.
      if (job.state === "done" || job.state === "failed") continue;
      if (job.state === "running") continue;
      const rule = rules.find((candidate) => candidate.id === decision.ruleId) ?? {
        id: decision.ruleId,
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
    /*
     * The fence is the agent's claim on the unit, so nothing here — not the
     * spent-approval sweep, not one job — may touch an account this agent does
     * not hold. It is asked once, before anything writes: `recoverSpentApprovals`
     * writes job state and audit rows, and a agent that does not hold the
     * account has no business doing that.
     */
    const claim = (await store.readClaim())?.doc;
    if (claim?.agent !== this.deps.agentId) {
      this.deps.log(
        `${accountId}: the account's automation is held by another agent, so the pending sweep leaves it`,
      );
      return 0;
    }
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
        // A job still `running` belongs to the agent that wrote that state.
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
        /*
         * A crashed run whose remaining plan would leave the process is not
         * resumed. The window `applied` cannot see is between an action landing
         * and its checkpoint: a send, a post, a file may have happened and the
         * document does not say. Re-running the remainder risks a silent second
         * effect, so it is recorded for a person instead — the direction a send
         * must fail in.
         */
        if (this.remainingLeavesProcess(job)) {
          await this.failLoudly(
            store,
            job,
            rule,
            "this run was interrupted around an action that leaves the process, " +
              "so the rest of its plan is not run again on a guess: a person decides",
            { deadLetter: true },
          );
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
      // it in the list. The claim was asked once at the top, before anything
      // wrote: every job reached here belongs to a agent that holds the account.
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
   * Whether a `running` job has lost the agent that wrote that state.
   *
   * The heartbeat is the only witness: a agent that crashed leaves no note,
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

  /**
   * Whether the rest of a crashed run's plan would leave the process.
   *
   * A `running` job an abandoned agent left behind is resumed from the prefix
   * its `applied` ledger recorded. The gap that ledger cannot close is between
   * an action landing and its checkpoint — a send, a post or a file may have
   * happened and the document does not say — so the remainder is only safe to
   * run when none of it leaves the process. One function, read by `runPending`,
   * so "what may a recovery redo" has a single answer (`leavesTheProcess`).
   */
  private remainingLeavesProcess(job: AgentJob): boolean {
    return remainingActions(job.proposal?.actions ?? [], job.applied).some(
      leavesTheProcess,
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
      ? `no agent came back for this run (attempt ${job.attempts || 1} of ${JOB_MAX_ATTEMPTS})`
      : `the automation this run belongs to is gone, so nothing will resume it`;
    await this.failLoudly(
      store,
      job,
      rule ?? { id: job.ruleId, version: job.ruleVersion },
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
     * (ADR 0003). Once a pass has read past it, the ordinary retention applies.
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
  /**
   * How many hops a chain may run, as this installation states it: the bound it
   * set from its own surface, or the one the deployment's environment declares
   * (ADR 0003). Read once for the pass, like the other installation settings.
   */
  chainHops: number;
}

/**
 * A write that moved a record, and the run that made it.
 *
 * The hop is that run's own, so a run woken by it is one hop further, and the
 * instant is when the write landed, which is what makes it the explanation of a
 * change rather than an earlier write to the same record (ADR 0003).
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
 * label it — so among the writes that could explain a wake, the deepest one
 * wins, and two at the same depth are ordered by time and then by the job,
 * which makes the answer the same one on every agent that reads the same
 * documents.
 *
 * The deepest write wins rather than the latest one because "latest" let an
 * unrelated, shallow rule reset a record's perceived chain depth: a rule
 * frequently touching the same record for its own reasons — labelling every
 * arrival, say — could land after a genuinely deep chain's own write and make
 * the next hop look like hop two when it was really hop five, letting the
 * chain evade `maxChainHops` by being interleaved with that unrelated rule
 * (a gap the business logic review named). The bound this map exists to
 * enforce must never be measured too shallow, only ever too deep — the safe
 * direction for a chain-loop guard to err in is refusing a run, not missing
 * one.
 *
 * A write with no instant recorded is left out: it cannot be told from a write
 * that came before the change being reported, so it explains nothing. A write
 * from before this pass's own anchor is left out too — it was already the
 * explanation for an earlier wake, or predates the window this pass reports at
 * all, so it cannot be what explains one happening now.
 */
function producersOf(
  jobs: ReadonlyArray<AgentJob>,
  since?: string,
): Map<string, Producer> {
  const out = new Map<string, Producer>();
  for (const job of jobs) {
    const hop = hopOf(job.trigger);
    for (const effect of job.effects ?? []) {
      if (!effect.at) continue;
      if (since && effect.at < since) continue;
      const candidate: Producer = { jobId: job.id, hop, at: effect.at };
      const key = producerKey(effect.type, effect.id);
      const found = out.get(key);
      if (!found || deeper(candidate, found)) out.set(key, candidate);
    }
  }
  return out;
}

/** Whether one write to a record outranks another: deeper first, then later. */
function deeper(candidate: Producer, found: Producer): boolean {
  if (candidate.hop !== found.hop) return candidate.hop > found.hop;
  if (candidate.at !== found.at) return candidate.at > found.at;
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
  // No anchor, no window: `producersOf` was built with nothing to filter
  // against, so nothing in it can be trusted to be inside this pass's own
  // range rather than merely the account's history.
  if (!pass.since) return null;
  const key =
    trigger.on === "email" && trigger.emailId
      ? producerKey("Email", trigger.emailId)
      : trigger.on === "filenode" && trigger.nodeId
        ? producerKey("FileNode", trigger.nodeId)
        : "";
  if (!key) return null;
  return pass.producers.get(key) ?? null;
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
  return {
    summary: plan.summary,
    actions: plan.actions,
    confidence: plan.confidence,
    draft: null,
  };
}

/**
 * What is left of a plan whose prefix already landed.
 *
 * `applied` is a ledger of action names in order, so the remainder is the tail
 * of the plan from its length. One function, read by the execute path and by
 * the recovery guard, so "what a retry may redo" cannot be spelled two ways.
 */
function remainingActions(
  actions: ReadonlyArray<AgentAction>,
  applied: ReadonlyArray<string> = [],
): AgentAction[] {
  return actions.slice(applied.length);
}

/** The plan a job already carries, so a retry resumes it rather than redeciding. */
function planOf(proposal: AgentProposal): RunPlan {
  return {
    actions: proposal.actions,
    confidence: proposal.confidence,
    summary: proposal.summary,
    // A resumed run spends nothing on this pass: the deciding call it resumes
    // was already counted when it was made, and this is what says so to the
    // meter rather than a row of nulls that reads as a run nobody priced.
    resumed: true,
  };
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
 * server and the admin surface already share (ADR 0003: a run somebody asked
 * for says what it did where the group can read it).
 */
function describeActionsInWords(results: ReadonlyArray<ActionResult>): string {
  const words = results.map(
    (result) => agentActionSpec(result.action)?.label ?? result.action,
  );
  return words.join(", ") || "nothing";
}

/**
 * One action as a person reads it: the catalogue's label, then its parameters.
 *
 * The label alone says "Write in the chat" and hides the words; a member asked
 * to approve a run has to see what it would post. The parameter rendering is
 * `actionParamsText`, the same one the member's panel uses, so the two cannot
 * describe one action differently.
 */
function describeAction(action: AgentAction): string {
  const label = agentActionSpec(action.do)?.label ?? action.do;
  const params = actionParamsText(action);
  return params ? `${label} (${params})` : label;
}

function describeTrigger(trigger: AgentTriggerRecord): string {
  if (trigger.on === "manual")
    return `message ${trigger.emailId ?? "(gone)"}, asked for by a person`;
  if (trigger.on === "email") return `message ${trigger.emailId ?? "(gone)"}`;
  if (trigger.on === "filenode") return `file ${trigger.nodeId ?? "(gone)"}`;
  if (trigger.on === "chat") return `chat message ${trigger.chatId ?? "(gone)"}`;
  return `the schedule of ${trigger.at}`;
}

/** What a lookup reads as in the run's own context. */
function lookupHeading(lookup: AgentLookup): string {
  return `LOOKED UP — ${lookupLabel(lookup)}`;
}

/**
 * What a listing hands the run (ADR 0020).
 *
 * Names, ids and headers, never bodies: the listing is the index a run reads
 * from, and both bounds are stated in the heading — how many of how many — so
 * what the model cannot see, it knows it cannot see.
 */
export function renderItemList(
  lookup: AgentLookup,
  total: number,
  rows: ReadonlyArray<string>,
): string {
  const title = lookupHeading(lookup);
  if (!rows.length) return `${title}: nothing`;
  const header =
    total > rows.length
      ? `${title} (the first ${rows.length} of ${total}):`
      : `${title} (${rows.length}):`;
  return `${header}\n\n${rows.join("\n")}`;
}

/** What one read item hands the run: its own text, bounded and labelled. */
export function renderItem(lookup: AgentLookup, text: string): string {
  return `${lookupHeading(lookup)}:\n\n${text}`;
}

/**
 * One knowledge article as a lookup reads it: the index's fields and its text.
 *
 * The text is carried through the walk so a `knowledge` query can match an
 * article's body, not only its title; the listing itself renders everything
 * but the text.
 */
interface KnowledgeArticleRef {
  id: string;
  title: string;
  tags: string[];
  state: "in force" | "pending" | "draft" | "retired";
  /** Withdrawn but kept: listed only when a lookup asks for it by id. */
  retired: boolean;
  text: string;
}

/**
 * The lifecycle state one article's pointer reads as.
 *
 * A pending revision is named first: it is what an approval recorded with a
 * future effective instant, and until that instant the previous revision is still in
 * force — the reader is told both by `state.json` (ADR 0024). A page with no
 * issued revision is a draft.
 */
function knowledgeStateLabel(state: KnowledgeState | null): KnowledgeArticleRef["state"] {
  if (state?.retired) return "retired";
  if (state?.pending) return "pending";
  if (state?.inForce) return "in force";
  return "draft";
}

/** One knowledge article as a listing line: title, id, state and tags. */
function knowledgeLine(article: KnowledgeArticleRef): string {
  const tags = article.tags.length ? ` [${article.tags.join(", ")}]` : "";
  return `- ${article.title} (id: ${article.id}, ${article.state})${tags}`;
}

/**
 * Whether a visible-tree node answers to a listing's name filter.
 *
 * One filter for both listings — the whole tree and one level — so "where is
 * the packing list" and "what is in this folder that says packing" mean the
 * same thing.
 */
function matchesName(node: FileNodeLike, name?: string): boolean {
  if (!name) return true;
  return String(node.name ?? "")
    .toLowerCase()
    .includes(name.toLowerCase());
}

/** One visible-tree node as a listing line: its path under `prefix`, kind and size. */
function fileLine(node: FileNodeLike, prefix: string): string {
  const name = String(node.name ?? "(unnamed)");
  const path = prefix ? `${prefix}/${name}` : name;
  const kind = node.nodeType === "directory" ? "folder" : "file";
  const size = typeof node.size === "number" ? `, ${node.size} bytes` : "";
  return `- ${path} (${kind}${size})`;
}

/** One message as a listing line: the id a `message` lookup names it by. */
function mailListLine(view: AgentEmailView): string {
  const from = (view.from ?? []).map((a) => a.email ?? a.name ?? "").join(", ");
  const labels = Object.keys(view.keywords ?? {}).filter(
    (keyword) => keyword !== SEEN_KEYWORD && keyword !== DRAFT_KEYWORD,
  );
  return `- ${view.id ?? "?"}  ${view.receivedAt ?? "unknown"}  ${from}  ${
    view.subject ?? "(no subject)"
  }${labels.length ? `  [${labels.join(" ")}]` : ""}`;
}

/** One item's text, cut at the read ceiling and said so. */
function boundedText(text: string | null | undefined): string {
  const value = (text ?? "").trim();
  if (!value) return "(no text)";
  return value.length > AGENT_LOOKUP_TEXT_MAX
    ? `${value.slice(0, AGENT_LOOKUP_TEXT_MAX)}\n…(longer than one read carries)`
    : value;
}

/**
 * Two calls' costs added up, for a run that made more than one.
 *
 * A count the provider did not report keeps the sum honest: a field one call
 * left unknown is unknown for the run, never zero, so the meter says a run's
 * price is a floor rather than inventing a number for it (ADR 0003).
 */
function addUsage(
  total: AgentUsage | undefined,
  next: AgentUsage | undefined,
): AgentUsage | undefined {
  if (!next) return total;
  if (!total) return next;
  return {
    inputHitTokens: addCount(total.inputHitTokens, next.inputHitTokens),
    inputMissTokens: addCount(total.inputMissTokens, next.inputMissTokens),
    outputTokens: addCount(total.outputTokens, next.outputTokens),
  };
}

function addCount(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
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

/**
 * The proposal a member reads in the chat, and answers.
 *
 * What it says is what the run would **do**: the one-sentence summary, then
 * each action with the parameters it carries — the words it would post, the
 * label it would apply, the folder it would file into. The model's reasoning is
 * not here and is nowhere a person reads it: a chain of thought is not what an
 * approval is for, and the deciding call is not asked for one (ADR 0003).
 */
export function proposalText(rule: AgentRule, job: AgentJob): string {
  const proposal = job.proposal;
  if (!proposal) return `"${automationLabel(rule)}" has something to ask.`;
  const lines = [`"${automationLabel(rule)}" suggests: ${proposal.summary}`];
  const actions = proposal.actions.map(describeAction);
  if (actions.length === 1) lines.push(`What it would do: ${actions[0]}.`);
  else if (actions.length > 1)
    lines.push(`What it would do:\n${actions.map((line) => `- ${line}`).join("\n")}`);
  if (proposal.draft)
    lines.push(
      "The message it prepared is in the group's Drafts, marked G-awaiting; sending it there counts as approval.",
    );
  lines.push('Answer "yes" or "no" in a reply.');
  return lines.join("\n");
}
