/**
 * The agent worker fleet's surfaces (ADR 0003): what the admin sees and
 * changes, and what a group member reads.
 *
 * The durable documents live in Stalwart — `agent/documents.ts` is their
 * schema and `agent/store.ts` is the one place they are addressed. This module
 * is the tier between those documents and the routes in `app.ts`: it resolves
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
 * membership (ADR 0006) and Stalwart refuses to mint a session for an
 * impersonated group mailbox.
 */

import {
  createAppPassword,
  getState,
  readGroupLabels,
  writeGroupLabels,
} from "./account.js";
import {
  AGENT_INSTRUCTION_MAX,
  AGENT_JOB_OPEN_STATES,
  AGENT_MODEL_TIERS,
  type AgentAuditEntry,
  type AgentConfigDoc,
  type AgentProvider,
  type AgentRule,
  type AgentTier,
  type AgentWorkerRecord,
  isAgentRule,
  leaseExpired,
  monthOf,
  ruleProblems,
} from "./agent/documents.js";
import { AgentStore } from "./agent/store.js";
// The shapes this API answers with have one definition, shared with the client
// that reads them (SSOT): `server/src/agent/views.ts`. Declaring them here as
// well is what let a field exist on one side and not the other.
import type {
  AgentGroupDocuments,
  AgentProvidersView,
  AgentStatus,
  AgentStatusWorker,
  GroupInstructionView,
  MemberAgentView,
  PendingApproval,
} from "./agent/views.js";
import { type Ctx, filesAccountId } from "./appFolder.js";
import { config } from "./config.js";
import { JmapError } from "./jmap.js";
import { impersonationAuthorization, type LiveSession } from "./sessions.js";
import {
  AGENT_LABELS,
  isLabelCatalog,
  isLabelCatalogEntry,
  type LabelCatalogEntry,
} from "./shared/labels.js";
import {
  fetchDirectoryGroups,
  fetchUpstreamSession,
  getUpstreamSession,
  UpstreamError,
  type UpstreamSession,
  upstreamFor,
} from "./upstream.js";

/** A refusal meant for the person using the surface, with a real status. */
export class AgentAdminError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
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

/** Why a group's documents are out of reach. */
export interface GroupAccessDenied {
  ok: false;
  error: string;
  message: string;
}

export type GroupAccessResult = GroupAccess | GroupAccessDenied;

/**
 * Resolve the group account a document lives on (ADR 0006) and the session to
 * reach it with.
 *
 * Membership is the grant: a member of the group already holds the group's
 * account in their own session, so its documents are read and written with the
 * administrator's own credentials — no impersonation. A non-member
 * administrator falls back to impersonation, which is what Stalwart 0.16
 * refuses for group mailboxes (live-verified 2026-09-09: the composite
 * `{group}%{admin}` answers 403), so the answer for them is an honest 403
 * naming membership as the requirement.
 *
 * `allowImpersonation: false` is for the surfaces a **member** reaches. There,
 * a name that is not in the session is not a group this person may act as at
 * all, and reaching for the administrator's mechanism would make Stalwart's
 * refusal the only thing standing between any signed-in user and another
 * group's documents. The membership answer is the same either way, and it is
 * reached without asking the server for anything.
 */
export async function resolveGroupAccess(
  session: LiveSession,
  name: string,
  opts: { allowImpersonation?: boolean } = {},
): Promise<GroupAccessResult> {
  const upstream = await getUpstreamSession(
    session.id,
    session.authorization,
    upstreamFor(session.username),
  );
  const want = name.trim().toLowerCase();
  for (const [accountId, account] of Object.entries(upstream.accounts ?? {})) {
    const a = account as { name?: unknown; isPersonal?: unknown };
    if (a.isPersonal !== false) continue;
    if (typeof a.name !== "string") continue;
    // A group is a non-personal account **with an address** — the same rule
    // `groupNamesInSession` applies. A calendar or a files share is non-personal
    // too, and reading a share as a group would put the fleet's documents in
    // somebody's shared calendar.
    if (a.name.indexOf("@") <= 0) continue;
    if (a.name.trim().toLowerCase() !== want) continue;
    return {
      ok: true,
      accountId,
      ctx: {
        authorization: session.authorization,
        session: upstream,
        username: session.username,
      },
    };
  }
  if (opts.allowImpersonation === false) return deniedGroupAccess();
  const imp = await impersonateAs(session, name);
  if (imp.ok) {
    const accountId = filesAccountId(imp.ctx);
    if (accountId) return { ok: true, ctx: imp.ctx, accountId };
  }
  return deniedGroupAccess();
}

