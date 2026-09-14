/**
 * The identities an administrator sets (ADR 0007).
 *
 * Two doors, both of them JMAP, and neither of them a second credential:
 *
 *  - **a person's identity** is written by **impersonating** them from the
 *    administrator's own session — the door app-password rotation already uses.
 *    The account's identities are a list, and the surface edits all of it.
 *  - **a group's identities** are written **as the installation's agent**,
 *    because Stalwart refuses to impersonate a group mailbox at all. Where the
 *    agent is not a member of the group, nothing writes them and the refusal
 *    names the grant that is missing.
 *
 * An identity belongs to the account it lives in and is written by it, so the
 * server only ever reaches an account it already holds: the impersonated
 * principal's own, or one the agent is granted on. Nothing here reads or writes
 * Stalwart's configuration.
 *
 * The **default** sending identity is not Stalwart's at all: it is one key of
 * the client's own settings document, and it is read and written there, in the
 * account's app folder, so the value an administrator sets is the value the
 * account's own Identities & signatures section shows and sends from.
 *
 * The lock (ADR 0007, ADR 0001) says which accounts have had their identity
 * taken over, and the product offers those accounts no edit at all. It is a
 * rule about this surface — an account that speaks JMAP directly can still
 * write its own identity — and it is recorded as a fact about that one
 * account, in that account's own app folder, not in an installation-wide
 * list: everything Gilbert owns lives in Stalwart, one account at a time.
 */

import { isAddress } from "./adminPolicy.js";
import type { GroupAccessDenied } from "./agent/views.js";
import {
  groupMembers,
  impersonateAs,
  memberGroupAccess,
  openAgentSession,
} from "./agentAdmin.js";
import {
  appFolderState,
  type Ctx,
  destroyAppNode,
  findAppFileAt,
  readAppJsonAt,
  writeAppBytesAt,
  writeAppFile,
} from "./appFolder.js";
import { agentAddress } from "./config.js";
import { JMAP_SUBMISSION, JmapClient } from "./jmap.js";
import type { LiveSession } from "./sessions.js";
import {
  accountOwnIdentity,
  assignmentFor,
  GROUP_ASSIGNMENTS_FILE,
  isMemberKey,
  toAssignmentDoc,
} from "./shared/identityAssignment.js";
import { SIGNATURE_LIMIT, utf8Length } from "./shared/signature.js";
import { UpstreamError } from "./upstream.js";

/** A refusal an administrator will read: a code, and the sentence to show. */
export class IdentityAdminError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "IdentityAdminError";
  }
}

/** One address on an identity's Reply-To or Bcc line. */
export interface IdentityAddress {
  name: string;
  email: string;
}

/**
 * The identity fields this product sets, and the whole of what it reads back.
 *
 * The same shape the client's own settings work with, so an identity means the
 * same thing wherever it is written.
 */
