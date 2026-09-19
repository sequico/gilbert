/**
 * The agent worker fleet's surfaces (ADR 0003): what the admin sees and
 * changes, and what a group member reads.
 *
 * The durable documents live in Stalwart — `agent/documents.ts` is their
 * schema and `agent/store.ts` is the one place they are addressed. This module
 * is the layer between those documents and the routes in `app.ts`: it resolves
 * which account a surface acts on, and it makes the two decisions the
 * documents themselves do not:
 *
 * - what an installation without an agent answers (plainly, never a guess and
 *   never a 500), and
 * - what a member may see (the group's own documents, and nothing else — no
 *   provider key, no write, ever).
 *
 * Everything here runs through the signed-in admin's own session. Acting on
 * the agent's account uses impersonation (`{agent}%{admin}`), which is what
 * ADR 0003's admin surface records; acting on a group's documents uses the
 * admin's own session, because a group's files are reachable exactly through
 * membership (ADR 0005) and Stalwart refuses to mint a session for an
 * impersonated group mailbox.
 */

import { randomUUID } from "node:crypto";
import { readGroupLabels, writeGroupLabels } from "./account.js";
import {
  fetchEmailView,
  groupAccountsDetailed,
  mailboxIdByRole,
} from "./agent/actions.js";
// Liveness is the process's own fact, and the fleet this server hosts is the one
// that answers for it (ADR 0003: the server starts the fleet and its shutdown
// stops it).
import { liveWorkers } from "./agent/agent.js";
import { hasSpoken, readChat } from "./agent/chat.js";
import {
  AGENT_CHAIN_HOPS_CEILING,
  AGENT_INSTRUCTION_FILE,
  AGENT_INSTRUCTION_MAX,
  AGENT_JOB_OPEN_STATES,
  AGENT_NOTEBOOK_FACT_MAX,
  AGENT_NOTEBOOK_FACTS_MAX,
  AGENT_PAGES_CEILING,
  AGENT_PREAMBLE_FILE,
  AGENT_REVIEW_MODES,
  type AgentAuditEntry,
  type AgentConfigDoc,
  type AgentJob,
  type AgentNotebookFact,
  type AgentProvider,
  type AgentReviewMode,
  type AgentRule,
  type AgentTriggerOn,
  type AgentWorkerRecord,
  automationLabel,
  EMPTY_METER,
  isAgentBound,
  isAgentRule,
  isModelMaxOutput,
  MODEL_MAX_OUTPUT_CEILING,
  MODEL_MAX_OUTPUT_DEFAULT,
  meterOver,
  metersByAgent,
  monthOf,
  monthsSince,
  newJob,
  notebookFor,
  policyOf,
  proseFor,
  ruleProblems,
  rulesProblem,
} from "./agent/documents.js";
import { AUDIT_RETENTION_MS } from "./agent/executor.js";
import {
  assertUsableProvider,
  DATA_NOT_INSTRUCTIONS,
  proseHead,
  providerFor,
  readProse,
} from "./agent/llm.js";
import { AgentStore } from "./agent/store.js";
// The shapes this API answers with have one definition, shared with the client
// that reads them (SSOT): `server/src/agent/views.ts`. Declaring them here as
// well is what let a field exist on one side and not the other.
import type {
  AgentApprovalsView,
  AgentAuditExport,
  AgentAuditExportMonth,
  AgentErrorReason,
  AgentGroupDocuments,
  AgentProseView,
  AgentProvidersView,
  AgentReadingView,
  AgentStatus,
  AgentStatusGroup,
  AgentStatusMeter,
  AgentStatusReason,
  AgentStatusWorker,
  AgentWithdrawal,
  GroupAccessDenied,
  GroupMembersView,
  GroupNeed,
  GroupNotebookView,
  GroupPolicyView,
  MemberAgentView,
  PendingApproval,
  RosterReadability,
} from "./agent/views.js";
import {
  type AgentProviderView,
  GROUP_NOT_ACCESSIBLE,
  GROUP_UNREADABLE,
  type GroupDeniedCode,
  WITHDRAWALS_PATH,
} from "./agent/views.js";
import { type Ctx, filesAccountId, readAppJsonAt } from "./appFolder.js";
import { agentAddress, config } from "./config.js";
import {
  isStateMismatch,
  JMAP_MAIL,
  JmapClient,
  JmapError,
  STALWART_CAP,
} from "./jmap.js";
import { impersonationAuthorization, type LiveSession } from "./sessions.js";
import { queryThenGet } from "./shared/jmapQuery.js";
import { isRecord } from "./shared/json.js";
import { AGENT_LABELS } from "./shared/labels.js";
import {
  fetchUpstreamSession,
  getUpstreamSession,
  UpstreamError,
  upstreamFor,
} from "./upstream.js";
import { basicAuth } from "./util.js";

/**
 * A refusal from the admin surface, as the route answers it.
 *
 * What travels is the reason — a code and its parameters — and never a
 * sentence: the client composes it from the catalogue in force, so an
 * administrator reads the refusal in the language the surface is set to, and a
 * language whose catalogue does not carry it reads the English. `Error.message`
 * is the code, because a log line has room for a code and not for a paragraph.
 */
export class AgentAdminError extends Error {
  constructor(
    public readonly reason: AgentErrorReason,
    public readonly status = 400,
  ) {
    super(reason.code);
    this.name = "AgentAdminError";
  }
}

/** How many decisions and audit entries a view shows. */
const VIEW_LIMIT = 50;

/* ------------------------------------------------------------------ */
/* Reaching an account                                                 */
/* ------------------------------------------------------------------ */

/**
 * Act as another principal: the composite `{target}%{admin}` credential built
 * from the administrator's sealed session.
 *
 * Stalwart refuses an app-password session for impersonation (its own source,
 * checked 2026-09-07), so such a session gets a 403 that says so rather than
 * an authorization that would fail upstream. A refused composite is reported
 * as "no such account" — the server does not distinguish "unknown" from "not
 * yours", and inventing a distinction would be a guess.
 */
export async function impersonateAs(
  session: LiveSession,
  target: string,
): Promise<
  { ok: true; ctx: Ctx } | { ok: false; status: 403 | 404 | 502; message: string }
> {
  const targetAuth = impersonationAuthorization(session, target);
  if (!targetAuth)
    return {
      ok: false,
      status: 403,
      message:
        "This admin session uses an app password, which Stalwart refuses for impersonation. Sign in with your password to administer accounts.",
    };
  try {
    const upstream = await fetchUpstreamSession(targetAuth, upstreamFor(target));
    return {
      ok: true,
      ctx: { authorization: targetAuth, session: upstream, username: target },
    };
  } catch (err) {
    if (err instanceof UpstreamError) {
      if (err.status === 401)
        return {
          ok: false,
          status: 404,
          message: "No such account, or it cannot be administered by you.",
        };
      return { ok: false, status: 502, message: err.message };
    }
    throw err;
  }
}

/** The session to reach a group's own documents with, and the account holding them. */
export interface GroupAccess {
  ok: true;
  ctx: Ctx;
  accountId: string;
}

export type GroupAccessResult = GroupAccess | GroupAccessDenied;

/**
 * The agent's own session, and the groups it is granted on — the door every
 * group surface of the administration goes through.
 *
 * The documents an agent runs on (its rules, the standing instruction, the
 * notebook, the labels it files with, the jobs and the audit trail) are the
 * agent's own, and the principal that holds them is the agent. `openAgentSession`
 * is how it is reached — the deployment's credential when there is one,
 * impersonation from the administrator's session otherwise — so a deployment
 * that names no agent, or whose credential the server refuses, says exactly
 * that instead of borrowing the administrator's reach.
 */
export async function agentGroupReach(admin: LiveSession): Promise<{
  ctx: Ctx;
  accounts: Map<string, string>;
  /** The candidates the mail server would not answer about (ADR 0005). */
  unreadable: string[];
}> {
  const address = agentAddress();
  if (!address) throw new AgentAdminError({ code: "agent_not_configured" }, 409);
  const agent = await openAgentSession(admin, address);
  if (!agent.ok)
    throw new AgentAdminError({ code: agent.code, detail: agent.detail }, 409);
  const reach = await groupAccountsDetailed(agent.ctx);
  return {
    ctx: agent.ctx,
    accounts: reach.groups,
    unreadable: reach.unreadable,
  };
}

