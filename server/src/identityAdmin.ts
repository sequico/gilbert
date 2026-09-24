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
  ensureAppFolder,
  findAppFileAt,
  readAppJsonAt,
  writeAppBytesAt,
  writeAppFile,
  writeAppFileIn,
} from "./appFolder.js";
import { agentAddress } from "./config.js";
import { isStateMismatch, JMAP_SUBMISSION, JmapClient } from "./jmap.js";
import type { LiveSession } from "./sessions.js";
import { sameAddress } from "./shared/address.js";
import {
  accountOwnIdentity,
  assignmentFor,
  GROUP_ASSIGNMENTS_FILE,
  isMemberKey,
  toAssignmentDoc,
} from "./shared/identityAssignment.js";
/*
 * The shapes these routes answer with, declared once for both tiers: a field
 * added on one side and forgotten on the other compiles on both and arrives as
 * `undefined` on one. See the module's own header.
 */
import type {
  GroupIdentityView,
  Identity,
  IdentityAddress,
  IdentityPatch,
  MemberAssignmentView,
  PersonIdentitiesView,
} from "./shared/identityViews.js";
import type { SetResponse } from "./shared/jmap.js";
import { isRecord } from "./shared/json.js";
import {
  parseSipCredentials,
  SIP_CREDENTIALS_FILE,
  type SipCredential,
  type SipCredentialsDocument,
  withSipCredential,
} from "./shared/phone.js";
/*
 * The client's settings document, and the one key of it this tier writes.
 * Both names are contracts — see the module's own header.
 */
import { DEFAULT_IDENTITY_KEY, SETTINGS_FILE } from "./shared/settingsDocument.js";
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
  if (!isRecord(doc)) return false;
  return doc.locked === true;
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

/** One member's assignment, or none: the reading a caller actually wants. */
async function readAssignments(
  ctx: Ctx,
  accountId: string,
): Promise<Record<string, string>> {
  const found = await readAppJsonAt(ctx, accountId, GROUP_ASSIGNMENTS_FILE);
  return toAssignmentDoc(found)?.members ?? {};
}

/**
 * Record the assignments, as one compare-and-set write: the caller names the
 * change, this reads and retries.
 *
 * The change is applied to the list **as it reads on this attempt**, so a retry
 * merges into what is there rather than over it: two administrators acting at
 * once is a lost race for one of them, not a silent overwrite of the other.
 *
 * The order of what it reads is the whole of it. The app folder is created
 * first: creating it moves the account's FileNode state, so a token read while
 * the folder was still missing would be refused for a reason that has nothing
 * to do with this document — and the first assignment a group ever gets would
 * never land. The state is then read **before** the list, as `agent/store.ts`
 * reads every document it owns: a state newer than the data lets a conditional
 * write land while the data it carries is already stale, which is the silent
 * overwrite this is here to prevent.
 */