/** Membership is the whole answer for a surface that may not impersonate. */
// ADR-0003 OWED: denial-per-section
function deniedGroupAccess(): GroupAccessDenied {
  return {
    ok: false,
    error: "group_not_accessible",
    message:
      "Managing a group's labels needs membership of that group: the catalog lives in the group's own files, and this mail server refuses to act as a group mailbox on an administrator's behalf.",
  };
}

/**
 * The group mailboxes a session holds: a non-personal account with an address.
 *
 * The same rule `hasChatGroupAccounts` applies server-side (see its note in
 * `upstream.ts`): a calendar or files share can be non-personal too, and
 * counting one costs a group row that answers "no access" rather than a
 * missing group.
 */
export function groupNamesInSession(
  session: Pick<UpstreamSession, "accounts">,
): string[] {
  const out: string[] = [];
  for (const account of Object.values(session.accounts ?? {})) {
    const a = account as { name?: unknown; isPersonal?: unknown };
    if (a.isPersonal !== false) continue;
    if (typeof a.name !== "string") continue;
    const name = a.name.trim().toLowerCase();
    if (name.indexOf("@") <= 0) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Every group mailbox this admin can list.
 *
 * The directory is the source when the server lets this session query it; when
 * the gate is closed, the groups the admin's own session holds are the honest
 * answer (enumeration is a capability, and the surface degrades to what it can
 * reach). A directory hiccup is not a failure of the fleet surface: it costs
 * the enumeration and nothing else.
 */
// ADR-0003 OWED: approvals-queue-short
export async function reachableGroupNames(admin: LiveSession): Promise<string[]> {
  const upstream = await getUpstreamSession(
    admin.id,
    admin.authorization,
    upstreamFor(admin.username),
  );
  try {
    const directory = await fetchDirectoryGroups(admin.authorization, upstream);
    if (!("denied" in directory)) {
      const names = directory.groups
        .map((g) => g.name.trim().toLowerCase())
        .filter(Boolean);
      if (names.length) return names;
    }
  } catch (err) {
    console.warn(
      "[gilbert] could not list the directory groups for the agent surface:",
      (err as Error).message,
    );
  }
  return groupNamesInSession(upstream);
}

/**
 * The agent's own session: the deployment's app password when there is one,
 * impersonation from the admin's session otherwise — the recorded alternative
 * for an installation that would rather never hold the secret in the web tier.
 *
 * A refused bootstrap password falls through to impersonation on purpose: the
 * environment and the server have to say the same thing after a rotation, and
 * an admin looking at the surface is exactly who can put them back in step.
 */
async function openAgentSession(
  admin: LiveSession,
  address: string,
): Promise<{ ok: true; ctx: Ctx } | { ok: false; message: string }> {
  const password = config.agent.password.trim();
  if (password) {
    const authorization = basic(address, password);
    try {
      const session = await fetchUpstreamSession(authorization, upstreamFor(address));
      return { ok: true, ctx: { authorization, session, username: address } };
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      if (err.status !== 401)
        return {
          ok: false,
          message: `The agent's session could not be opened: ${err.message}`,
        };
    }
  }
  const imp = await impersonateAs(admin, address);
  if (imp.ok) return { ok: true, ctx: imp.ctx };
  return {
    ok: false,
    message: `The agent's session could not be opened: ${imp.message}`,
  };
}

/** The groups an agent's own session shows it holds. */
function grantedGroupNames(session: UpstreamSession): Set<string> {
  const out = new Set<string>();
  for (const account of Object.values(session.accounts ?? {})) {
    const a = account as { name?: unknown; isPersonal?: unknown };
    if (a.isPersonal !== false) continue;
    if (typeof a.name !== "string") continue;
    const name = a.name.trim().toLowerCase();
    if (name) out.add(name);
  }
  return out;
}

/** The agent's store, or the honest reason there is nothing to read. */
async function agentStore(
  admin: LiveSession,
): Promise<{ store: AgentStore; address: string }> {
  const address = config.agent.address.trim();
  if (!address)
    throw new AgentAdminError(
      "agent_not_configured",
      "No agent is registered with this installation. Set GILBERT_AGENT_ADDRESS and its app password, then restart.",
      409,
    );
  const agent = await openAgentSession(admin, address);
  if (!agent.ok) throw new AgentAdminError("agent_unreachable", agent.message, 409);
  const accountId = filesAccountId(agent.ctx);
  if (!accountId)
    throw new AgentAdminError(
      "agent_unreachable",
      `The agent ${address} has no account holding its own Files.`,
      409,
    );
  return { store: new AgentStore(agent.ctx, accountId), address };
}

/* ------------------------------------------------------------------ */
/* The status surface                                                  */
/* ------------------------------------------------------------------ */

/**
 * What the installation's fleet looks like right now.
 *
 * `granted` is not guessed and is not writable: membership is decided in
 * Stalwart's own administration (ADR 0003), and the only witness to it is the
 * agent's own session — the group appears there as a non-personal account with
 * the group's name. Without that witness the groups are listed as not granted,
 * and the reason says why the check could not be made.
 */
export async function agentStatus(admin: LiveSession): Promise<AgentStatus> {
  const address = config.agent.address.trim();
  if (!address)
    return {
      configured: false,
      address: "",
      groups: [],
      workers: [],
      reason:
        "No agent is registered with this installation. Set GILBERT_AGENT_ADDRESS (and its app password) and restart to deploy one.",
    };

  const names = await reachableGroupNames(admin);
  const agent = await openAgentSession(admin, address);
  if (!agent.ok)
    return {
      configured: false,
      address,
      groups: names.map((name) => ({ name, granted: false })),
      workers: [],
      reason: agent.message,
    };

  const granted = grantedGroupNames(agent.ctx.session);
  let workers: AgentStatusWorker[] = [];
  let reason: string | undefined;
  try {
    workers = await readWorkers(agent.ctx);
  } catch (err) {
    // The agent's session is open; only its worker records failed. That is a
    // partial answer, and it says so rather than reporting a still fleet.
    console.warn(
      "[gilbert] could not read the agent's worker records:",
      (err as Error).message,
    );
    reason = `Could not read the agent's worker records: ${(err as Error).message}`;
  }
  return {
    configured: true,
    address,
    groups: names.map((name) => ({
      name,
      granted: granted.has(name.trim().toLowerCase()),
    })),
    workers,
    ...(reason ? { reason } : {}),
  };
}

/** The agent's worker heartbeats, with `alive` judged against the heartbeat. */
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
    areas: w.areas,
    heartbeatAt: w.heartbeatAt,
    version: w.version,
    alive: !leaseExpired(w.heartbeatAt, now, tolerance),
  }));
}

