/**
 * The installation's own access to a group's documents.
 *
 * A group's documents live in the group's own account, and every door here
 * opens onto a session that holds a grant on it: a member's own session
 * (`memberReach`, `memberGroupAccess`), or the installation's, signed in with
 * the deployment's own credential or impersonated from the signed-in
 * administrator's session (`resolveGroupAccess`, ADR 0007). `impersonateAs` is
 * the one door onto another account, and `groupAccountsDetailed` the one
 * classifier for which accounts are groups (ADR 0005). No fleet, automations
 * or agent registry live here.
 */

import type { Ctx } from "./appFolder.js";
import { config, masterAddress } from "./config.js";
import { JMAP_MAIL, JmapClient, STALWART_CAP } from "./jmap.js";
import { impersonationAuthorization, type LiveSession } from "./sessions.js";
import { processAccountForCapability } from "./shared/accountRouting.js";
import { errorMessage } from "./shared/errors.js";
import {
  type CredentialRefusalCode,
  GROUP_NOT_ACCESSIBLE,
  GROUP_UNREADABLE,
  type GroupDeniedCode,
  type GroupNeed,
} from "./shared/groupAccess.js";
import { queryThenGet } from "./shared/jmapQuery.js";
import { groupCandidates } from "./shared/sessionAccount.js";
import {
  fetchUpstreamSession,
  sessionUpstream,
  UpstreamError,
  upstreamFor,
} from "./upstream.js";
import { basicAuth } from "./util.js";

/**
 * A refusal from the group-access door, as the route answers it.
 *
 * What travels is the reason — a code and its parameters — and never a
 * sentence: the client composes it from the catalogue in force, so an
 * administrator reads the refusal in the language the surface is set to, and a
 * language whose catalogue does not carry it reads the English. `Error.message`
 * is the code, because a log line has room for a code and not for a paragraph.
 */
export class GroupAccessError extends Error {
  constructor(
    public readonly reason: GroupAccessReason,
    public readonly status = 400,
  ) {
    super(reason.code);
    this.name = "GroupAccessError";
  }
}

/**
 * Why the door onto a group's account did not open, as the route answers it.
 */
type GroupAccessReason =
  | { code: "agent_not_configured" }
  | { code: CredentialRefusalCode; detail: string };

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
 * yours", and inventing a distinction would be a guess. A refused composite
 * answers 403 (confirmed live on 0.16.23, 2026-09-24, for a group mailbox and
 * for an unknown address), which `fetchUpstreamSession` reads as a refusal.
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
interface GroupAccess {
  ok: true;
  ctx: Ctx;
  accountId: string;
}

type GroupAccessResult = GroupAccess | GroupAccessDenied;

/**
 * The installation's own session, and the groups it is granted on — the door a
 * group surface of the administration goes through.
 *
 * `openAgentSession` is how the account is reached — the deployment's own
 * credential when there is one, impersonation from the administrator's session
 * otherwise — so a deployment that names no account, or whose credential the
 * server refuses, says exactly that instead of borrowing the administrator's
 * reach.
 */
async function installationGroupReach(admin: LiveSession): Promise<{
  ctx: Ctx;
  accounts: Map<string, string>;
  /** The candidates the mail server would not answer about (ADR 0005). */
  unreadable: string[];
}> {
  const address = masterAddress();
  if (!address) throw new GroupAccessError({ code: "agent_not_configured" }, 409);
  const agent = await openAgentSession(admin, address);
  if (!agent.ok)
    throw new GroupAccessError({ code: agent.code, detail: agent.detail }, 409);
  const reach = await groupAccountsDetailed(agent.ctx);
  return {
    ctx: agent.ctx,
    accounts: reach.groups,
    unreadable: reach.unreadable,
  };
}

/**
 * A group's own documents, read and written **as the installation**.
 *
 * The grant that matters is the installation's, read from its own session. An
 * administrator who is a member of the group but whose installation is not
 * granted on it could otherwise author a rule that can never run, and one who
 * is not a member could author nothing at all in a group they administer; the
 * administrator's own membership is not a requirement of this door.
 *
 * A group the installation does not hold answers `deniedGroupAccess(need)` — a
 * state the surface names (the grant to add in the directory) rather than a
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
  const reach = await installationGroupReach(admin);
  const wanted = name.trim().toLowerCase();
  const accountId = reach.accounts.get(wanted);
  if (!accountId)
    return deniedGroupAccess(
      opts.need,
      reach.unreadable.includes(wanted) ? GROUP_UNREADABLE : GROUP_NOT_ACCESSIBLE,
    );
  return { ok: true, accountId, ctx: reach.ctx };
}

/** A member's own session and the groups it reaches, read live. */
interface MemberReach {
  ctx: Ctx;
  groups: Map<string, string>;
  /** The candidates the mail server would not answer about (ADR 0005). */
  unreadable: string[];
}