/**
 * A group's own documents, read and written **as the installation's agent**.
 *
 * The grant that matters is the agent's, read from the agent's own session. An
 * administrator who is a member of the group but whose agent is not granted on
 * it could otherwise author a rule the agent can never run, and one who is not
 * a member could author nothing at all in a group they administer; the
 * administrator's own membership is not a requirement of this door.
 *
 * A group the agent does not hold answers `deniedGroupAccess(need)` — a state
 * the surface names (the grant to add in the directory) rather than a
 * permission error that would read as a bug.
 *
 * `need` is what the calling section asks the group for, and a refusal carries
 * it: one shared sentence about the label catalog would tell a person who had
 * opened the standing instruction about a catalog they were not touching.
 */
export async function resolveGroupAccess(
  admin: LiveSession,
  name: string,
  opts: { need: GroupNeed },
): Promise<GroupAccessResult> {
  const reach = await agentGroupReach(admin);
  const wanted = name.trim().toLowerCase();
  const accountId = reach.accounts.get(wanted);
  if (!accountId)
    return deniedGroupAccess(
      opts.need,
      reach.unreadable.includes(wanted) ? GROUP_UNREADABLE : GROUP_NOT_ACCESSIBLE,
    );
  return { ok: true, accountId, ctx: reach.ctx };
}

/**
 * A member's own reach: the group is in their session, or it is not.
 *
 * The member's surface never impersonates and never borrows the agent's
 * credential: a name that is not in the caller's own session is not a group
 * this person may act as, and the answer is reached without asking the mail
 * server anything — otherwise Stalwart's refusal would be the only thing
 * between a signed-in user and another group's documents.
 */
export async function memberGroupAccess(
  session: LiveSession,
  name: string,
  opts: { need: GroupNeed },
): Promise<GroupAccessResult> {
  // Forced live, not the ordinary cached read: this is a membership check
  // (ADR 0005 — "a member who leaves loses access", stated as immediate), and
  // the cache this session's other calls otherwise share can be up to five
  // minutes old. A cached answer here would let a member removed from the
  // group in Stalwart's own directory keep reading its standing instruction,
  // rules, notebook and chat for up to that long after the grant was
  // withdrawn — a gap the admin path (`agentGroupReach`) never had, since it
  // always signs in fresh.
  const upstream = await getUpstreamSession(
    session.id,
    session.authorization,
    upstreamFor(session.username),
    true,
  );
  const ctx: Ctx = {
    authorization: session.authorization,
    session: upstream,
    username: session.username,
  };
  const reach = await groupAccountsDetailed(ctx);
  const wanted = name.trim().toLowerCase();
  const accountId = reach.groups.get(wanted);
  if (!accountId)
    return deniedGroupAccess(
      opts.need,
      reach.unreadable.includes(wanted) ? GROUP_UNREADABLE : GROUP_NOT_ACCESSIBLE,
    );
  return { ok: true, accountId, ctx };
}

/**
 * Out of reach: the code names which of the two states it is, and the section
 * that was asked for travels beside it — a state the surface names, not a
 * failure.
 */
function deniedGroupAccess(
  need: GroupNeed,
  code: GroupDeniedCode = GROUP_NOT_ACCESSIBLE,
): GroupAccessDenied {
  return { ok: false, error: code, need };
}

/**
 * The two ways opening the agent fails with a reason of its own: the credential
 * this deployment carries was refused, or the account could not be reached at
 * all. Both travel as a code, and the surface composes the sentence it shows.
 */
type AgentRefusalCode = "agent_credentials_rejected" | "agent_unreachable";

/**
 * The agent's own session: the deployment's credential when there is one,
 * impersonation from the admin's session otherwise — the recorded alternative
 * for an installation that would rather never hold the password in the web
 * tier.
 *
 * A credential Stalwart *refuses* is reported as that and nothing else.
 * Falling through to impersonation, as this once did, answers a surface that
 * works while the fleet it administers can never wake: "the key this
 * deployment holds does not turn" is a fact about the deployment, and an
 * administrator who is shown the fleet instead of the fact has no way to learn
 * it. With no password at all there is nothing to refuse, and impersonation is
 * how an administrator reaches the account to read what is there.
 */
export async function openAgentSession(
  admin: LiveSession,
  address: string,
): Promise<
  { ok: true; ctx: Ctx } | { ok: false; code: AgentRefusalCode; detail: string }
> {
  const password = config.agent.password.trim();
  if (password) {
    const authorization = basicAuth(address, password);
    try {
      const session = await fetchUpstreamSession(authorization, upstreamFor(address));
      return { ok: true, ctx: { authorization, session, username: address } };
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      if (err.status === 401)
        return {
          ok: false,
          code: "agent_credentials_rejected",
          detail: `the credential this deployment carries for ${address} was refused`,
        };
      return { ok: false, code: "agent_unreachable", detail: err.message };
    }
  }
  const imp = await impersonateAs(admin, address);
  if (imp.ok) return { ok: true, ctx: imp.ctx };
  return { ok: false, code: "agent_unreachable", detail: imp.message };
}

/** The agent's store, or the honest reason there is nothing to read. */
async function agentStore(
  admin: LiveSession,
): Promise<{ store: AgentStore; address: string }> {
  const address = agentAddress();
  if (!address) throw new AgentAdminError({ code: "agent_not_configured" }, 409);
  const agent = await openAgentSession(admin, address);
  if (!agent.ok)
    throw new AgentAdminError({ code: agent.code, detail: agent.detail }, 409);
  const accountId = filesAccountId(agent.ctx);
  if (!accountId)
    throw new AgentAdminError({ code: "agent_files_account_missing", address }, 409);
  return { store: new AgentStore(agent.ctx, accountId), address };
}

/* ------------------------------------------------------------------ */
/* The status surface                                                  */
/* ------------------------------------------------------------------ */

/**
 * One group row.
 *
 * Membership is not a field here. A row exists because the agent's own session
 * showed it holds the group (ADR 0003), so every row is granted by
 * construction and a row that is not has nothing to carry.
 */
function groupRow(name: string): AgentStatusGroup {
  return { name };
}

/**
 * What the installation's fleet looks like right now.
 *
 * The groups are the agent's own membership and nothing else. They are read
 * from the agent's session, where each group appears as a non-personal account
 * carrying the group's name — membership is decided in Stalwart's own
 * administration and that session is the only witness to it (ADR 0003). So a
 * group an administrator gives the Gilbert user appears here on its own, with
 * no record of ours to keep in step, and a group that is not listed is a group
 * the agent is not in.
 *
 * An agent that cannot be opened lists no group at all: the membership is
 * exactly what could not be read, and `reason` says why.
 */
export async function agentStatus(admin: LiveSession): Promise<AgentStatus> {
  const address = agentAddress();
  /*
   * Both halves or nothing to run. With no address the deployment names no
   * agent; with an address and no password behind it, nobody can sign in as
   * one — the fleet has no key, and the workers that would run it have none
   * either. Either way it is a state an operator fixes in the deployment, and
   * the surface says so rather than offering a fleet that can never wake.
   */
  if (!address || !config.agent.password.trim())
    return {
      operational: false,
      address,
      groups: [],
      meter: noMeter(),
      workers: [],
      withdrawals: [],
      roster: "unknown",
      reason: { code: "agent_not_configured" },
    };

  const agent = await openAgentSession(admin, address);
  if (!agent.ok)
    return {
      operational: false,
      address,
      groups: [],
      meter: noMeter(),
      workers: [],
      withdrawals: [],
      roster: "unknown",
      reason: { code: agent.code, detail: agent.detail },
    };

  const reach = await groupAccountsDetailed(agent.ctx);
  const groups = [...reach.groups.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => groupRow(name));
  if (reach.unreadable.length)
    console.warn(
      "[gilbert] the mail server did not answer about these groups, so they are not counted as the agent's:",
      reach.unreadable.join(", "),
    );
  const meter = await fleetMeter(agent.ctx, reach.groups);
  let workers: AgentStatusWorker[] = [];
  let reason: AgentStatusReason | undefined;
  try {
    workers = await readWorkers(agent.ctx);
  } catch (err) {
    // The agent's session is open; only its own records failed. That is a
    // partial answer, and it says so rather than reporting a still fleet.
    console.warn(
      "[gilbert] could not read the agent's own records:",
      (err as Error).message,
    );
    reason = { code: "agents_unreadable", detail: (err as Error).message };
  }
  return {
    operational: true,
    address,
    groups,
    meter,
    workers,
    withdrawals: await readWithdrawals(agent.ctx),
    // Asked here rather than beside the roster's own read: this is the one
    // place an operator looks when the picker is not offering the group's
    // members, and the answer is about the installation, not about a group.
    roster: await rosterReadability(agent.ctx).catch((): RosterReadability => "unknown"),
    ...(reason ? { reason } : {}),
  };
}