async function writeAssignmentDoc(
  ctx: Ctx,
  accountId: string,
  change: (members: Record<string, string>) => Record<string, string>,
  by: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureAppFolder(ctx, accountId);
    const state = await appFolderState(ctx, accountId);
    const members = await readAssignments(ctx, accountId);
    try {
      await writeAppFile(
        ctx,
        accountId,
        GROUP_ASSIGNMENTS_FILE,
        {
          v: 1,
          members: change(members),
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
 * reading another account directly. Answers the one fact the client cannot work
 * out and nothing else: which of the group's identities the administration
 * assigned to the person asking. The group's **own** identity — what an
 * unassigned member sends as — is not a fact of this account, it is step 2 of
 * the sending cascade, a rule both tiers import
 * (`@gilbert/shared/identityAssignment`) and the client derives from the address
 * the session calls this account. Answering it from here would be a second
 * definition of it, and a read of the identity list this route does not
 * otherwise need. The shape itself is in `./shared/identityViews.js`.
 */

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
  const assignments = await readAssignments(access.ctx, access.accountId);
  const me = ownAddress(access.ctx);
  return {
    group,
    assignedId: assignmentFor(assignments, me),
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
/**
 * The account a principal's **own** identities live in.
 *
 * The personal account the session names for JMAP submission — the same rule
 * the client's settings follow, so the surface and the person are looking at
 * one list.
 */
export function ownIdentityAccount(ctx: Ctx): string {
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

/** What a method-level refusal says, when it says anything. */
export function refusalOf(
  entry: { type?: unknown; description?: unknown } | undefined,
): string {
  if (!entry) return "the mail server refused the change without saying why";
  const description = typeof entry.description === "string" ? entry.description : "";
  const type = typeof entry.type === "string" ? entry.type : "";
  return description || type || "the mail server refused the change without saying why";
}

function toIdentity(raw: unknown): Identity | null {
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
export async function readIdentities(ctx: Ctx, accountId: string): Promise<Identity[]> {
  try {
    const res = await new JmapClient(ctx).call<{ list?: unknown[] }>(
      "Identity/get",
      { accountId, ids: null },
      [JMAP_SUBMISSION],
    );
    return (res.list ?? [])
      .map(toIdentity)
      .filter((identity): identity is Identity => identity !== null);
  } catch (err) {
    throw asIdentityError(err, "could not be read");
  }
}

/** The patch, checked and narrowed to the fields this product may set. */
function checkedPatch(raw: unknown, creating: boolean): IdentityPatch {
  if (!isRecord(raw))
    throw new IdentityAdminError("invalid_identity", "The identity must be an object.");
  const r = raw;
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
  if (!isRecord(doc)) return null;
  const map = doc[DEFAULT_IDENTITY_KEY];
  if (!isRecord(map)) return null;
  const value = map[accountId];
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
  const doc = isRecord(raw) ? { ...raw } : {};
  const current = doc[DEFAULT_IDENTITY_KEY];
  const map = isRecord(current) ? { ...current } : {};
  if (identityId) map[accountId] = identityId;
  else delete map[accountId];
  doc[DEFAULT_IDENTITY_KEY] = map;
  await writeAppFile(ctx, accountId, SETTINGS_FILE, doc);
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
        sip: {},
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
    sip: parseSipCredentials(
      await readAppJsonAt(imp.ctx, accountId, SIP_CREDENTIALS_FILE),
    ),
  };
}

/**
 * Set or clear one identity's SIP account (ADR 0023), as the person.
 *
 * The account lives in `sip.json`, in that account's own app folder, keyed
 * by identity email — the same impersonating door the default identity and the
 * lock write through. `null`, or an address that is only blanks, clears the
 * entry; the phone then has nothing to register for that identity.
 */
export async function writePersonSipCredential(
  admin: LiveSession,
  address: string,
  email: string,
  credential: SipCredential | null,
): Promise<void> {
  const target = identityAddress(address);
  const key = email.trim().toLowerCase();
  if (!key)
    throw new IdentityAdminError(
      "invalid_identity",
      "A SIP account belongs to an identity, and this one names no email to key it by.",
      400,
    );
  if (credential && !(credential.server.trim() && credential.username.trim()))
    throw new IdentityAdminError(
      "invalid_identity",
      "A SIP account needs a server and a user name.",
      400,
    );
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
      `${target} holds no account this session can write a credential to.`,
      409,
    );
  /*
   * The key is a contract both tiers assume: the phone looks a credential up by
   * the identity's email, so a credential set for an address the account does
   * not send as is one nobody will ever register. Clearing is allowed for an
   * address the account no longer holds — that is how an orphan is removed.
   */
  if (credential) {
    const identities = await readIdentities(imp.ctx, accountId);
    if (!identities.some((identity) => identity.email.trim().toLowerCase() === key))
      throw new IdentityAdminError(
        "identity_not_found",
        `${target} holds no identity with the address ${email.trim()}.`,
        404,
      );
  }
  await writeSipDocument(imp.ctx, accountId, (current) =>
    withSipCredential(current, key, credential),
  );
}

/**
 * One compare-and-set write of the credential document.
 *
 * The app folder is created first, the FileNode state read next, then the
 * document, and the write carries `ifInState` — the order `writeAssignmentDoc`
 * uses, for the same reason: two administrators setting two identities at once
 * is a lost race for one of them rather than a silent overwrite of the other.
 * One retry, because the change is applied to what the retry reads.
 */
async function writeSipDocument(
  ctx: Ctx,
  accountId: string,
  change: (current: Record<string, SipCredential>) => SipCredentialsDocument,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const folderId = await ensureAppFolder(ctx, accountId);
    const state = await appFolderState(ctx, accountId);
    const current = parseSipCredentials(
      await readAppJsonAt(ctx, accountId, SIP_CREDENTIALS_FILE),
    );
    try {
      await writeAppFileIn(
        ctx,
        accountId,
        folderId,
        SIP_CREDENTIALS_FILE,
        change(current),
        {
          ifInState: state,
        },
      );
      return;
    } catch (err) {
      if (isStateMismatch(err) && attempt === 0) continue;
      throw err;
    }
  }
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
export async function agentSession(admin: LiveSession): Promise<Ctx> {
  const address = agentAddress();
  if (!address)
    throw new IdentityAdminError(
      "agent_not_configured",
      "This deployment names no agent, so a group's identity and the Global contacts directory cannot be written: set GILBERT_AGENT_ADDRESS and GILBERT_AGENT_PASSWORD in the environment that starts the server and the worker.",
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
  /*
   * The assignment and the cleanup are one write: an entry naming an identity
   * this account no longer holds is not an assignment — a surface can only read
   * it as none, so it is dropped here, where the list that proves it is already
   * in hand. Two writes would be two chances to lose the race against another
   * administrator for no gain.
   */
  await writeAssignmentDoc(
    ctx,
    accountId,
    (members) => {
      const next: Record<string, string> = {};
      for (const [address, identityId] of Object.entries(members)) {
        if (address === who) continue;
        if (existing.some((identity) => identity.id === identityId))
          next[address] = identityId;
      }
      if (who) next[who] = written;
      return next;
    },
    admin.username,
  );
  return { id: written };
}

/**
 * Remove one of a group's identities and every assignment to it, as the agent.
 *
 * This is a member's own sender going away: the identity they were assigned is
 * destroyed and the assignment dropped, so they fall back to the group's own
 * identity — what a member with no assignment sends as. The group's own
 * identity is refused by name: it is what everybody falls back to, so deleting
 * it would leave the group with nothing to send as.
 */
export async function removeGroupIdentity(
  admin: LiveSession,
  name: string,
  id: string,
): Promise<void> {
  const group = identityAddress(name, "group");
  const ctx = await agentSession(admin);
  const accountId = groupAccountId(ctx, group);
  if (!accountId)
    throw new IdentityAdminError(
      "group_not_granted",
      `The installation's agent is not a member of ${group}, so nothing here can write its identity. Grant the agent on that group and try again.`,
      409,
    );
  const identities = await readIdentities(ctx, accountId);
  if (!identities.some((identity) => identity.id === id))
    throw new IdentityAdminError(
      "identity_not_found",
      `${group} holds no identity with that id.`,
      404,
    );
  if (id === (accountOwnIdentity(identities, group)?.id ?? null))
    throw new IdentityAdminError(
      "identity_is_group",
      `${group}'s own identity is what a member with no identity of their own sends as, so it cannot be deleted. Unassign it instead.`,
      400,
    );
  await destroyIdentity(ctx, accountId, id);
  await writeAssignmentDoc(
    ctx,
    accountId,
    (members) => {
      const next: Record<string, string> = {};
      for (const [address, identityId] of Object.entries(members)) {
        if (identityId === id) continue;
        // As in `writeGroupIdentity`: an entry naming an identity this account
        // no longer holds is not an assignment and is dropped here.
        if (identities.some((identity) => identity.id === identityId))
          next[address] = identityId;
      }
      return next;
    },
    admin.username,
  );
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