/**
 * The groups a member's own session reaches, as **one** live read.
 *
 * Forced live, not the ordinary cached read: this is a membership check
 * (ADR 0005 — "a member who leaves loses access", stated as immediate), and the
 * cache this session's other calls otherwise share can be up to five minutes
 * old. A cached answer would let a member removed from the group in Stalwart's
 * own directory keep reading its documents for up to that long after the grant
 * was withdrawn — a gap the installation path (`installationGroupReach`) never
 * had, since it always signs in fresh.
 *
 * It is one call for the whole group set, not one per group: a surface that
 * needs to know every group the reader is in asks this once and reads the map,
 * because asking per group repeats the same live session and probe pass for an
 * answer that cannot differ.
 */
export async function memberReach(session: LiveSession): Promise<MemberReach> {
  const upstream = await sessionUpstream(session, true);
  const ctx: Ctx = {
    authorization: session.authorization,
    session: upstream,
    username: session.username,
  };
  const { groups, unreadable } = await groupAccountsDetailed(ctx);
  return { ctx, groups, unreadable };
}

/**
 * A member's own reach: the group is in their session, or it is not.
 *
 * The member's surface never impersonates and never borrows the installation's
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
  const reach = await memberReach(session);
  const wanted = name.trim().toLowerCase();
  const accountId = reach.groups.get(wanted);
  if (!accountId)
    return deniedGroupAccess(
      opts.need,
      reach.unreadable.includes(wanted) ? GROUP_UNREADABLE : GROUP_NOT_ACCESSIBLE,
    );
  return { ok: true, accountId, ctx: reach.ctx };
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
 * The installation's own session: the deployment's credential when there is
 * one, impersonation from the admin's session otherwise — the recorded
 * alternative for an installation that would rather never hold the password in
 * the web tier.
 *
 * A credential Stalwart *refuses* is reported as that and nothing else, never
 * treated as an absent one: falling through to impersonation would answer a
 * surface that appears to work while the account it needs can never be
 * reached. "The key this deployment holds does not turn" is a fact about the
 * deployment, and an administrator who is shown something else instead of the
 * fact has no way to learn it. With no password at all there is nothing to
 * refuse, and impersonation is how an administrator reaches the account to
 * read what is there.
 */
export async function openAgentSession(
  admin: LiveSession,
  address: string,
): Promise<
  { ok: true; ctx: Ctx } | { ok: false; code: CredentialRefusalCode; detail: string }
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

/* ------------------------------------------------------------------ */
/* Which accounts are groups                                           */
/* ------------------------------------------------------------------ */

interface MailboxRecord {
  id?: unknown;
  name?: unknown;
  role?: unknown;
}

/**
 * An account's mailboxes, as the group classifier reads them.
 *
 * The one `Mailbox/get` projection the probe asks, so a property added for one
 * reader is seen by the other.
 */
async function mailboxesOf(
  client: JmapClient,
  accountId: string,
): Promise<MailboxRecord[]> {
  const res = await client.call<{ list?: MailboxRecord[] }>(
    "Mailbox/get",
    { accountId, ids: null, properties: ["id", "name", "role"] },
    [JMAP_MAIL],
  );
  return res.list ?? [];
}

/**
 * Whether an account answers as a mail store — the one group classifier.
 *
 * Stalwart advertises the same capabilities on every account a session lists,
 * so a folder, calendar or address-book share that carries an address looks
 * exactly like a group mailbox from the session alone. What tells the two apart
 * is the mail store: an account that answers `Mailbox/get` with a folder tree
 * is a mailbox, and one that shares only files, calendars or books answers with
 * none and is not a group. An account this cannot read is not served as one —
 * "I could not prove it is a mailbox" is not "it is a mailbox".
 */
type MailStoreProbe = "mailbox" | "share" | "unreadable";

/**
 * The accounts the mail store could not be asked about, and the line that is
 * written for them once.
 *
 * The groups are resolved on **every** pass (`agent/supervisor.ts`), so the probe
 * asks the same question every ten seconds: an account nobody can read is a
 * state of the installation rather than an event, and a sentence repeated six
 * times a minute is a sentence nobody reads. The line is therefore written when
 * that state begins, and the account is forgotten the moment it answers again —
 * so what a restart costs is one line, and what a genuine change costs is one
 * more. Process state, like the roster cache below: whether the account is
 * readable is asked of the server every time, never remembered as a fact.
 */
const unreadableAccounts = new Set<string>();