/** The meter a fleet that could not be read answers with: a shape, no claim. */
function noMeter(): AgentStatusMeter {
  return { total: EMPTY_METER, byAgent: [], unreadable: [] };
}

/**
 * What the installation has spent, read from every group the agent holds.
 *
 * The one way to a total that is complete by construction: a run's record lives
 * in the audit document of the group it happened in, and there is no index
 * anywhere else. A group whose audit cannot be read leaves the total a floor,
 * which `unreadable` names rather than hiding behind a zero.
 */
async function fleetMeter(
  ctx: Ctx,
  accounts: Map<string, string>,
): Promise<AgentStatusMeter> {
  const entries: AgentAuditEntry[] = [];
  const unreadable: string[] = [];
  await Promise.all(
    [...accounts].map(async ([name, accountId]) => {
      try {
        entries.push(...(await auditWindow(new AgentStore(ctx, accountId))));
      } catch (err) {
        console.warn(
          "[gilbert] could not read a group's audit for the meter:",
          (err as Error).message,
        );
        unreadable.push(name);
      }
    }),
  );
  return {
    total: meterOver(entries),
    byAgent: metersByAgent(entries),
    unreadable: unreadable.sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * The agent's own withdrawal report: the grants it has lost, newest first.
 */
async function readWithdrawals(ctx: Ctx): Promise<AgentWithdrawal[]> {
  const accountId = filesAccountId(ctx);
  if (!accountId) return [];
  try {
    const raw = await readAppJsonAt(ctx, accountId, WITHDRAWALS_PATH);
    // The worker appends, so the last one in the document is the last one that
    // happened: reversed here, the surface reads them newest first.
    return Array.isArray(raw) ? (raw as AgentWithdrawal[]).reverse() : [];
  } catch (err) {
    console.warn(
      "[gilbert] could not read the agent's withdrawal report:",
      (err as Error).message,
    );
    return [];
  }
}

/**
 * The agent's workers, with liveness read from the process that runs them.
 *
 * A worker's record is written on change — when it starts, when the set of
 * accounts it serves changes, when it stops — so the record says what a worker
 * is **doing** and never whether it is up; a durable stamp cannot answer a
 * question about a process anyway. The answer is in memory, where the process
 * is: this server hosts the fleet (ADR 0003), so the worker it is running right
 * now is the one `liveWorkers()` names, and a record nobody here is running is
 * a worker that stopped, died, or was never this server's.
 */
async function readWorkers(ctx: Ctx): Promise<AgentStatusWorker[]> {
  const accountId = filesAccountId(ctx);
  if (!accountId) return [];
  const records: AgentWorkerRecord[] = await new AgentStore(ctx, accountId).listWorkers();
  const running = new Map(liveWorkers().map((worker) => [worker.id, worker]));
  return records.map((w) => {
    const live = running.get(w.id);
    return {
      id: w.id,
      address: w.address,
      // When this worker last changed what it does, or when the process that
      // runs it started answering for it: both are the worker's own fact, and
      // neither is a clock this surface reads on its behalf.
      heartbeatAt: live ? live.since : w.updatedAt,
      version: w.version,
      // Only a server that runs the fleet can answer this. One that does not
      // says so, rather than reporting every worker as gone.
      alive: config.agent.inprocess ? live !== undefined : null,
      // A record written before the field existed names no group, and a worker
      // holding nothing names none either: both read as "serves nothing here".
      // A running worker answers with what it holds now, which is why the
      // registry is read at all rather than the record alone.
      groups: live ? [...live.groups] : (w.serves ?? []),
    };
  });
}

/* ------------------------------------------------------------------ */
/* A group's documents                                                 */
/* ------------------------------------------------------------------ */

/**
 * The documents of a group the agent does not hold, in the shape every group
 * answer takes.
 *
 * The agent has no path to that group's account at all, so the surface answers
 * empty rather than omitting the fields: a consumer renders one shape, and the
 * reason beside it says why there is nothing in it.
 */
export function emptyGroupDocuments(): Pick<
  AgentGroupDocuments,
  "rules" | "jobs" | "decisions" | "audit" | "meter" | "schedule"
> {
  return {
    rules: [],
    jobs: [],
    decisions: [],
    audit: [],
    // A group nobody could read has no runs to count, which is not the same as
    // a group whose runs cost nothing — and the refusal beside it says which.
    meter: EMPTY_METER,
    schedule: [],
  };
}

/** The group's rules as the rules editor reads them. */
export async function readRules(
  access: GroupAccess,
  accountId: string,
): Promise<AgentRule[]> {
  return (await new AgentStore(access.ctx, accountId).readRules())?.doc ?? [];
}

/**
 * A group's agent documents, as the admin surface shows them.
 *
 * Jobs are the open ones (ADR 0003: `pending → running → awaiting_approval` are
 * the states a job is still alive in; `done` and `failed` are history, and the
 * audit is where history is read). Decisions and audit are bounded, because a
 * view that reads every document a group ever produced gets slower with every
 * run it shows.
 */
export async function groupAgentView(
  access: GroupAccess,
  accountId: string,
): Promise<AgentGroupDocuments> {
  const store = new AgentStore(access.ctx, accountId);
  const [rules, jobs, decisions, schedule] = await Promise.all([
    store.readRules(),
    store.listJobs(),
    store.listDecisions(),
    store.readSchedule(),
  ]);
  // One read of the window for both the panel and the meter.
  const window = await auditWindow(store);
  return {
    rules: rules?.doc ?? [],
    jobs: jobs
      .map((j) => j.doc)
      .filter((j) => AGENT_JOB_OPEN_STATES.includes(j.state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    decisions: decisions
      .map((d) => d.doc)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, VIEW_LIMIT),
    audit: window.slice(-VIEW_LIMIT),
    meter: meterOver(window),
    schedule: schedule?.doc ?? [],
    granted: true,
  };
}

/**
 * The window the surfaces read the trail over: this month and the one before.
 *
 * One reader, one window — the panel shows the last few entries of it, and the
 * meter is a reading of the whole of it, so the two can never disagree about
 * what "recent" means (ADR 0003).
 */
async function auditWindow(store: AgentStore): Promise<AgentAuditEntry[]> {
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const [last, current] = await Promise.all([
    store.readAudit(monthOf(previous)),
    store.readAudit(monthOf(now)),
  ]);
  // Entries are appended in order, so document order is chronological order.
  return [...(last?.entries ?? []), ...(current?.entries ?? [])];
}

/** The last entries of the window, for a panel that shows a few. */
async function readRecentAudit(
  store: AgentStore,
  limit = VIEW_LIMIT,
): Promise<AgentAuditEntry[]> {
  return (await auditWindow(store)).slice(-limit);
}

/**
 * A group's audit trail, month by month, for an administrator to keep.
 *
 * The months are the declared retention's window — the same one `pruneAudit`
 * drops a document at a time — read back through the group's own store, so
 * what the copy holds is what the group's surface reads. Taking the copy is
 * what makes the retention a policy rather than a deletion: the months the
 * prune would remove are here first.
 */
export async function groupAuditExport(
  access: GroupAccess,
  accountId: string,
  name: string,
): Promise<AgentAuditExport> {
  const store = new AgentStore(access.ctx, accountId);
  const now = new Date();
  const months: AgentAuditExportMonth[] = [];
  for (const month of monthsSince(new Date(now.getTime() - AUDIT_RETENTION_MS), now)) {
    const doc = await store.readAudit(month);
    if (doc) months.push({ month, entries: doc.entries });
  }
  return {
    // The name the groups are compared by, not the one that arrived: the member
    // view makes the same promise, and a client keying on the name has to see
    // one group rather than two.
    group: name.trim().toLowerCase(),
    agentAddress: agentAddress(),
    exportedAt: now.toISOString(),
    months,
  };
}

/* ------------------------------------------------------------------ */
/* Saving rules                                                        */
/* ------------------------------------------------------------------ */

/**
 * Save a group's rules, or refuse with something a person can act on.
 *
 * `version` is the server's, not the editor's: a rule whose content changed is
 * bumped, one whose content did not is left alone, so a save that changes
 * nothing invalidates nothing. A save that does change the rule ends the runs
 * pinned to the older version: they are dead-lettered rather than executed as
 * something nobody approved (`executor.ts`, ADR 0003). The write is
 * conditional on the state the document was read at, and a lost race is retried
 * once — JMAP offers no lock, so the compare-and-set is the whole coordination.
 */
export async function saveRules(
  access: GroupAccess,
  accountId: string,
  rules: unknown[],
  by: string,
): Promise<AgentRule[]> {
  const checked = rules.map(checkedRule);
  const seen = new Set<string>();
  for (const rule of checked) {
    if (seen.has(rule.id))
      throw new AgentAdminError({ code: "duplicate_rule", id: rule.id }, 400);
    seen.add(rule.id);
  }
  /*
   * One enabled automation per trigger, refused before anything is written
   * (ADR 0006 decision one). The check is over the whole list this save hands
   * over, because that is the unit the rule is about: an automation carries no
   * filter, so nothing in a document tells two of them on one trigger apart,
   * and the executor runs every one of them against everything that trigger
   * produces. A disabled automation is a draft and is not counted.
   */
  const doubled = rulesProblem(checked);
  if (doubled) {
    // The automation the refusal is about is one on the trigger that carries
    // two: naming the first enabled one in the list would name one that may not
    // be involved at all.
    const crowded = firstDoubledTrigger(checked);
    throw new AgentAdminError(
      {
        code: "rule_cannot_run",
        name: automationLabel({
          trigger: { on: crowded ?? ("email" as const) },
        }),
        problems: doubled,
      },
      400,
    );
  }

  const store = new AgentStore(access.ctx, accountId);
  for (let attempt = 0; ; attempt++) {
    const found = await store.readRules();
    const existing = new Map((found?.doc ?? []).map((r) => [r.id, r]));
    const at = new Date().toISOString();
    const next = checked.map((rule) => {
      const before = existing.get(rule.id);
      const changed = before === undefined || !sameRuleContent(before, rule);
      const version =
        before === undefined
          ? rule.version
          : changed
            ? before.version + 1
            : before.version;
      return { ...rule, version, updatedAt: at, updatedBy: by };
    });
    try {
      // A token only when there is a document to compare against: a first save
      // has none, and the folder tree it creates moves the account state the
      // token would have been read at.
      await store.writeRules(next, found ? { ifInState: found.state } : {});
      return next;
    } catch (err) {
      // Someone else wrote the account between the read and the write: read
      // again and re-apply this save on top of what landed, once.
      if (!isStateMismatch(err) || attempt > 0) throw err;
    }
  }
}

/**
 * Run one of a group's automations now, on a message a person names.
 *
 * The person-shaped door into the one trigger that has no other way in: a chat
 * automation is asked for by talking to the agent in the group's chat and a
 * time one by its own clock, while mail arrives when it likes. What this writes
 * is a job — the same document, the same states, the same sweep — so the worker
 * that holds the group's claim runs it exactly as it runs an arrival. The
 * capability allowlist, the review policy, the version pin and the audit are
 * the ones already in force: a run asked for by a person meets the rule it
 * names, it does not bypass it.
 *
 * What is deliberately *not* written is a refusal into the group's trail. An
 * automation that is not armed, one asked for that is not about mail, a group
 * with no message to run on: each is answered to the person who asked, who can
 * do something about it, and none of them is a run that happened — the audit
 * records what the agent did, not what somebody tried.
 *
 * The message is the one named, or the newest in the group's own inbox: an ask
 * that names none is asking "does this work at all", and the message somebody
 * just sent or received is the one they have in mind.
 */
export async function runRuleNow(
  access: GroupAccess,
  accountId: string,
  ask: { ruleId: unknown; emailId?: unknown },
  by: string,
): Promise<AgentJob> {
  const store = new AgentStore(access.ctx, accountId);
  const rules = (await store.readRules())?.doc ?? [];
  const ruleId = typeof ask.ruleId === "string" ? ask.ruleId : "";
  const rule = rules.find((candidate) => candidate.id === ruleId);
  if (!rule)
    throw new AgentAdminError({ code: "manual_run_refused", why: "rule_not_found" }, 404);
  const name = automationLabel(rule);
  if (!rule.enabled)
    throw new AgentAdminError(
      { code: "manual_run_refused", why: "rule_not_armed", rule: name },
      409,
    );
  if (rule.trigger.on !== "email")
    throw new AgentAdminError(
      { code: "manual_run_refused", why: "rule_not_email", rule: name },
      409,
    );

  const client = new JmapClient(access.ctx);
  const named = typeof ask.emailId === "string" ? ask.emailId.trim() : "";
  const emailId = named || (await newestInboxMessage(client, accountId));
  // Only the message's identity: the run fetches it itself, body included, when
  // it builds the context it reads. Nothing here decides whether the run should
  // look at it — an automation carries no filter, so every message in the group's
  // inbox is one it acts on (ADR 0006).
  const view = emailId ? await fetchEmailView(client, accountId, emailId) : null;
  if (!view)
    throw new AgentAdminError(
      { code: "manual_run_refused", why: "no_message", rule: name },
      409,
    );

  const at = new Date().toISOString();
  const job = newJob({
    id: randomUUID(),
    accountId,
    rule,
    trigger: { on: "manual", emailId: view.id, by, at },
    now: at,
  });
  await store.writeJob(job);
  return job;
}

/**
 * The newest message of the group's own inbox, or null when there is none.
 *
 * A draft is excluded for the same reason the executor excludes one: it is work
 * in progress rather than mail that arrived, and a run that prepares a draft
 * would otherwise be the first thing a person found here.
 */
async function newestInboxMessage(
  client: JmapClient,
  accountId: string,
): Promise<string | null> {
  const inbox = await mailboxIdByRole(client, accountId, "inbox");
  if (!inbox) return null;
  const result = await client.chain(
    [
      [
        "Email/query",
        {
          accountId,
          filter: { inMailbox: inbox, notKeyword: "$draft" },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: 1,
        },
        "q",
      ],
    ],
    [JMAP_MAIL],
  );
  const raw = result.raw("q");
  const ids =
    raw && raw[0] === "Email/query" && Array.isArray(raw[1].ids) ? raw[1].ids : [];
  const first = ids[0];
  return first === undefined ? null : String(first);
}

/**
 * One rule of a save, or a refusal naming everything wrong with it.
 *
 * Validation is the published schema plus the cross-field rules
 * (`ruleProblems`), so what the editor checks in the browser is exactly what
 * the server enforces here — and a refusal lists every problem, because
 * fixing one per round trip is how a form becomes a chore.
 */
function checkedRule(rule: unknown, index: number): AgentRule {
  const problems = ruleProblems(rule);
  if (problems.length) {
    // A document refused before it reads as one has no trigger to be named by,
    // so the refusal names the position the save put it at instead.
    const name =
      rule && typeof rule === "object" && isAgentRule(rule)
        ? automationLabel(rule)
        : `#${index + 1}`;
    throw new AgentAdminError(
      { code: "rule_cannot_run", name, problems: problems.join("; ") },
      400,
    );
  }
  if (!isAgentRule(rule))
    throw new AgentAdminError({ code: "rule_not_a_document", index: index + 1 }, 400);
  return rule;
}

/** Whether two rules carry the same content — version and stamps are not content. */
function sameRuleContent(a: AgentRule, b: AgentRule): boolean {
  const content = (rule: AgentRule): string => {
    const { version: _v, updatedAt: _at, updatedBy: _by, ...rest } = rule;
    return stableJson(rest);
  };
  return content(a) === content(b);
}

/** JSON with object keys in a stable order, so two documents compare by content. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/* ------------------------------------------------------------------ */
/* Providers — the agent's own configuration                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

/**
 * The installation's model, with `hasKey` in place of the stored key.
 *
 * The key is write-only, the way an app password is: the surface can say
 * whether one is stored and can replace it, and can never read it back. An
 * installation with no agent answers with an empty address rather than an
 * error — there is nothing to show, and that is a state, not a failure.
 */
export async function readProviders(admin: LiveSession): Promise<AgentProvidersView> {
  if (!agentAddress())
    return {
      address: "",
      provider: null,
      maxOutputTokens: MODEL_MAX_OUTPUT_DEFAULT,
      maxChainHops: Math.min(config.agent.maxChainHops, AGENT_CHAIN_HOPS_CEILING),
      maxPages: Math.min(config.agent.maxPages, AGENT_PAGES_CEILING),
    };
  const { store, address } = await agentStore(admin);
  const found = await store.readConfig();
  return {
    address: found?.doc.address || address,
    provider: providerView(found?.doc.provider),
    maxOutputTokens: found?.doc.maxOutputTokens ?? MODEL_MAX_OUTPUT_DEFAULT,
    // The number the runs are held to, not the number a hand-edited document
    // asks for: the surface shows what is spent, and saving writes that back
    // rather than leaving a document whose bound nobody applies (ADR 0003).
    maxChainHops: Math.min(
      found?.doc.maxChainHops ?? config.agent.maxChainHops,
      AGENT_CHAIN_HOPS_CEILING,
    ),
    maxPages: Math.min(found?.doc.maxPages ?? config.agent.maxPages, AGENT_PAGES_CEILING),
  };
}

function providerView(provider: AgentProvider | undefined): AgentProviderView | null {
  if (!provider) return null;
  return {
    provider: provider.provider,
    model: provider.model,
    baseUrl: provider.baseUrl,
    hasKey: provider.apiKey.length > 0,
  };
}

/**
 * Write the installation's model.
 *
 * The body carries one entry, or none to clear it. An absent or empty `apiKey`
 * keeps the stored one — that is the point of a write-only key, since the
 * surface cannot send back what it was never given. The config document is the
 * agent's own (`agent/config.json` in the agent account's app folder) and is
 * created on the first write, stamped with the address it was registered under
 * and who registered it.
 *
 * A lost compare-and-set is retried once, because the token is the account's
 * whole FileNode state (ADR 0003) and this is the account the worker writes
 * its heartbeat and its audit in: the agent's own bookkeeping invalidates a
 * save that overlaps it, for no reason to do with this document.
 */
export async function writeProviders(admin: LiveSession, input: unknown): Promise<void> {
  const { store, address } = await agentStore(admin);
  if (!isRecord(input))
    throw new AgentAdminError({ code: "provider_not_an_object" }, 400);
  const given = input;
  const settable = ["provider", "maxOutputTokens", "maxChainHops", "maxPages"];
  for (const key of Object.keys(given)) {
    if (!settable.includes(key))
      throw new AgentAdminError({ code: "provider_not_an_object" }, 400);
  }
  // The ceiling is the installation's own statement about what an answer may
  // cost. `null` clears it back to the default; a value the ceiling forbids is
  // refused here, where an administrator reads a sentence, rather than at the
  // call, where the bill is the diagnosis.
  const hasProvider = Object.hasOwn(given, "provider");
  const hasCeiling = Object.hasOwn(given, "maxOutputTokens");
  const ceiling = given.maxOutputTokens;
  if (hasCeiling && ceiling !== null && !isModelMaxOutput(ceiling))
    throw new AgentAdminError(
      { code: "max_output_tokens_invalid", max: MODEL_MAX_OUTPUT_CEILING },
      400,
    );
  // The two bounds a chain and a page budget are held to, the same way: the
  // installation states them where it states its model, and `null` clears one
  // back to what the deployment's environment says.
  const hops = given.maxChainHops;
  if (
    Object.hasOwn(given, "maxChainHops") &&
    hops !== null &&
    !isAgentBound(hops, AGENT_CHAIN_HOPS_CEILING)
  )
    throw new AgentAdminError(
      { code: "max_chain_hops_invalid", max: AGENT_CHAIN_HOPS_CEILING },
      400,
    );
  const pages = given.maxPages;
  if (
    Object.hasOwn(given, "maxPages") &&
    pages !== null &&
    !isAgentBound(pages, AGENT_PAGES_CEILING)
  )
    throw new AgentAdminError(
      { code: "max_pages_invalid", max: AGENT_PAGES_CEILING },
      400,
    );

  for (let attempt = 0; ; attempt++) {
    const found = await store.readConfig();
    const existing = found?.doc;
    // A key the write does not mention is left as it is: a write that states
    // the ceiling alone must not clear the model, and one that replaces the
    // model must not clear the ceiling (ADR 0003).
    const provider = hasProvider
      ? providerEntry(given.provider, existing?.provider)
      : undefined;
    const doc: AgentConfigDoc = existing
      ? { ...existing }
      : {
          v: 1,
          address,
          registeredAt: new Date().toISOString(),
          registeredBy: admin.username,
        };
    // A cleared entry leaves no `provider` key behind rather than a `null` one:
    // the document says what the installation runs on, and "nothing" is said by
    // absence.
    if (provider === null) delete doc.provider;
    else if (provider) doc.provider = provider;
    if (hasCeiling) {
      if (typeof ceiling === "number") doc.maxOutputTokens = ceiling;
      else delete doc.maxOutputTokens;
    }
    if (Object.hasOwn(given, "maxChainHops")) {
      if (typeof hops === "number") doc.maxChainHops = hops;
      else delete doc.maxChainHops;
    }
    if (Object.hasOwn(given, "maxPages")) {
      if (typeof pages === "number") doc.maxPages = pages;
      else delete doc.maxPages;
    }
    try {
      // A token only when there is a document to compare against: the first
      // save has none, and the folder tree it creates moves the account state
      // the token would have been read at, which the server then refuses as a
      // lost race.
      await store.writeConfig(doc, found ? { ifInState: found.state } : {});
      return;
    } catch (err) {
      if (!isStateMismatch(err) || attempt > 0) throw err;
    }
  }
}

/**
 * The first trigger two enabled automations share, or null.
 *
 * `rulesProblem` says what is wrong with the list; this says which trigger to
 * name it by, so the refusal points at the pair a person has to choose between
 * rather than at whichever automation happens to come first.
 */
function firstDoubledTrigger(rules: ReadonlyArray<AgentRule>): AgentTriggerOn | null {
  const seen = new Set<AgentTriggerOn>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (seen.has(rule.trigger.on)) return rule.trigger.on;
    seen.add(rule.trigger.on);
  }
  return null;
}

/** The installation's model as the editor sends it; null when it is cleared. */
function providerEntry(
  raw: unknown,
  previous: AgentProvider | undefined,
): AgentProvider | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw new AgentAdminError({ code: "provider_incomplete" }, 400);
  const entry = raw;
  const text = (key: string): string =>
    typeof entry[key] === "string" ? (entry[key] as string).trim() : "";
  const provider = text("provider");
  const model = text("model");
  const baseUrl = text("baseUrl");
  // An entry with nothing in it is a cleared entry, not an invalid one.
  if (!provider && !model && !baseUrl) return null;
  if (!provider || !model || !baseUrl)
    throw new AgentAdminError({ code: "provider_incomplete" }, 400);
  assertUsableBaseUrl(baseUrl);
  /*
   * The stored key is kept unless a new one arrives — it is never read back —
   * but **not** when the endpoint moves: the key was issued for the host it was
   * entered against, and carrying it to a different base URL would hand the
   * group's credential to whoever wrote that URL. Moving the endpoint means
   * entering the key again, which is the only way the server can tell the two
   * apart.
   */
  const moved = previous !== undefined && previous.baseUrl !== baseUrl;
  const apiKey = text("apiKey") || (moved ? "" : (previous?.apiKey ?? ""));
  if (!apiKey)
    throw new AgentAdminError(
      moved
        ? { code: "api_key_required_after_move", movedTo: baseUrl }
        : { code: "api_key_required" },
      400,
    );
  return { provider, model, baseUrl, apiKey };
}

/**
 * Refuse a base URL the worker should not be pointed at.
 *
 * The worker sends the group's API key to whatever this names, from inside the
 * deployment's own network. A plaintext URL sends the key in the clear, and an
 * address inside the network turns the worker into a way to reach services that
 * are not on the internet — so both are refused here, where an administrator
 * gets a sentence, rather than at the call, where a 30-second timeout would be
 * the whole diagnosis.
 */
function assertUsableBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AgentAdminError({ code: "base_url_invalid" }, 400);
  }
  if (url.protocol !== "https:")
    throw new AgentAdminError({ code: "base_url_not_https" }, 400);
  if (isPrivateHost(url.hostname))
    throw new AgentAdminError({ code: "base_url_private", host: url.hostname }, 400);
}