/* ------------------------------------------------------------------ */
/* A group's documents                                                 */
/* ------------------------------------------------------------------ */

/**
 * The documents of a group the admin cannot reach, in the shape every group
 * answer takes.
 *
 * A non-member administrator has no act-as-the-group path at all (ADR 0006),
 * so the surface answers empty rather than omitting the fields: a consumer
 * renders one shape, and the reason beside it says why there is nothing in it.
 */
export function emptyGroupDocuments(): Pick<
  AgentGroupDocuments,
  "rules" | "jobs" | "decisions" | "audit" | "schedule"
> {
  return { rules: [], jobs: [], decisions: [], audit: [], schedule: [] };
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
  const [rules, jobs, decisions, audit, schedule] = await Promise.all([
    store.readRules(),
    store.listJobs(),
    store.listDecisions(),
    readRecentAudit(store),
    store.readSchedule(),
  ]);
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
    audit,
    schedule: schedule?.doc ?? [],
    granted: true,
  };
}

/** The last entries of the current and the previous month's audit document. */
async function readRecentAudit(
  store: AgentStore,
  limit = VIEW_LIMIT,
): Promise<AgentAuditEntry[]> {
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const [last, current] = await Promise.all([
    store.readAudit(monthOf(previous)),
    store.readAudit(monthOf(now)),
  ]);
  // Entries are appended in order, so document order is chronological order.
  return [...(last?.entries ?? []), ...(current?.entries ?? [])].slice(-limit);
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
): Promise<AgentRule[]> {
  const checked = rules.map(checkedRule);
  const seen = new Set<string>();
  for (const rule of checked) {
    if (seen.has(rule.id))
      throw new AgentAdminError(
        "duplicate_rule",
        `Two automations share the id "${rule.id}". Ids must be unique: a job records the id and the version it was created from.`,
        400,
      );
    seen.add(rule.id);
  }

  const store = new AgentStore(access.ctx, accountId);
  for (let attempt = 0; ; attempt++) {
    const found = await store.readRules();
    const state = found?.state ?? (await store.state());
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
      return { ...rule, version, updatedAt: at, updatedBy: access.ctx.username };
    });
    try {
      await store.writeRules(next, { ifInState: state });
      return next;
    } catch (err) {
      const lost = err instanceof JmapError && err.type === "stateMismatch";
      // Someone else wrote the group's rules between the read and the write:
      // read again and re-apply this save on top of what landed, once.
      if (!lost || attempt > 0) throw err;
    }
  }
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
      "invalid_rule",
      `"${name}" cannot run: ${problems.join("; ")}.`,
      400,
    );
  }
  if (!isAgentRule(rule))
    throw new AgentAdminError(
      "invalid_rule",
      `Automation #${index + 1} is not a rule document Gilbert can run.`,
      400,
    );
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