export interface AdminIdentity {
  id: string;
  name: string;
  email: string;
  replyTo: IdentityAddress[] | null;
  bcc: IdentityAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

/** What a caller may change. `id` and `mayDelete` are the server's answers. */
export interface IdentityPatch {
  name?: string;
  email?: string;
  replyTo?: IdentityAddress[] | null;
  bcc?: IdentityAddress[] | null;
  textSignature?: string;
  htmlSignature?: string;
}

/* ------------------------------------------------------------------ */
/* The lock (ADR 0001)                                                 */
/* ------------------------------------------------------------------ */

/**
 * The lock file, inside the locked account's own app folder.
 *
 * Deliberately a file of its own rather than a key of `settings.json`: the
 * client whole-file-replaces that document on every save (the same reason
 * `must-change-password.json`, `server/src/account.ts`, is its own file), so a
 * key the client's own schema does not own would not survive the account's
 * next settings save. Missing file = not locked.
 */
const IDENTITY_LOCK_FILE = "identity-lock.json";

/**
 * Whether an account's identity is locked, or that this server cannot say.
 *
 * `true` and `false` are reads: the account's own file records a lock, or it
 * does not. `"unknown"` is the third answer, for an account whose file no
 * session here can open at all -- the lock lives inside the locked account's
 * own app folder (ADR 0001), so a session that cannot impersonate that account
 * cannot read that folder either. Answering `false` there tells an
 * administrator that an account is free when it may be taken over, which is
 * the one thing this surface must not guess. The reason travels with the state,
 * as `IdentityLockUnknownReason`.
 */
export type IdentityLockState = true | false | "unknown";

/** Why a lock state comes back `"unknown"`: the read the account refused. */
export type IdentityLockUnknownReason = "impersonation_denied";

/**
 * Whether this account is locked (ADR 0007, ADR 0001): its own lock file.
 *
 * Two answers, because the caller already holds the account: `false` is the
 * file's own answer, its absence, or an account id that names nothing to read --
 * all of them states where no lock is recorded. A caller that does *not* hold
 * the account has no file to read and answers `"unknown"` itself rather than
 * asking here.
 */
export async function identityLocked(ctx: Ctx, accountId: string): Promise<boolean> {
  if (!accountId) return false;
  const doc = await readAppJsonAt(ctx, accountId, IDENTITY_LOCK_FILE);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  return (doc as Record<string, unknown>).locked === true;
}

/**
 * Whether the signed-in session's own account is locked.
 *
 * Reads that account's own file directly -- no impersonation needed, the way
 * a session never needs to impersonate itself to read its own settings.
 */
export async function identityLockedForSession(ctx: Ctx): Promise<boolean> {
  const accountId = ownIdentityAccount(ctx);
  return accountId ? identityLocked(ctx, accountId) : false;
}

/** Set or release the lock on one account's own file. */
async function setIdentityLock(
  ctx: Ctx,
  accountId: string,
  locked: boolean,
  setBy: string,
): Promise<void> {
  if (locked) {
    await writeAppFile(ctx, accountId, IDENTITY_LOCK_FILE, {
      locked: true,
      lockedAt: new Date().toISOString(),
      lockedBy: setBy,
    });
    return;
  }
  /*
   * No file is no lock, so releasing one that was never taken is a no-op rather
   * than an error: a surface that offers Release to every account needs no
   * separate check for whether there is anything there to release.
   */
  const { folderId, file } = await findAppFileAt(ctx, accountId, IDENTITY_LOCK_FILE);
  if (!folderId || !file?.id) return;
  await destroyAppNode(ctx, accountId, String(file.id));
}

/**
 * Set or release the lock on a person's identity, as the administrator —
 * the same impersonating door `setPersonDefaultIdentity` writes through.
 */
export async function setUserIdentityLock(
  admin: LiveSession,
  address: string,
  locked: boolean,
): Promise<void> {
  const target = identityAddress(address);
  const imp = await impersonateAs(admin, target);
  if (!imp.ok)
    throw new IdentityAdminError(
      imp.status === 403 ? "impersonation_denied" : "account_unreachable",
      imp.message,
      imp.status,
    );
  const accountId = ownIdentityAccount(imp.ctx);
  if (!accountId)
    throw new IdentityAdminError(
      "no_identity_account",
      `${target} holds no account this session can lock identities on.`,
      409,
    );
  await setIdentityLock(imp.ctx, accountId, locked, admin.username);
}

/* ------------------------------------------------------------------ */
/* The member-to-identity assignment (ADR 0007)                        */
/* ------------------------------------------------------------------ */

/**
 * Which identity each member of a group sends as, as that group's account
 * records it.
 *
 * Read as the session that already holds the account, and read as **none**
 * when the document is absent or is not this shape: a group nobody has
 * assigned anything in is a group with no assignments, which is a state and
 * not an error.
 */
export async function readAssignments(
  ctx: Ctx,
  accountId: string,
): Promise<Record<string, string>> {
  const doc = toAssignmentDoc(
    await readAppJsonAt(ctx, accountId, GROUP_ASSIGNMENTS_FILE),
  );
  return doc?.members ?? {};
}

/**
 * Record one member's assignment, or clear it with `null`.
 *
 * Written by the session that already holds the group, in the same action that
 * writes the identity it names, so the two cannot disagree. The write is
 * conditional on the account's FileNode state — the compare-and-set this repo
 * uses wherever two administrators may act at once — and a lost race is
 * retried once against the list it just re-read, because the write is the same
 * one either way: a later assignment of the same member replaces an earlier
 * one rather than joining it.
 */
export async function writeAssignment(
  ctx: Ctx,
  accountId: string,
  member: string,
  identityId: string | null,
  by: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await appFolderState(ctx, accountId);
    const members = await readAssignments(ctx, accountId);
    const next = { ...members };
    if (identityId) next[member.trim().toLowerCase()] = identityId;
    else delete next[member.trim().toLowerCase()];
    try {
      await writeAppFile(
        ctx,
        accountId,
        GROUP_ASSIGNMENTS_FILE,
        {
          v: 1,
          members: next,
          updatedAt: new Date().toISOString(),
          updatedBy: by,
        },
        state ? { ifInState: state } : {},
      );
      return;
    } catch (err) {
      if (attempt > 0 || !isStateMismatch(err)) throw err;
    }
  }
}