/** Loopback, link-local, and the private ranges — where a provider is not. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal"))
    return true;
  if (
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  )
    return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* The prose an agent carries                                          */

/**
 * One document of prose an agent carries, as a surface reads it.
 *
 * The two scopes it exists at — the installation's own rules, in the Master's
 * account, and a group's standing instruction, in the group's — are one
 * document type at two reaches, so they are read and written by one pair of
 * functions that differ only in the account and the path handed to them. The
 * caller that has a group names `AGENT_INSTRUCTION_FILE`; the one that has the
 * installation names `AGENT_PREAMBLE_FILE` against the agent's own account.
 *
 * Written by an administrator — not by every member — because a text handed to
 * the model on every call is configuration, and configuration is what the rules
 * document already is. Read by every member of a group, on the member's own
 * route: what the agent is told is exactly what a member has to be able to
 * judge (ADR 0003 resolution 17), so the read is shared and the pen is not.
 */
export async function readAgentProse(
  access: { ctx: Ctx; accountId: string },
  path: string,
): Promise<AgentProseView> {
  const found = await new AgentStore(access.ctx, access.accountId).readProse(path);
  return {
    text: found?.doc.text ?? "",
    updatedAt: found?.doc.updatedAt ?? null,
    updatedBy: found?.doc.updatedBy ?? null,
    max: AGENT_INSTRUCTION_MAX,
  };
}