/** The tiers that call a model — the one list, from the canonical schema. */
const TIERS = AGENT_MODEL_TIERS;

/**
 * The providers each tier runs on, with `hasKey` in place of the stored key.
 *
 * The key is write-only, the way an app password is: the surface can say
 * whether one is stored and can replace it, and can never read it back. An
 * installation with no agent answers with an empty address rather than an
 * error — there is nothing to show, and that is a state, not a failure.
 */
export async function readProviders(admin: LiveSession): Promise<AgentProvidersView> {
  if (!config.agent.address.trim()) return { address: "", providers: {} };
  const { store, address } = await agentStore(admin);
  const found = await store.readConfig();
  return {
    address: found?.doc.address || address,
    providers: providerViews(found?.doc.providers),
  };
}

function providerViews(
  providers: AgentConfigDoc["providers"] | undefined,
): AgentProvidersView["providers"] {
  const out: AgentProvidersView["providers"] = {};
  for (const tier of TIERS) {
    const p = providers?.[tier];
    if (!p) continue;
    out[tier] = {
      provider: p.provider,
      model: p.model,
      baseUrl: p.baseUrl,
      hasKey: p.apiKey.length > 0,
    };
  }
  return out;
}

/**
 * Write the tiers the editor sent.
 *
 * A tier present in the body replaces that tier; a tier sent empty is cleared;
 * a tier the body does not mention is left as it is. Inside a tier an absent or
 * empty `apiKey` keeps the stored one — that is the point of a write-only key,
 * since the surface cannot send back what it was never given. The config
 * document is the agent's own (`agent/config.json` in the agent account's app
 * folder) and is created on the first write, stamped with the address it was
 * registered under and who registered it.
 */