/**
 * What the mail store says about an account: it has one, it has none, or nobody
 * could ask.
 *
 * Three answers rather than two, because the third is not a fact about the
 * account: "this is not a group" and "I could not reach the server" are
 * different sentences, and a surface that showed the first for the second would
 * be telling a person to fix a grant that was never the problem (ADR 0005).
 * Writes stay closed on the third answer — nothing is written into an account
 * nobody could prove is a mailbox — while a read names it.
 */
async function probeMailStore(
  client: JmapClient,
  accountId: string,
): Promise<MailStoreProbe> {
  try {
    const boxes = await mailboxesOf(client, accountId);
    // The account answers again: whatever was said about it is over, and a later
    // failure of its own is a new state that is owed a line.
    unreadableAccounts.delete(accountId);
    return boxes.length > 0 ? "mailbox" : "share";
  } catch (err) {
    // The reason is said out loud rather than swallowed, so an operator is not
    // left reading a broken probe as a group that is not granted (ADR 0005) —
    // once, while the answer is this one.
    if (!unreadableAccounts.has(accountId)) {
      unreadableAccounts.add(accountId);
      console.warn(
        `[gilbert] could not probe the account ${accountId} for a mail store:`,
        errorMessage(err),
      );
    }
    return "unreadable";
  }
}

/**
 * The groups of a session: the session's candidates, then the mail store's
 * probe — the one classifier this product has for what a group is.
 *
 * One rule, one owner: every surface that needs to know which accounts are
 * groups (the administration's doors, the member's read) reads it here. The
 * candidates are the non-personal accounts that carry an address; the probe is
 * `probeMailStore`, because a folder share with an address looks exactly like a
 * group mailbox from the session alone and only the mail store tells them
 * apart. Nothing is cached: a grant withdrawn in Stalwart is read here the next
 * time a surface asks.
 */
interface GroupReach {
  /** The groups, by name, with the account each one answers as. */
  groups: Map<string, string>;
  /**
   * The candidates the mail server did not answer about: not groups this
   * reader can prove, and not proven shares either.
   */
  unreadable: string[];
}
export async function groupAccountsDetailed(ctx: Ctx): Promise<GroupReach> {
  const candidates = groupCandidates(ctx.session.accounts);
  const client = new JmapClient(ctx);
  const probed = await Promise.all(
    candidates.map(async ([accountId, name]) => {
      const probe = await probeMailStore(client, accountId);
      return { accountId, name, probe };
    }),
  );
  // The map is read by group name — `Map<name, accountId>` — so the pairs are
  // turned around here, once, where the probe's own order is still visible. A
  // candidate nobody could ask about is named rather than dropped: the caller
  // that writes ignores it, and the caller that shows a person says so.
  const groups = new Map<string, string>();
  const unreadable: string[] = [];
  for (const row of probed) {
    if (row.probe === "mailbox") groups.set(row.name, row.accountId);
    else if (row.probe === "unreadable") unreadable.push(row.name);
  }
  return { groups, unreadable };
}

/* ------------------------------------------------------------------ */
/* A group's roster                                                    */
/* ------------------------------------------------------------------ */

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
 * The addresses Stalwart lists as members of a group account, or null.
 *
 * Two registry calls, made as the installation — the one principal of an
 * installation with a reason to ask. The registry exposes membership in one
 * direction only: an account carries `memberGroupIds` and a group carries no
 * member list at all (`x:Group/get` is `unknownMethod`, and a group `Principal`
 * carries nothing of the sort). So the roster is `x:Account/query` filtered by
 * `memberGroupIds`, then `x:Account/get` on the ids that named. The filter is
 * what keeps the answer proportional to the group rather than to the
 * installation, and `properties` keeps each record to what a roster is.
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
  const accountId = processAccountForCapability(client.upstream, STALWART_CAP);
  if (!accountId) return null;
  try {
    const result = await client.chain(
      queryThenGet({
        query: "x:Account/query",
        get: "x:Account/get",
        accountId,
        filter: { memberGroupIds: groupAccountId },
        limit: ROSTER_LIMIT,
        maxObjectsInGet: client.maxObjectsInGet,
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

/* ------------------------------------------------------------------ */
/* Why a group's documents are out of reach                            */
/* ------------------------------------------------------------------ */

/**
 * Why a group's documents are out of reach: the code, and the parameter that
 * names the section.
 *
 * The installation's grant is the whole answer — a group's documents live in
 * the group's own account, and the installation is the principal that holds it
 * — so a group it is not granted on has no path to them at all, and a group the
 * mail server would not answer about has none either. The sentence that says so
 * is composed where it is shown, from the catalogue in force: a language whose
 * catalogue lacks it reads the English source.
 */
export interface GroupAccessDenied {
  ok: false;
  error: GroupDeniedCode;
  need: GroupNeed;
}