/**
 * Replace one document of prose. An empty text removes it.
 *
 * The length bound is the document's own (`isAgentProseDoc`), applied here so a
 * person gets a sentence rather than a document that silently fails to read
 * back.
 */
export async function saveAgentProse(
  access: { ctx: Ctx; accountId: string },
  path: string,
  text: string,
  by: string,
): Promise<AgentProseView> {
  const trimmed = text.trim();
  if (trimmed.length > AGENT_INSTRUCTION_MAX)
    throw new AgentAdminError(
      {
        code: "instruction_too_long",
        max: AGENT_INSTRUCTION_MAX,
        length: trimmed.length,
      },
      400,
    );
  const store = new AgentStore(access.ctx, access.accountId);
  const found = await store.readProse(path);
  if (!trimmed) {
    if (found) await store.removeProse(path);
    return { text: "", updatedAt: null, updatedBy: null, max: AGENT_INSTRUCTION_MAX };
  }
  const doc = await store.writeProse(
    path,
    trimmed,
    by,
    found ? { ifInState: found.state } : {},
  );
  return {
    text: doc.text,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
    max: AGENT_INSTRUCTION_MAX,
  };
}

/* ------------------------------------------------------------------ */
/* The group's policy                                                  */

/**
 * A group's policy, as a surface reads it.
 *
 * A group that has written none answers with the cautious default and
 * `present: false`, so a form can say what it is running on rather than showing
 * a reading nobody chose (ADR 0006).
 */