/**
 * One member's own assignment in a group, as the member's own session reads it.
 *
 * Read through the agent, because the document lives in the group's account and
 * a member reaches that account's Files through the group surfaces — never by
 * reading another account directly. Answers the two ids a composer needs and
 * nothing else: the one assigned to the person asking, and the group's own,
 * which is what they send as when nothing is assigned to them (ADR 0007).
 */
export interface MemberAssignmentView {
  group: string;
  /** The identity this member sends as, or null when nothing is assigned. */
  assignedId: string | null;
  /** The group's own identity: what an unassigned member sends as. */
  groupSenderId: string | null;
}

/**
 * The assignment as the member's own session reads it — the door every group
 * surface of a member goes through (`memberGroupAccess`), so somebody who is
 * not in the group is refused the same way everywhere rather than here alone.
 */
export async function memberGroupAssignment(
  session: LiveSession,
  name: string,
): Promise<MemberAssignmentView | GroupAccessDenied> {
  const access = await memberGroupAccess(session, name, { need: "agent documents" });
  if (!access.ok) return access;
  const group = identityAddress(name, "group");
  const identities = await readIdentities(access.ctx, access.accountId);
  const assignments = await readAssignments(access.ctx, access.accountId);
  const me = ownAddress(access.ctx);
  return {
    group,
    assignedId: assignmentFor(assignments, me),
    groupSenderId: accountOwnIdentity(identities, group)?.id ?? null,
  };
}

/**
 * The address of the principal whose session this is.
 *
 * The **account's own name**, not the login string: Stalwart accepts a bare
 * username and a composite `target%master` impersonation form, and neither is
 * an address. The account the session names for submission is the one whose
 * name is the person's own address (the same rule `ownIdentityAccount`
 * applies).
 */