export async function writeProviders(admin: LiveSession, input: unknown): Promise<void> {
  const { store, address } = await agentStore(admin);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AgentAdminError(
      "bad_request",
      "providers must be an object naming the T1 and/or T2 tiers.",
      400,
    );
  const given = input as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!(TIERS as ReadonlyArray<string>).includes(key))
      throw new AgentAdminError(
        "bad_request",
        `"${key}" is not a tier: the tiers that call a model are T1 and T2.`,
        400,
      );
  }

  const found = await store.readConfig();
  const state = found?.state ?? (await store.state());
  const existing = found?.doc;
  const providers: AgentConfigDoc["providers"] = { ...(existing?.providers ?? {}) };
  for (const tier of TIERS) {
    if (!(tier in given)) continue;
    const entry = tierProvider(given[tier], tier, existing?.providers?.[tier]);
    if (entry) providers[tier] = entry;
    else delete providers[tier];
  }
  const doc: AgentConfigDoc = existing
    ? { ...existing, providers }
    : {
        v: 1,
        address,
        registeredAt: new Date().toISOString(),
        registeredBy: admin.username,
        providers,
      };
  await store.writeConfig(doc, { ifInState: state });
}

/** One tier as the editor sends it; null when the tier is being cleared. */
function tierProvider(
  raw: unknown,
  tier: AgentTier,
  previous: AgentProvider | undefined,
): AgentProvider | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new AgentAdminError(
      "bad_request",
      `${tier} must name a provider, a model and a base URL.`,
      400,
    );
  const entry = raw as Record<string, unknown>;
  const text = (key: string): string =>
    typeof entry[key] === "string" ? (entry[key] as string).trim() : "";
  const provider = text("provider");
  const model = text("model");
  const baseUrl = text("baseUrl");
  // A tier with nothing in it is a cleared tier, not an invalid one.
  if (!provider && !model && !baseUrl) return null;
  if (!provider || !model || !baseUrl)
    throw new AgentAdminError(
      "bad_request",
      `${tier} needs a provider, a model and a base URL.`,
      400,
    );
  assertUsableBaseUrl(baseUrl, tier);
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
      "bad_request",
      moved
        ? `${tier} moves to ${baseUrl}, so its api key has to be entered again: a key is issued for the endpoint it was entered against.`
        : `${tier} needs an api key.`,
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
function assertUsableBaseUrl(baseUrl: string, tier: AgentTier): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AgentAdminError(
      "bad_request",
      `${tier} has a base URL that is not a URL.`,
      400,
    );
  }
  if (url.protocol !== "https:")
    throw new AgentAdminError(
      "bad_request",
      `${tier} must use https: the api key travels in a header, and plain http would send it in the clear.`,
      400,
    );
  if (isPrivateHost(url.hostname))
    throw new AgentAdminError(
      "bad_request",
      `${tier} points at ${url.hostname}, which is inside the network: a worker must not be pointed at an address that is not a model provider.`,
      400,
    );
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
/* The agent's app password                                            */
/* ------------------------------------------------------------------ */

/**
 * Mint a new app password for the agent, under impersonation, and hand the
 * secret back exactly once.
 *
 * The existing credential is deliberately left alone: the worker holds it, and
 * ADR 0003's rotation completes at the deployment — the environment and the
 * server have to say the same thing. Revoking here would stop agent work the
 * moment the button is pressed, which is a different action from rotating the
 * secret underneath it.
 */