export async function readGroupPolicy(access: GroupAccess): Promise<GroupPolicyView> {
  const found = await new AgentStore(access.ctx, access.accountId).readPolicy();
  const policy = policyOf(found?.doc ?? null);
  return {
    review: policy.review,
    allowExternal: policy.allowExternal,
    present: found !== null,
    updatedAt: found?.doc.updatedAt ?? null,
    updatedBy: found?.doc.updatedBy ?? null,
  };
}

/**
 * Replace a group's policy.
 *
 * Two facts and no number: how cautious the group's runs are, and whether they
 * may reach outside it without a person. A policy is always written whole — a
 * group that has none gets one the first time this is called — because "nothing
 * has said how cautious this group is" is answered by the default rather than
 * by half a document.
 */
export async function saveGroupPolicy(
  access: GroupAccess,
  input: { review: unknown; allowExternal: unknown },
  by: string,
): Promise<GroupPolicyView> {
  const review = input.review;
  if (!(AGENT_REVIEW_MODES as ReadonlyArray<unknown>).includes(review))
    throw new AgentAdminError({ code: "review_mode_unknown" }, 400);
  if (typeof input.allowExternal !== "boolean")
    throw new AgentAdminError({ code: "policy_not_an_object" }, 400);
  const store = new AgentStore(access.ctx, access.accountId);
  const found = await store.readPolicy();
  const doc = await store.writePolicy(
    { review: review as AgentReviewMode, allowExternal: input.allowExternal },
    by,
    found ? { ifInState: found.state } : {},
  );
  return {
    review: doc.review,
    allowExternal: doc.allowExternal,
    present: true,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
  };
}

/* ------------------------------------------------------------------ */
/* The author's reading                                                */
/* ------------------------------------------------------------------ */

/**
 * An author's reading: the draft, the envelope it belongs to, the group's
 * instruction and the group's notebook go to the installation's model, which
 * answers in words about the gaps (ADR 0003).
 *
 * It is **not a run**. Nothing is compiled, no document is produced, no job is
 * written and no claim is taken — it is a call from the web tier with a timeout
 * and no lease, which is why neither the executor nor a worker is anywhere in
 * this path. Thinking is off: "is this prose coherent" is a question about
 * text, and its answer is a sentence rather than a chain of thought.
 *
 * Its tokens are counted in the **Master's own account**, marked as authoring,
 * and not in the group's: a run's record belongs to the group it works in and
 * is written by the agent holding it, while an administrator reading a draft is
 * the installation's own work, belongs to no group's ledger, and leaves the
 * group's usage document with a single writer.
 */
