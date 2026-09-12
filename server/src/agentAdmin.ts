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
import { fetchEmailView, groupAccounts, mailboxIdByRole } from "./agent/actions.js";
import { hasSpoken, readChat } from "./agent/chat.js";
import {
  AGENT_INSTRUCTION_MAX,
  AGENT_JOB_OPEN_STATES,
  AGENT_NOTEBOOK_FACT_MAX,
  AGENT_NOTEBOOK_FACTS_MAX,
  type AgentAuditEntry,
  type AgentConfigDoc,
  type AgentJob,
  type AgentNotebookFact,
  type AgentProvider,
  type AgentRule,
  type AgentWorkerRecord,
  EMPTY_METER,
  filterNeedsBody,
  filterProblems,
  isAgentRule,
  isModelMaxOutput,
  leaseExpired,
  MODEL_MAX_OUTPUT_CEILING,
  MODEL_MAX_OUTPUT_DEFAULT,
  matchEmailFilter,
  meterOver,
  metersByAgent,
  monthOf,
  monthsSince,
  newJob,
  ruleProblems,
} from "./agent/documents.js";
import { AUDIT_RETENTION_MS } from "./agent/executor.js";
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
  AgentProvidersView,
  AgentStatus,
  AgentStatusGroup,
  AgentStatusMeter,
  AgentStatusReason,
  AgentStatusWorker,
  AgentWithdrawal,
  GroupAccessDenied,
  GroupInstructionView,
  GroupNeed,
  GroupNotebookView,
  MemberAgentView,
  PendingApproval,
} from "./agent/views.js";
import {
  type AgentProviderView,
  GROUP_NOT_ACCESSIBLE,
  WITHDRAWALS_PATH,
} from "./agent/views.js";
import { type Ctx, filesAccountId, readAppJsonAt } from "./appFolder.js";
import { agentAddress, config } from "./config.js";
import { isStateMismatch, JMAP_MAIL, JmapClient } from "./jmap.js";
import { impersonationAuthorization, type LiveSession } from "./sessions.js";
import {
  AGENT_LABELS,
  isLabelCatalog,
  isLabelCatalogEntry,
  type LabelCatalogEntry,
} from "./shared/labels.js";
import {
  fetchUpstreamSession,
  getUpstreamSession,
  UpstreamError,
  upstreamFor,
} from "./upstream.js";

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