export async function rotateAgentAppPassword(
  admin: LiveSession,
): Promise<{ secret: string; alsoValid: number }> {
  const address = config.agent.address.trim();
  if (!address)
    throw new AgentAdminError(
      "agent_not_configured",
      "No agent is registered with this installation. Set GILBERT_AGENT_ADDRESS and its app password, then restart.",
      409,
    );
  const imp = await impersonateAs(admin, address);
  if (!imp.ok)
    throw new AgentAdminError(
      imp.status === 404 ? "agent_not_found" : "forbidden",
      imp.message,
      imp.status,
    );
  const created = await createAppPassword(imp.ctx, {
    description: `${config.appName} agent worker`,
  });
  // What this did, said out loud: the secret is new, and the ones already in use
  // are still valid. An operator who reads "rotate" as "revoke" and relies on
  // that would leave a leaked credential alive while believing they had closed
  // it, so the count travels with the answer and the surface says it.
  // ADR-0003 OWED: also-valid-unknown
  const state = await getState(imp.ctx).catch(() => null);
  return {
    secret: created.secret,
    alsoValid: Math.max(0, (state?.appPasswords.length ?? 1) - 1),
  };
}

/* ------------------------------------------------------------------ */
/* The group's standing instruction                                    */

/**
 * The group's standing instruction, as the admin surface sees it.
 *
 * Read and written by an administrator of the group — not by every member —
 * because a text handed to the model on every call is configuration, and
 * configuration is what the rules document already is. A member writes in the
 * group's files; this document is reached through the admin surface only.
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
      "instruction_too_long",
      `A standing instruction is at most ${AGENT_INSTRUCTION_MAX} characters; this one is ${trimmed.length}.`,
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
    throw new AgentAdminError(
      "catalog_unreadable",
      "This group's labels.json holds entries Gilbert cannot read. The agent's labels were not added, rather than overwriting them.",
      502,
    );
  await writeGroupLabels(access.ctx, accountId, labels);
  return { added: missing.map((l) => l.keyword) };
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

/**
 * Every decision waiting on a person, across the groups this admin can reach.
 *
 * The chat is where an approval is answered (resolution 10); this queue is the
 * oversight and the escape hatch, so it is read-only and it never invents a
 * group: a group the admin is not a member of simply has nothing to show here.
 */
export async function pendingApprovals(admin: LiveSession): Promise<PendingApproval[]> {
  const out: PendingApproval[] = [];
  for (const name of await reachableGroupNames(admin)) {
    const access = await resolveGroupAccess(admin, name);
    if (!access.ok) continue;
    const decisions = await new AgentStore(access.ctx, access.accountId).listDecisions();
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
  return out;
}

/* ------------------------------------------------------------------ */
/* What a member sees                                                  */
/* ------------------------------------------------------------------ */

/**
 * A group member's read-only view of the agent (ADR 0003, "Members see, never
 * change").
 *
 * Rules are cut down to what a member reads: what the automation is, where it
 * works, which tier it runs on, whether it is on, and what wakes it. Nothing on
 * this path can write, and no provider configuration is reachable from it at
 * all — the agent's own account belongs to the installation, not to a member.
 *
 * `granted` is what the group's own account proves, and deliberately not a
 * claim about the operator's grant list: a member's session cannot read another
 * principal's grants (impersonation is an administrator right, and Stalwart
 * never hands a group's membership out over JMAP). What the group's documents
 * do prove is that the agent has worked here — rules were authored for it, or
 * jobs and audit entries exist — which is the evidence this view reports.
 */
export async function memberAgentView(
  session: LiveSession,
  name: string,
): Promise<MemberAgentView | GroupAccessDenied> {
  const access = await resolveGroupAccess(session, name, { allowImpersonation: false });
  if (!access.ok) return access;
  const store = new AgentStore(access.ctx, access.accountId);
  const [rules, jobs, audit] = await Promise.all([
    store.readRules(),
    store.listJobs(),
    readRecentAudit(store),
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
    granted: rulesDoc.length > 0 || open.length > 0 || audit.length > 0,
    agentAddress: config.agent.address.trim(),
    rules: rulesDoc.map((r) => ({
      id: r.id,
      name: r.name,
      area: r.area,
      tier: r.tier,
      enabled: r.enabled,
      trigger: r.trigger,
    })),
    jobs: open,
    audit,
  };
}