export async function readDraft(
  admin: LiveSession,
  input: { access: GroupAccess; about: string; draft: string; envelope?: string },
): Promise<AgentReadingView> {
  const { store } = await agentStore(admin);
  // The installation's own provider, configured once (ADR 0003). An
  // installation without one has nothing to read a draft with, which is a state
  // the surface names rather than an upstream failure.
  let provider: ReturnType<typeof providerFor>;
  try {
    provider = providerFor((await store.readConfig())?.doc ?? null);
    // The same check the runs make, at the one other place the key leaves the
    // process: this path is a call the web tier makes (ADR 0003).
    assertUsableProvider(provider, config.agent.allowPrivateProvider);
  } catch {
    throw new AgentAdminError({ code: "no_provider" }, 409);
  }
  // The two documents as a prompt carries them: the same renderers the runs
  // use (`instructionFor`, `notebookFor`), so a reading is asked about the same
  // prose a run would be given.
  const group = new AgentStore(input.access.ctx, input.access.accountId);
  // A draft longer than the document that could hold it is a reading of the
  // wrong thing: the same ceiling the save path applies, applied before the
  // installation pays for it.
  if (input.draft.length > AGENT_INSTRUCTION_MAX)
    throw new AgentAdminError(
      {
        code: "instruction_too_long",
        max: AGENT_INSTRUCTION_MAX,
        length: input.draft.length,
      },
      400,
    );
  if ((input.envelope ?? "").length > AGENT_INSTRUCTION_MAX)
    throw new AgentAdminError(
      {
        code: "envelope_too_long",
        max: AGENT_INSTRUCTION_MAX,
        length: (input.envelope ?? "").length,
      },
      400,
    );
  // The reservation and the ceiling check are the same compare-and-set
  // attempt (`reserveAuthoring`), so two overlapping calls can no longer both
  // read "room under the ceiling" and both spend — the loser re-reads the
  // document the winner just wrote and is refused by the same rule. A reading
  // is not a run, so no job's ceiling bounds it, and the one record of what
  // the installation bought is the authoring document (ADR 0003).
  const token = randomUUID();
  const reserved = await store.reserveAuthoring(config.agent.authoringMonthlyMax, {
    token,
    about: input.about,
    group: (
      input.access.ctx.session.accounts?.[input.access.accountId] as { name?: string }
    )?.name,
    by: admin.username,
  });
  if (!reserved)
    throw new AgentAdminError(
      { code: "authoring_budget_spent", max: config.agent.authoringMonthlyMax },
      409,
    );
  /*
   * The same prose a run carries, read the same way and in the same order: a
   * reading is a judgement of a draft against what the agent would actually be
   * told, and a reading asked under a different head would be a reading of
   * something nobody runs. `proseHead` is the one builder of that order.
   */
  const [installation, instruction, notebook] = await Promise.all([
    store.readProse(AGENT_PREAMBLE_FILE),
    group.readProse(AGENT_INSTRUCTION_FILE),
    group.readNotebook(),
  ]);
  const system = [
    DATA_NOT_INSTRUCTIONS,
    "You are reading a draft an administrator is writing for an agent that acts",
    "in a group's mail. Answer in words about the draft, in the language it is",
    "written in: is it coherent, and where are the gaps?",
    "Name the gaps concretely — what the draft leaves the agent to decide for",
    "itself — and answer in one short paragraph.",
    "Do not rewrite the draft, do not propose an envelope, and ask for nothing.",
    input.envelope ? `The draft's envelope: ${input.envelope}` : "",
    ...proseHead({
      preamble: proseFor(installation?.doc ?? null),
      standing: proseFor(instruction?.doc ?? null),
      notebook: notebookFor(notebook?.doc ?? null),
    }),
  ]
    .filter(Boolean)
    .join("\n");
  let answer: Awaited<ReturnType<typeof readProse>>;
  try {
    answer = await readProse(provider, {
      system,
      user: input.draft,
      thinking: false,
      // The installation's own ceiling on an answer, the same one a run is held
      // to: a reading spends tokens too, and the lever that bounds spend is not
      // a lever if the one path beside the runs ignores it (ADR 0003).
      maxOutputTokens: (await store.readConfig())?.doc.maxOutputTokens,
    });
  } catch (err) {
    // The call never happened, so the reservation must not count against the
    // month's ceiling either — a provider outage otherwise spends the
    // installation's budget on answers nobody received.
    await store.cancelAuthoring(token).catch(() => {});
    // A refusal is a code and what the provider said beside it, never a
    // sentence of ours on the wire.
    throw new AgentAdminError(
      { code: "reading_failed", detail: (err as Error).message },
      502,
    );
  }
  const text = answer.text.trim();
  if (!text) {
    await store.cancelAuthoring(token).catch(() => {});
    throw new AgentAdminError(
      { code: "reading_failed", detail: "the provider answered with nothing" },
      502,
    );
  }
  // The reservation is settled with the call's usage after the words are paid
  // for, so a count that will not land — a compare-and-set that kept losing, a
  // document that does not read as one — costs the record and not the answer:
  // the reading is returned either way, and the line an operator needs is left
  // on the server rather than put to the person who asked.
  let counted = true;
  try {
    await store.finalizeAuthoring(token, answer.usage);
  } catch (err) {
    counted = false;
    console.warn(
      "[gilbert] could not settle a reading in the month's authoring document:",
      (err as Error).message,
    );
  }
  return { text, counted };
}

/* ------------------------------------------------------------------ */
/* The group's notebook                                                */
/* ------------------------------------------------------------------ */

/**
 * The group's notebook, as an administrator reads it.
 *
 * Memory is a document in the group's own account (ADR 0003): the facts its
 * agent holds in every call, each one a line a person can read, change, remove
 * or add. A group that has none answers with an empty list rather than an
 * error, which is a state and not a failure — and the bounds travel with the
 * answer, so a form states the ones the document enforces rather than its own.
 */
export async function readGroupNotebook(access: GroupAccess): Promise<GroupNotebookView> {
  const store = new AgentStore(access.ctx, access.accountId);
  const found = await store.readNotebook();
  return {
    facts: found?.doc.facts ?? [],
    updatedAt: found?.doc.updatedAt ?? null,
    updatedBy: found?.doc.updatedBy ?? null,
    maxFact: AGENT_NOTEBOOK_FACT_MAX,
    maxFacts: AGENT_NOTEBOOK_FACTS_MAX,
  };
}

/**
 * Replace the group's notebook with the facts the surface sent.
 *
 * Ids and stamps are the server's: a fact that arrives without an id is given
 * one here, and every fact is stamped with who wrote it now — so no surface
 * carries its own rule for either, and the same fact edited twice does not
 * become two. An empty fact is dropped rather than stored as a blank line.
 */
export async function saveGroupNotebook(
  access: GroupAccess,
  input: unknown,
  by: string,
): Promise<GroupNotebookView> {
  if (!isRecord(input))
    throw new AgentAdminError({ code: "notebook_not_an_object" }, 400);
  const raw = (input as { facts?: unknown }).facts;
  if (!Array.isArray(raw))
    throw new AgentAdminError({ code: "notebook_not_an_object" }, 400);
  if (raw.length > AGENT_NOTEBOOK_FACTS_MAX)
    throw new AgentAdminError(
      { code: "notebook_too_many", max: AGENT_NOTEBOOK_FACTS_MAX },
      400,
    );
  const at = new Date().toISOString();
  const facts: AgentNotebookFact[] = [];
  for (const entry of raw) {
    const fact = (entry ?? {}) as { id?: unknown; text?: unknown };
    const text = typeof fact.text === "string" ? fact.text.trim() : "";
    if (!text) continue;
    if (text.length > AGENT_NOTEBOOK_FACT_MAX)
      throw new AgentAdminError(
        { code: "notebook_fact_too_long", max: AGENT_NOTEBOOK_FACT_MAX },
        400,
      );
    facts.push({
      id: typeof fact.id === "string" && fact.id ? fact.id : randomUUID(),
      text,
      addedAt: at,
      addedBy: by,
    });
  }
  const store = new AgentStore(access.ctx, access.accountId);
  const found = await store.readNotebook();
  await store.writeNotebook(facts, by, found ? { ifInState: found.state } : {});
  return readGroupNotebook(access);
}

/* The reserved labels a group's agent needs                           */
/* ------------------------------------------------------------------ */

/**
 * Add the reserved `G-` labels to a group's catalog (ADR 0003 resolution 9).
 *
 * Membership is the grant for this write, exactly as it is for the rest of the
 * catalog: it goes through the group's own session, and the existing entries
 * are left exactly as they are. A catalog holding entries Gilbert cannot read
 * is refused rather than rewritten — writing over somebody's labels because one
 * of them is the wrong shape would lose them.
 */