/** The Basic header for a principal's own credential. */
function basic(address: string, password: string): string {
  return `Basic ${Buffer.from(`${address}:${password}`, "utf8").toString("base64")}`;
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
export async function agentGroupReach(
  admin: LiveSession,
): Promise<{ ctx: Ctx; accounts: Map<string, string> }> {
  const address = agentAddress();
  if (!address) throw new AgentAdminError({ code: "agent_not_configured" }, 409);
  const agent = await openAgentSession(admin, address);
  if (!agent.ok)
    throw new AgentAdminError({ code: agent.code, detail: agent.detail }, 409);
  return { ctx: agent.ctx, accounts: await groupAccounts(agent.ctx) };
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
  const accountId = reach.accounts.get(name.trim().toLowerCase());
  if (!accountId) return deniedGroupAccess(opts.need);
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
  const upstream = await getUpstreamSession(
    session.id,
    session.authorization,
    upstreamFor(session.username),
  );
  const ctx: Ctx = {
    authorization: session.authorization,
    session: upstream,
    username: session.username,
  };
  const accountId = (await groupAccounts(ctx)).get(name.trim().toLowerCase());
  if (!accountId) return deniedGroupAccess(opts.need);
  return { ok: true, accountId, ctx };
}

/** The agent holds no such group: a state the surface names, not a failure. */
function deniedGroupAccess(need: GroupNeed): GroupAccessDenied {
  return { ok: false, error: GROUP_NOT_ACCESSIBLE, need };
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
    const authorization = basic(address, password);
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
 * showed it holds the group (ADR 0003 §2), so every row is granted by
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
      reason: { code: agent.code, detail: agent.detail },
    };

  const reach = await groupAccounts(agent.ctx);
  const groups = [...reach.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => groupRow(name));
  const meter = await fleetMeter(agent.ctx, reach);
  let workers: AgentStatusWorker[] = [];
  let reason: AgentStatusReason | undefined;
  try {
    workers = await readWorkers(agent.ctx);
  } catch (err) {
    // The agent's session is open; only its worker records failed. That is a
    // partial answer, and it says so rather than reporting a still fleet.
    console.warn(
      "[gilbert] could not read the agent's worker records:",
      (err as Error).message,
    );
    reason = { code: "workers_unreadable", detail: (err as Error).message };
  }
  return {
    operational: true,
    address,
    groups,
    meter,
    workers,
    withdrawals: await readWithdrawals(agent.ctx),
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

/** The agent's worker heartbeats, with `alive` judged against the heartbeat. */
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

async function readWorkers(ctx: Ctx): Promise<AgentStatusWorker[]> {
  const accountId = filesAccountId(ctx);
  if (!accountId) return [];
  const records: AgentWorkerRecord[] = await new AgentStore(ctx, accountId).listWorkers();
  const now = Date.now();
  // The ADR's tolerance: three missed heartbeats is a worker that is gone.
  const tolerance = config.agent.heartbeatMs * 3;
  return records.map((w) => ({
    id: w.id,
    address: w.address,
    heartbeatAt: w.heartbeatAt,
    version: w.version,
    alive: !leaseExpired(w.heartbeatAt, now, tolerance),
    // A record written before the field existed names no group, and a worker
    // holding nothing names none either: both read as "serves nothing here".
    groups: w.serves ?? [],
  }));
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
 * what "recent" means (ADR 0010).
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
 * something nobody approved (`executor.ts`, ADR 0003 §4). The write is
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
 * What is deliberately *not* written is a refusal into the group's trail. A
 * message the filter does not match, an automation that is not armed, one asked
 * for that is not about mail: each is answered to the person who asked, who can
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
  if (!rule.enabled)
    throw new AgentAdminError(
      { code: "manual_run_refused", why: "rule_not_armed", rule: rule.name },
      409,
    );
  if (rule.trigger.on !== "email")
    throw new AgentAdminError(
      { code: "manual_run_refused", why: "rule_not_email", rule: rule.name },
      409,
    );

  const client = new JmapClient(access.ctx);
  const named = typeof ask.emailId === "string" ? ask.emailId.trim() : "";
  const emailId = named || (await newestInboxMessage(client, accountId));
  const view = emailId
    ? await fetchEmailView(client, accountId, emailId, {
        body: filterNeedsBody(rule.trigger.filter),
      })
    : null;
  if (!view)
    throw new AgentAdminError(
      { code: "manual_run_refused", why: "no_message", rule: rule.name },
      409,
    );

  // A filter this executor cannot evaluate is a fault of the rule rather than
  // of the message, and it is refused in the words the form refuses it in.
  const wired = filterProblems(rule.trigger.filter, "the filter");
  if (wired.length)
    throw new AgentAdminError(
      { code: "rule_cannot_run", name: rule.name, problems: wired.join("; ") },
      409,
    );
  if (!matchEmailFilter(rule.trigger.filter, view))
    throw new AgentAdminError(
      { code: "manual_run_refused", why: "message_not_matched", rule: rule.name },
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
    const name =
      rule &&
      typeof rule === "object" &&
      typeof (rule as { name?: unknown }).name === "string"
        ? String((rule as { name: string }).name)
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
    return { address: "", provider: null, maxOutputTokens: MODEL_MAX_OUTPUT_DEFAULT };
  const { store, address } = await agentStore(admin);
  const found = await store.readConfig();
  return {
    address: found?.doc.address || address,
    provider: providerView(found?.doc.provider),
    maxOutputTokens: found?.doc.maxOutputTokens ?? MODEL_MAX_OUTPUT_DEFAULT,
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
 * whole FileNode state (ADR 0003 §6) and this is the account the worker writes
 * its heartbeat and its audit in: the agent's own bookkeeping invalidates a
 * save that overlaps it, for no reason to do with this document.
 */
export async function writeProviders(admin: LiveSession, input: unknown): Promise<void> {
  const { store, address } = await agentStore(admin);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AgentAdminError({ code: "provider_not_an_object" }, 400);
  const given = input as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (key !== "provider" && key !== "maxOutputTokens")
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

  for (let attempt = 0; ; attempt++) {
    const found = await store.readConfig();
    const existing = found?.doc;
    // A key the write does not mention is left as it is: a write that states
    // the ceiling alone must not clear the model, and one that replaces the
    // model must not clear the ceiling (ADR 0010).
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

/** The installation's model as the editor sends it; null when it is cleared. */
function providerEntry(
  raw: unknown,
  previous: AgentProvider | undefined,
): AgentProvider | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new AgentAdminError({ code: "provider_incomplete" }, 400);
  const entry = raw as Record<string, unknown>;
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
/* The group's standing instruction                                    */

/**
 * The group's standing instruction, as the admin surface sees it.
 *
 * Written by an administrator of the group — not by every member — because a
 * text handed to the model on every call is configuration, and configuration is
 * what the rules document already is. Read by every member of the group, on the
 * member's own route: what the agent is told is exactly what a member has to be
 * able to judge (ADR 0003 resolution 17), so the read is shared and the pen is
 * not.
 */
export async function readGroupInstruction(
  access: GroupAccess,
): Promise<GroupInstructionView> {
  const store = new AgentStore(access.ctx, access.accountId);
  const found = await store.readInstruction();
  return {
    text: found?.doc.text ?? "",
    updatedAt: found?.doc.updatedAt ?? null,
    updatedBy: found?.doc.updatedBy ?? null,
    max: AGENT_INSTRUCTION_MAX,
  };
}

/**
 * Replace the group's standing instruction. An empty text removes it.
 *
 * The length bound is the document's own (`isAgentInstructionDoc`), applied
 * here so a person gets a sentence rather than a document that silently fails
 * to read back.
 */
export async function saveGroupInstruction(
  access: GroupAccess,
  text: string,
  by: string,
): Promise<GroupInstructionView> {
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
  const found = await store.readInstruction();
  if (!trimmed) {
    if (found) await store.removeInstruction();
    return { text: "", updatedAt: null, updatedBy: null, max: AGENT_INSTRUCTION_MAX };
  }
  const doc = await store.writeInstruction(
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
/* The group's notebook                                                */
/* ------------------------------------------------------------------ */

/**
 * The group's notebook, as an administrator reads it.
 *
 * Memory is a document in the group's own account (ADR 0010): the facts its
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
  if (!input || typeof input !== "object" || Array.isArray(input))
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
  const existing = (await readGroupLabels(access.ctx, accountId)) ?? [];
  const have = new Set(
    existing.filter(isLabelCatalogEntry).map((l: LabelCatalogEntry) => l.keyword),
  );
  const missing = AGENT_LABELS.filter((l) => !have.has(l.keyword));
  if (!missing.length) return { added: [] };
  const labels: unknown[] = [...existing, ...missing];
  if (!isLabelCatalog({ labels }))
    throw new AgentAdminError({ code: "group_labels_unreadable" }, 502);
  await writeGroupLabels(access.ctx, accountId, labels);
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
  const [rules, jobs, audit, instruction, chat] = await Promise.all([
    store.readRules(),
    store.listJobs(),
    readRecentAudit(store),
    // The same document the admin surface writes, read here with the member's
    // own session: the member's own grant is what reaches a group's files (ADR
    // 0005), and this route never impersonates and never borrows the agent's
    // credential.
    readGroupInstruction(access),
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
      name: r.name,
      enabled: r.enabled,
      trigger: r.trigger,
      review: r.review,
      instruction: r.instruction,
    })),
    instruction,
    jobs: open,
    audit,
  };
}