function ownAddress(ctx: Ctx): string {
  const accountId = ownIdentityAccount(ctx);
  const name = (ctx.session.accounts?.[accountId] as { name?: unknown } | undefined)
    ?.name;
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

/** A lost compare-and-set, said the one way the retry above recognises it. */
function isStateMismatch(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /stateMismatch|state mismatch/i.test(text);
}

/* ------------------------------------------------------------------ */
/* Reaching the account that holds the identities                      */
/* ------------------------------------------------------------------ */

/** Malformed input is refused here, before anything is asked of a server. */
export function identityAddress(value: string, what = "account"): string {
  const address = value.trim().toLowerCase();
  if (!isAddress(address))
    throw new IdentityAdminError(
      "invalid_address",
      `That is not an ${what} address: ${value.trim() || "(empty)"}.`,
    );
  return address;
}

/**
 * The one way this file compares two addresses: trimmed and case-insensitive,
 * the normalisation `identityAddress` applies to every address it validates.
 */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The account a principal's **own** identities live in.
 *
 * The personal account the session names for JMAP submission — the same rule
 * the client's settings follow, so the surface and the person are looking at
 * one list.
 */
function ownIdentityAccount(ctx: Ctx): string {
  const primary = ctx.session.primaryAccounts?.[JMAP_SUBMISSION];
  if (primary) return primary;
  for (const [id, account] of Object.entries(ctx.session.accounts ?? {})) {
    if ((account as { isPersonal?: unknown }).isPersonal === true) return id;
  }
  return "";
}

/**
 * A group's own account in a session that holds it: non-personal and carrying
 * the group's address — the same rule `resolveGroupAccess` applies, so a files
 * share is never read as a group.
 */
function groupAccountId(ctx: Ctx, group: string): string {
  for (const [id, account] of Object.entries(ctx.session.accounts ?? {})) {
    const a = account as { name?: unknown; isPersonal?: unknown };
    if (a.isPersonal !== false) continue;
    if (typeof a.name !== "string") continue;
    if (!sameAddress(a.name, group)) continue;
    return id;
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Reading and writing one account's identities                        */
/* ------------------------------------------------------------------ */

interface SetResponse {
  created?: Record<string, { id?: unknown }>;
  notCreated?: Record<string, { type?: unknown; description?: unknown }>;
  notUpdated?: Record<string, { type?: unknown; description?: unknown }>;
}

/** What a method-level refusal says, when it says anything. */
function refusalOf(entry: { type?: unknown; description?: unknown } | undefined): string {
  if (!entry) return "the mail server refused the change without saying why";
  const description = typeof entry.description === "string" ? entry.description : "";
  const type = typeof entry.type === "string" ? entry.type : "";
  return description || type || "the mail server refused the change without saying why";
}

function toIdentity(raw: unknown): AdminIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : "",
    email: typeof r.email === "string" ? r.email : "",
    replyTo: Array.isArray(r.replyTo) ? (r.replyTo as IdentityAddress[]) : null,
    bcc: Array.isArray(r.bcc) ? (r.bcc as IdentityAddress[]) : null,
    textSignature: typeof r.textSignature === "string" ? r.textSignature : "",
    htmlSignature: typeof r.htmlSignature === "string" ? r.htmlSignature : "",
    mayDelete: r.mayDelete !== false,
  };
}

/** Every identity the account holds, in the server's own order. */
export async function readIdentities(
  ctx: Ctx,
  accountId: string,
): Promise<AdminIdentity[]> {
  try {
    const res = await new JmapClient(ctx).call<{ list?: unknown[] }>(
      "Identity/get",
      { accountId, ids: null },
      [JMAP_SUBMISSION],
    );
    return (res.list ?? [])
      .map(toIdentity)
      .filter((identity): identity is AdminIdentity => identity !== null);
  } catch (err) {
    throw asIdentityError(err, "could not be read");
  }
}

/** The patch, checked and narrowed to the fields this product may set. */
function checkedPatch(raw: unknown, creating: boolean): IdentityPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new IdentityAdminError("invalid_identity", "The identity must be an object.");
  const r = raw as Record<string, unknown>;
  const patch: IdentityPatch = {};
  const addresses = (value: unknown, field: string): IdentityAddress[] | null => {
    if (value == null) return null;
    if (!Array.isArray(value))
      throw new IdentityAdminError("invalid_identity", `"${field}" must be a list.`);
    return value.map((entry) => {
      if (!entry || typeof entry !== "object")
        throw new IdentityAdminError("invalid_identity", `"${field}" must be a list.`);
      const a = entry as Record<string, unknown>;
      const email = typeof a.email === "string" ? a.email.trim() : "";
      if (!isAddress(email))
        throw new IdentityAdminError(
          "invalid_identity",
          `"${field}" carries something that is not an address: ${email || "(empty)"}.`,
        );
      return { name: typeof a.name === "string" ? a.name : "", email };
    });
  };
  if (r.name !== undefined) {
    if (typeof r.name !== "string")
      throw new IdentityAdminError("invalid_identity", '"name" must be text.');
    patch.name = r.name;
  }
  if (r.email !== undefined) {
    if (typeof r.email !== "string")
      throw new IdentityAdminError("invalid_identity", '"email" must be text.');
    const email = r.email.trim();
    if (!isAddress(email))
      throw new IdentityAdminError(
        "invalid_identity",
        `That is not a sender address: ${email || "(empty)"}.`,
      );
    patch.email = email;
  }
  if (r.replyTo !== undefined) patch.replyTo = addresses(r.replyTo, "replyTo");
  if (r.bcc !== undefined) patch.bcc = addresses(r.bcc, "bcc");
  for (const field of ["textSignature", "htmlSignature"] as const) {
    const value = r[field];
    if (value === undefined) continue;
    if (typeof value !== "string")
      throw new IdentityAdminError("invalid_identity", `"${field}" must be text.`);
    // The server caps a signature in UTF-8 bytes; a refusal here names the
    // limit instead of handing back whatever Stalwart says about it.
    if (utf8Length(value) > SIGNATURE_LIMIT)
      throw new IdentityAdminError(
        "signature_too_long",
        `The signature is larger than the server's ${SIGNATURE_LIMIT}-byte limit.`,
      );
    patch[field] = value;
  }
  if (creating && !patch.email)
    throw new IdentityAdminError(
      "invalid_identity",
      "A new identity needs the address it sends from.",
    );
  return patch;
}

/**
 * Create or update one identity, and answer its id.
 *
 * `id` null creates. The defaults a new identity carries are the server's: an
 * identity with no signature is an identity, not an incomplete record.
 */
export async function writeIdentity(
  ctx: Ctx,
  accountId: string,
  id: string | null,
  raw: unknown,
): Promise<string> {
  const patch = checkedPatch(raw, id === null);
  const client = new JmapClient(ctx);
  try {
    if (id) {
      const res = await client.call<SetResponse>(
        "Identity/set",
        { accountId, update: { [id]: patch } },
        [JMAP_SUBMISSION],
      );
      const refused = res.notUpdated?.[id];
      if (refused)
        throw new IdentityAdminError("identity_not_written", refusalOf(refused), 400);
      return id;
    }
    const res = await client.call<SetResponse>(
      "Identity/set",
      {
        accountId,
        create: {
          n: {
            name: "",
            replyTo: null,
            bcc: null,
            textSignature: "",
            htmlSignature: "",
            ...patch,
          },
        },
      },
      [JMAP_SUBMISSION],
    );
    const refused = res.notCreated?.n;
    if (refused)
      throw new IdentityAdminError("identity_not_written", refusalOf(refused), 400);
    const created = res.created?.n?.id;
    if (typeof created !== "string")
      throw new IdentityAdminError(
        "identity_not_written",
        "The mail server accepted the identity but returned no id.",
        502,
      );
    return created;
  } catch (err) {
    throw asIdentityError(err, "could not be written");
  }
}