export async function addAgentLabels(
  access: GroupAccess,
  accountId: string,
): Promise<{ added: string[] }> {
  const read = await readGroupLabels(access.ctx, accountId);
  /*
   * A catalog holding entries Gilbert cannot read is refused rather than
   * rewritten — writing over somebody's labels because one of them is the wrong
   * shape would lose them — and the reader reports that state on its own,
   * separately from a group that has no catalog at all.
   */
  if (read.state === "unreadable")
    throw new AgentAdminError({ code: "group_labels_unreadable" }, 502);
  const existing = read.state === "catalog" ? read.labels : [];
  const have = new Set(existing.map((l) => l.keyword));
  const missing = AGENT_LABELS.filter((l) => !have.has(l.keyword));
  if (!missing.length) return { added: [] };
  await writeGroupLabels(access.ctx, accountId, [...existing, ...missing]);
  return { added: missing.map((l) => l.keyword) };
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

/**
 * Every decision waiting on a person, across the groups the agent holds.
 *
 * The chat is where an approval is answered (resolution 10); this queue is the
 * oversight and the escape hatch, so it is read-only and it never invents a
 * group: a group the agent does not hold simply has nothing to show here.
 *
 * The walk is the agent's own session — exactly the set of groups a decision
 * can be waiting in, since the agent is the principal that asks — read once for
 * the whole queue. There is no directory listing to fall short of it, so the
 * answer is complete by construction and carries no enumeration caveat.
 */
export async function pendingApprovals(admin: LiveSession): Promise<AgentApprovalsView> {
  const out: PendingApproval[] = [];
  const reach = await agentGroupReach(admin);
  for (const [name, accountId] of reach.accounts) {
    const decisions = await new AgentStore(reach.ctx, accountId).listDecisions();
    for (const { doc } of decisions) {
      if (doc.state !== "pending") continue;
      out.push({
        group: name,
        decisionId: doc.id,
        jobId: doc.jobId,
        summary: doc.summary,
        confidence: doc.confidence,
        createdAt: doc.createdAt,
      });
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { approvals: out };
}

/* ------------------------------------------------------------------ */
/* What a member sees                                                  */
/* ------------------------------------------------------------------ */

/**
 * A group member's read-only view of the agent (ADR 0003, "Members see, never
 * change").
 *
 * Rules are cut down to what a member reads: what the automation is, whether it
 * is on, what wakes it, how it is reviewed, what it is asked to do, and which
 * actions it may take — and the group's standing instruction, the
 * text the agent carries into every model call, is here as text. Nothing on
 * this path can write, and no provider configuration is reachable from it at
 * all — the agent's own account belongs to the installation, not to a member.
 *
 * `granted` is what the group's own account proves, and deliberately not a
 * claim about the operator's grant list: a member's session cannot read another
 * principal's grants (impersonation is an administrator right, and Stalwart
 * never hands a group's membership out over JMAP). What the group's account
 * does prove is that the agent works here — it has spoken in the group, an
 * instruction or rules were authored for it, or jobs and audit entries exist —
 * which is the evidence this view reports.
 */
export async function memberAgentView(
  session: LiveSession,
  name: string,
): Promise<MemberAgentView | GroupAccessDenied> {
  const access = await memberGroupAccess(session, name, {
    need: "agent documents",
  });
  if (!access.ok) return access;
  const store = new AgentStore(access.ctx, access.accountId);
  const [rules, jobs, audit, instruction, policy, chat] = await Promise.all([
    store.readRules(),
    store.listJobs(),
    readRecentAudit(store),
    // The same two documents the admin surface writes, read here with the
    // member's own session: a member's own grant is what reaches a group's files
    // (ADR 0005), and this route never impersonates and never borrows the agent's
    // credential. The policy is read the same way — who a run stops for is a
    // fact about the group that a member judges the agent by.
    readAgentProse(access, AGENT_INSTRUCTION_FILE),
    readGroupPolicy(access),
    // The transcript is the group's own proof that the agent works here: the
    // greeting the agent posts when it takes the group's claim is readable by
    // the member's own session, where the grant list is not.
    readChat(access.ctx, access.accountId, new JmapClient(access.ctx)),
  ]);
  const rulesDoc = rules?.doc ?? [];
  const open = jobs
    .map((j) => j.doc)
    .filter((j) => AGENT_JOB_OPEN_STATES.includes(j.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    // The name the groups are compared by, not the one that arrived: the view
    // and the lookup have to name the same group, or a client keying on it sees
    // two.
    group: name.trim().toLowerCase(),
    granted:
      hasSpoken(chat, agentAddress()) ||
      rulesDoc.length > 0 ||
      open.length > 0 ||
      audit.length > 0 ||
      !!instruction.text,
    agentAddress: agentAddress(),
    rules: rulesDoc.map((r) => ({
      id: r.id,
      enabled: r.enabled,
      trigger: r.trigger,
      instruction: r.instruction,
    })),
    instruction,
    policy,
    jobs: open,
    audit,
  };
}

/* ------------------------------------------------------------------ */
/* A group's members                                                   */
/* ------------------------------------------------------------------ */

/**
 * How long a group's roster is held before Stalwart is asked again.
 *
 * Membership is given in Stalwart's own administration and nothing tells this
 * process about it, so the alternative to a window is asking the directory at
 * every mention. A minute keeps the read rare and the staleness small enough
 * that a departure is gone from the next mention after it. This is a cache of
 * a read, never a durable document: ADR 0012 refuses a write on a clock, not a
 * read, and nothing here is written anywhere.
 */
const ROSTER_TTL_MS = 60_000;

/** The most members one roster read asks for; a page, not the whole registry. */
const ROSTER_LIMIT = 1000;

interface RosterEntry {
  at: number;
  members: string[] | null;
}

/** One roster per (principal, group), so several groups do not evict each other. */
const rosterCache = new Map<string, RosterEntry>();

/**
 * Whether this Master may read Stalwart's account registry at all.
 *
 * One query asking for a single id, deliberately **not** cached: the answer is
 * an operator's grant, and a remembered "forbidden" would keep saying so after
 * the permission had been given — which is exactly the moment somebody is
 * looking at this line. Cheap enough to ask each time the administration is
 * read, and the refusal arrives as a *method-level* error inside an HTTP 200,
 * which is the shape every registry read here has to read.
 */
export async function rosterReadability(ctx: Ctx): Promise<RosterReadability> {
  const client = new JmapClient(ctx);
  const accountId = client.accountFor(STALWART_CAP);
  if (!accountId) return "unknown";
  try {
    await client.call("x:Account/query", { accountId, limit: 1 });
    return "ok";
  } catch (err) {
    return err instanceof JmapError && err.type === "forbidden"
      ? "forbidden"
      : "unreadable";
  }
}

/**
 * The addresses Stalwart lists as members of a group account, or null.
 *
 * Two registry calls, made as the Master — the one principal of an
 * installation with a reason to ask (ADR 0003). The registry exposes
 * membership in one direction only: an account carries `memberGroupIds` and a
 * group carries no member list at all (`x:Group/get` is `unknownMethod`, and a
 * group `Principal` carries nothing of the sort). So the roster is
 * `x:Account/query` filtered by `memberGroupIds`, then `x:Account/get` on the
 * ids that named. The filter is what keeps the answer proportional to the
 * group rather than to the installation, and `properties` keeps each record to
 * what a roster is.
 *
 * A refusal arrives as a *method-level* error inside an HTTP 200 — live on
 * 0.16.21, 2026-09-13: `{"type":"forbidden"}` from a credential without
 * `sysAccountGet`/`sysAccountQuery` — so the answers are read rather than
 * awaited, and every way this read can fail answers `null`: a member's chat
 * opens whatever the directory says.
 */
export async function groupMembers(
  ctx: Ctx,
  groupAccountId: string,
): Promise<string[] | null> {
  const key = `${ctx.username}\u0000${groupAccountId}`;
  const held = rosterCache.get(key);
  if (held && Date.now() - held.at < ROSTER_TTL_MS) return held.members;
  const members = await readGroupMembers(ctx, groupAccountId);
  rosterCache.set(key, { at: Date.now(), members });
  return members;
}

/** The read behind `groupMembers`, which is what caches it. */
async function readGroupMembers(
  ctx: Ctx,
  groupAccountId: string,
): Promise<string[] | null> {
  const client = new JmapClient(ctx);
  const accountId = client.accountFor(STALWART_CAP);
  if (!accountId) return null;
  try {
    const result = await client.chain(
      queryThenGet({
        query: "x:Account/query",
        get: "x:Account/get",
        accountId,
        filter: { memberGroupIds: groupAccountId },
        limit: ROSTER_LIMIT,
        properties: ["id", "@type", "emailAddress"],
      }),
    );
    const records = result.list<{ "@type"?: unknown; emailAddress?: unknown }>("g");
    const addresses = records
      // The group's own record has no `memberGroupIds` and is not a member of
      // itself; only a user account is a member anybody may mention.
      .filter((record) => record["@type"] === "User")
      .map((record) =>
        typeof record.emailAddress === "string"
          ? record.emailAddress.trim().toLowerCase()
          : "",
      )
      .filter(Boolean);
    return [...new Set(addresses)].sort();
  } catch {
    // A membership read nobody may make, or a directory that did not answer:
    // the surface falls back to the transcript either way (ADR 0005).
    return null;
  }
}

/**
 * A member's read of a group's members, behind the same grant as the rest of
 * the member door: a group's roster is a fact about that group, and nobody
 * outside it has a reason to ask.
 *
 * The roster itself is read **as the Master**, not as the member. A member
 * cannot read it: `x:Account` needs `sysAccountGet`, which the built-in user
 * role does not carry (live on 0.16.21, 2026-09-13). So the read is the
 * installation's own — the deployment's credential, the same one the fleet
 * signs in with — and a deployment whose Master has none has nothing to read
 * with, which is the `null` the surface falls back from.
 */
export async function memberGroupMembers(
  session: LiveSession,
  name: string,
): Promise<GroupMembersView | GroupAccessDenied> {
  const access = await memberGroupAccess(session, name, {
    need: "agent documents",
  });
  if (!access.ok) return access;
  const group = name.trim().toLowerCase();
  const address = agentAddress();
  if (!address) return { group, members: null };
  const agent = await openAgentSession(session, address);
  if (!agent.ok) return { group, members: null };
  return { group, members: await groupMembers(agent.ctx, access.accountId) };
}