/** Remove one identity. */
export async function destroyIdentity(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<void> {
  try {
    const res = await new JmapClient(ctx).call<{
      destroyed?: unknown[];
      notDestroyed?: Record<string, { type?: unknown; description?: unknown }>;
    }>("Identity/set", { accountId, destroy: [id] }, [JMAP_SUBMISSION]);
    const refused = res.notDestroyed?.[id];
    if (refused)
      throw new IdentityAdminError("identity_not_removed", refusalOf(refused), 400);
  } catch (err) {
    throw asIdentityError(err, "could not be removed");
  }
}

/** A refusal from Stalwart, said in one sentence an administrator can act on. */
function asIdentityError(err: unknown, tail: string): IdentityAdminError {
  if (err instanceof IdentityAdminError) return err;
  if (err instanceof UpstreamError)
    return new IdentityAdminError(
      err.status === 403 ? "identity_forbidden" : "upstream_refused",
      `The identity ${tail}: ${err.message}`,
      err.status === 403 ? 403 : 502,
    );
  return new IdentityAdminError(
    "identity_failed",
    `The identity ${tail}: ${(err as Error).message}`,
    502,
  );
}

/* ------------------------------------------------------------------ */
/* The two surfaces                                                    */
/* ------------------------------------------------------------------ */

/** A person's identities, and whether the installation has taken them over. */
/** The document the client keeps its settings in, inside the app folder. */
const SETTINGS_FILE = "settings.json";

/** The settings key that names the identity an account sends from by default. */
const DEFAULT_IDENTITY_KEY = "defaultIdentityByAccount";

/**
 * The identity an account sends from by default, or null.
 *
 * Not a Stalwart property: it is one key of the client's settings document,
 * `settings.json` in that account's app folder, keyed by account id. Missing,
 * unreadable, malformed and absent-key all read as null, which is the same
 * state the client itself falls back from to its first identity — so the two
 * surfaces never disagree about what "no default" looks like.
 */
export async function readDefaultIdentity(
  ctx: Ctx,
  accountId: string,
): Promise<string | null> {
  const doc = await readAppJsonAt(ctx, accountId, SETTINGS_FILE);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const map = (doc as Record<string, unknown>)[DEFAULT_IDENTITY_KEY];
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const value = (map as Record<string, unknown>)[accountId];
  return typeof value === "string" && value ? value : null;
}

/**
 * Set the identity an account sends from by default, or clear it with null.
 *
 * Read-modify-write of the client's own document. The key belongs to that
 * client's schema, so a client save re-serialises it rather than dropping it;
 * what can lose it is only a client save landing between this read and this
 * write. `null` deletes the entry, which is the same state as never having
 * chosen, rather than leaving an entry that points at nothing.
 */
export async function writeDefaultIdentity(
  ctx: Ctx,
  accountId: string,
  identityId: string | null,
): Promise<void> {
  const raw = await readAppJsonAt(ctx, accountId, SETTINGS_FILE);
  const doc =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  const current = doc[DEFAULT_IDENTITY_KEY];
  const map =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  if (identityId) map[accountId] = identityId;
  else delete map[accountId];
  doc[DEFAULT_IDENTITY_KEY] = map;
  await writeAppFile(ctx, accountId, SETTINGS_FILE, doc);
}

/**
 * One group a person's own session holds, and what their account sends as
 * there (ADR 0007).
 */
export interface PersonGroupIdentities {
  /** The group's own address — what the server calls the account. */
  name: string;
  /** The identities this person's account sends as in that group. */
  identities: AdminIdentity[];
  /**
   * False when the person's own session could not read that account. An answer,
   * not a failure: the surface says which group it could not read rather than
   * showing it as one with no identities.
   */
  readable: boolean;
}

export interface PersonIdentitiesView {
  address: string;
  /**
   * Whether the installation has taken this account's identity over, and
   * `"unknown"` when the session could not read the account's own lock file.
   */
  locked: IdentityLockState;
  /**
   * What stopped that read. Null exactly when `locked` is `true` or `false`,
   * because nothing stopped it then; set when `locked` is `"unknown"`, so the
   * reason travels with the state that needs it and no consumer has to infer
   * it from the impersonation answer beside it.
   */
  lockUnknownReason: IdentityLockUnknownReason | null;
  impersonation: "ok" | "denied" | "unknown";
  identities: AdminIdentity[];
  /** The identity that account sends from by default, or null when it has not
   * chosen one and the client falls back to its first. */
  defaultIdentityId: string | null;
  /**
   * The groups this person belongs to, and what their own account may send as
   * in each (ADR 0007). Read as the person, so it is the same list their own
   * Identities & signatures section shows beneath their own.
   */
  groups: PersonGroupIdentities[];
}

/**
 * The groups a person's own session holds, each with the identities their
 * account sends as there.
 *
 * Read as the person, so the answer is the one their own Identities &
 * signatures section shows. The personal account is not one of them — the list
 * `PersonIdentitiesView.identities` already carries it — and neither is an
 * account holding nothing of its own: a group's account carries at least the
 * identity it sends as, addressed as the account itself, so an account whose
 * read answers nothing of its own is a share rather than a group and is left
 * out. A read that fails is `readable: false` with no identities rather than an
 * error for the whole surface: the account it could not read may well be a
 * group, and the flag is what lets the surface say so.
 */
async function personGroupIdentities(ctx: Ctx): Promise<PersonGroupIdentities[]> {
  const groups: PersonGroupIdentities[] = [];
  for (const [accountId, raw] of Object.entries(ctx.session.accounts ?? {})) {
    const account = raw as { name?: unknown; isPersonal?: unknown };
    if (account.isPersonal !== false) continue;
    const name = typeof account.name === "string" ? account.name : "";
    try {
      const identities = await readIdentities(ctx, accountId);
      // What the account answers about itself: a group sends as its own
      // address, so an identity carrying that address is the account's own.
      if (!identities.some((identity) => sameAddress(identity.email, name))) continue;
      groups.push({ name, identities, readable: true });
    } catch {
      groups.push({ name, identities: [], readable: false });
    }
  }
  return groups;
}

/**
 * Every identity a person holds, read by impersonating them.
 *
 * An app-password session cannot impersonate at all, and that is a state the
 * surface shows rather than an error it hides: it answers `denied` and an empty
 * list, so nothing looks like an account with no identities. The lock is
 * `"unknown"` on that answer for the same reason -- the file that records it is
 * inside the account this session cannot reach, so "not enforced" is not
 * something it may claim.
 */
export async function personIdentities(
  admin: LiveSession,
  address: string,
): Promise<PersonIdentitiesView> {
  const target = identityAddress(address);
  const imp = await impersonateAs(admin, target);
  if (!imp.ok) {
    if (imp.status === 403)
      return {
        address: target,
        // The lock lives in the target's own account (ADR 0001): a session
        // that cannot impersonate it cannot read that file either, so the
        // state is "unknown" rather than a verified "no" -- the same honesty
        // the empty identity list beside it already carries. Answering false
        // here would show an administrator "not enforced" for an account that
        // may well be taken over.
        locked: "unknown",
        lockUnknownReason: "impersonation_denied",
        impersonation: "denied",
        identities: [],
        defaultIdentityId: null,
        // No session, so no account to read a group through: the surface shows
        // the denied impersonation rather than a list it never asked for.
        groups: [],
      };
    throw new IdentityAdminError(
      imp.status === 404 ? "account_not_found" : "account_unreachable",
      imp.message,
      imp.status,
    );
  }
  const accountId = ownIdentityAccount(imp.ctx);
  if (!accountId)
    throw new IdentityAdminError(
      "no_identity_account",
      `${target} holds no account this session can read identities from.`,
      409,
    );
  return {
    address: target,
    locked: await identityLocked(imp.ctx, accountId),
    lockUnknownReason: null,
    impersonation: "ok",
    identities: await readIdentities(imp.ctx, accountId),
    defaultIdentityId: await readDefaultIdentity(imp.ctx, accountId),
    groups: await personGroupIdentities(imp.ctx),
  };
}

/**
 * Set the identity a person sends from by default, or clear it with null.
 *
 * The default is not a Stalwart identity property: it is one key of the
 * client's own settings document in that account's app folder, so this is
 * written as the person, into the document their own Identities & signatures
 * section reads. One stored value, not two that can disagree.
 */
export async function setPersonDefaultIdentity(
  admin: LiveSession,
  address: string,
  identityId: string | null,
): Promise<string | null> {
  const target = identityAddress(address);
  const imp = await impersonateAs(admin, target);
  if (!imp.ok)
    throw new IdentityAdminError(
      imp.status === 403 ? "impersonation_denied" : "account_unreachable",
      imp.message,
      imp.status,
    );
  const accountId = ownIdentityAccount(imp.ctx);
  if (!accountId)
    throw new IdentityAdminError(
      "no_identity_account",
      `${target} holds no account this session can read identities from.`,
      409,
    );
  await writeDefaultIdentity(imp.ctx, accountId, identityId);
  return identityId;
}

/** Write one of a person's identities, as them. */
export async function writePersonIdentity(
  admin: LiveSession,
  address: string,
  id: string | null,
  patch: unknown,
): Promise<{ id: string }> {
  const target = identityAddress(address);
  const imp = await impersonateAs(admin, target);
  if (!imp.ok)
    throw new IdentityAdminError(
      imp.status === 403 ? "impersonation_denied" : "account_unreachable",
      imp.message,
      imp.status,
    );
  const accountId = ownIdentityAccount(imp.ctx);
  if (!accountId)
    throw new IdentityAdminError(
      "no_identity_account",
      `${target} holds no account this session can write identities to.`,
      409,
    );
  return { id: await writeIdentity(imp.ctx, accountId, id, patch) };
}

/** Remove one of a person's identities, as them. */
export async function removePersonIdentity(
  admin: LiveSession,
  address: string,
  id: string,
): Promise<void> {
  const target = identityAddress(address);
  const imp = await impersonateAs(admin, target);
  if (!imp.ok)
    throw new IdentityAdminError(
      imp.status === 403 ? "impersonation_denied" : "account_unreachable",
      imp.message,
      imp.status,
    );
  const accountId = ownIdentityAccount(imp.ctx);
  if (!accountId)
    throw new IdentityAdminError(
      "no_identity_account",
      `${target} holds no account this session can write identities to.`,
      409,
    );
  await destroyIdentity(imp.ctx, accountId, id);
}

/**
 * The installation's agent, or the honest reason there is none.
 *
 * The same door the agent's own surfaces open: the credential the deployment
 * carries when there is one, impersonation from the administrator's session
 * otherwise. The refusal keeps its own code — a credential no server accepts
 * and an account that answers nothing are two different things to go and fix.
 */
async function agentSession(admin: LiveSession): Promise<Ctx> {
  const address = agentAddress();
  if (!address)
    throw new IdentityAdminError(
      "agent_not_configured",
      "This deployment names no agent, so a group's identity cannot be written: set GILBERT_AGENT_ADDRESS and GILBERT_AGENT_PASSWORD in the environment that starts the server and the worker.",
      409,
    );
  const agent = await openAgentSession(admin, address);
  if (!agent.ok)
    throw new IdentityAdminError(
      agent.code,
      `The installation's agent could not be used: ${agent.detail}`,
      409,
    );
  return agent.ctx;
}

/** A group's identities, its roster, and who sends as which of them. */
export interface GroupIdentityView {
  name: string;
  granted: boolean;
  /**
   * One identity per member (ADR 0007): the group's own address, each member's
   * own display name and signature.
   */
  identities: AdminIdentity[];
  /** The group's roster, or `null` when it could not be read at all. */
  members: string[] | null;
  /**
   * Which identity each member is assigned, by member address — the fact that
   * binds them, rather than a display name compared on both sides. A member
   * absent from it has been assigned nothing, which is a state: they send as
   * the group's own identity (`groupSenderId`) until one is assigned.
   */
  assignments: Record<string, string>;
  /** The group's own identity: what an unassigned member sends as. */
  groupSenderId: string | null;
}

/**
 * A group's identities and its roster, read as the agent.
 *
 * `granted: false` is a state, not a failure: the agent is not a member of that
 * group, so nothing here writes it, and the surface names the grant that is
 * missing rather than showing a permission error that would read as a bug. A
 * group the agent is not on holds nothing this session may read, so its list is
 * empty and its roster is `null`.
 *
 * The roster is the one `groupMembers` reads for the group's own surfaces, on
 * the same cache: a registry read nobody may make is `members: null`, which is
 * an answer rather than a failure of this surface — the identities are listed
 * beside it either way.
 */
export async function groupIdentity(
  admin: LiveSession,
  name: string,
): Promise<GroupIdentityView> {
  const group = identityAddress(name, "group");
  const ctx = await agentSession(admin);
  const accountId = groupAccountId(ctx, group);
  if (!accountId)
    return {
      name: group,
      granted: false,
      identities: [],
      members: null,
      assignments: {},
      groupSenderId: null,
    };
  const identities = await readIdentities(ctx, accountId);
  const assignments = await readAssignments(ctx, accountId);
  return {
    name: group,
    granted: true,
    identities,
    members: await groupMembers(ctx, accountId),
    assignments,
    groupSenderId: accountOwnIdentity(identities, group)?.id ?? null,
  };
}

/**
 * Write one of a group's identities **and assign it to a member**, as the agent.
 *
 * The member is an address — the one their account is known by in the group's
 * roster — and never a display name: the name is what a recipient reads in the
 * From line, and a binding kept in a name fails on any rename, any spelling and
 * any name nobody set (ADR 0007). The write records the assignment in
 * `identity-assignments.json`, in the same action, so the identity and the fact
 * that it is somebody's cannot disagree.
 *
 * `id` names the identity to write:
 *
 *  - an id this account holds: written, then assigned to the member — which is
 *    how the administration gives a member the group's own identity, or one
 *    that was somebody else's until now;
 *  - `null`: the identity already assigned to this member is written, so a save
 *    that lands twice changes one identity rather than making a second; when
 *    the member holds none, one is created and assigned.
 *
 * An id the group does not hold is refused by name rather than handed to the
 * server as somebody else's.
 */
export async function writeGroupIdentity(
  admin: LiveSession,
  name: string,
  member: string,
  id: string | null,
  patch: unknown,
): Promise<{ id: string }> {
  const group = identityAddress(name, "group");
  /*
   * No member at all is a write an administrator really makes: the group's own
   * identity, or one nobody has been assigned yet. It is the group's own iff its
   * address is the group's — which is what the identity says, not the caller —
   * so nothing is assigned and the identity stands on its own.
   */
  const who = member.trim().toLowerCase();
  if (who && !isMemberKey(who))
    throw new IdentityAdminError(
      "invalid_member",
      `That is not a member address: ${member.trim()}.`,
    );
  const ctx = await agentSession(admin);
  const accountId = groupAccountId(ctx, group);
  if (!accountId)
    throw new IdentityAdminError(
      "group_not_granted",
      `The installation's agent is not a member of ${group}, so nothing here can write its identity. Grant the agent on that group and save again.`,
      409,
    );
  const existing = await readIdentities(ctx, accountId);
  const assignments = await readAssignments(ctx, accountId);
  const assigned = assignmentFor(assignments, who);
  const held = (candidate: string | null) =>
    candidate && existing.some((identity) => identity.id === candidate)
      ? candidate
      : null;

  const target = id ?? held(assigned);
  if (id && !held(id))
    throw new IdentityAdminError(
      "identity_not_found",
      `${group} holds no identity with that id.`,
      404,
    );
  const written = await writeIdentity(ctx, accountId, target, patch);
  if (who) await writeAssignment(ctx, accountId, who, written, admin.username);
  /*
   * An entry whose identity this account no longer holds is not an assignment:
   * a surface can only read it as none, so it is dropped here, where the list
   * that proves it is already in hand.
   */
  for (const [address, identityId] of Object.entries(assignments)) {
    if (address === who) continue;
    if (existing.some((identity) => identity.id === identityId)) continue;
    await writeAssignment(ctx, accountId, address, null, admin.username);
  }
  return { id: written };
}

/**
 * Store the full HTML of an over-sized signature in the account's own Files.
 *
 * The account is the one whose identity it is — the person's or the group's —
 * because that is where the person's own client looks for it when it reads the
 * marker back. Nothing here invents a second place for a signature to live.
 */
export async function storeSignatureHtml(
  admin: LiveSession,
  kind: "user" | "group",
  target: string,
  html: string,
): Promise<string> {
  if (typeof html !== "string" || !html.trim())
    throw new IdentityAdminError("invalid_signature", "There is no signature to store.");
  const address = identityAddress(target, kind === "group" ? "group" : "account");
  let ctx: Ctx;
  let accountId: string;
  if (kind === "group") {
    ctx = await agentSession(admin);
    accountId = groupAccountId(ctx, address);
    if (!accountId)
      throw new IdentityAdminError(
        "group_not_granted",
        `The installation's agent is not a member of ${address}, so its Files cannot hold this signature.`,
        409,
      );
  } else {
    const imp = await impersonateAs(admin, address);
    if (!imp.ok)
      throw new IdentityAdminError(
        imp.status === 403 ? "impersonation_denied" : "account_unreachable",
        imp.message,
        imp.status,
      );
    ctx = imp.ctx;
    accountId = ownIdentityAccount(ctx);
    if (!accountId)
      throw new IdentityAdminError(
        "no_identity_account",
        `${address} holds no account this session can store a signature in.`,
        409,
      );
  }
  try {
    const name = `signature-${Date.now()}.html`;
    await writeAppBytesAt(
      ctx,
      accountId,
      name,
      new TextEncoder().encode(html),
      "text/html",
    );
    const stored = await findAppFileAt(ctx, accountId, name);
    const blobId = stored.file?.blobId;
    if (typeof blobId !== "string")
      throw new IdentityAdminError(
        "signature_not_stored",
        "The signature was written but the mail server returned no blob id for it.",
        502,
      );
    return blobId;
  } catch (err) {
    throw asIdentityError(err, "could not be stored in the account's Files");
  }
}
