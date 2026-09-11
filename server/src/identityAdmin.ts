/**
 * The identities an administrator sets (ADR 0010).
 *
 * Two doors, both of them JMAP, and neither of them a second credential:
 *
 *  - **a person's identity** is written by **impersonating** them from the
 *    administrator's own session — the door app-password rotation already uses.
 *    The account's identities are a list, and the surface edits all of it.
 *  - **a group's identity** is written **as the installation's agent**, because
 *    Stalwart refuses to impersonate a group mailbox at all. Where the agent is
 *    not a member of the group, nothing writes it and the refusal names the
 *    grant that is missing.
 *
 * An identity belongs to the account it lives in and is written by it, so the
 * server only ever reaches an account it already holds: the impersonated
 * principal's own, or one the agent is granted on. Nothing here reads or writes
 * Stalwart's configuration.
 *
 * The lock (ADR 0010 §4) is the installation's record, not Stalwart's: it says
 * which accounts have had their identity taken over, and the product offers
 * those accounts no edit at all. It is a rule about this surface — an account
 * that speaks JMAP directly can still write its own identity — and it is
 * recorded as one.
 */

import { isAddress, type PolicyDocument } from "./adminPolicy.js";
import { impersonateAs, openAgentSession } from "./agentAdmin.js";
import { type Ctx, findAppFileAt, writeAppBytesAt } from "./appFolder.js";
import { agentAddress, config } from "./config.js";
import { JMAP_SUBMISSION, JmapClient } from "./jmap.js";
import type { LiveSession } from "./sessions.js";
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
/* The lock                                                            */
/* ------------------------------------------------------------------ */

/** Whether this installation has locked the account's identity (ADR 0010 §4). */
export function identityLocked(address: string): boolean {
  const want = address.trim().toLowerCase();
  if (!want) return false;
  return (config.settingsPolicy.identities?.locked ?? []).includes(want);
}

/**
 * The document with one account's lock set or cleared.
 *
 * Pure, so the policy door does the reading, the writing and the compare-and-set
 * like every other change to this document. An empty list is written as no
 * `identities` key at all, the way an empty per-group narrowing is.
 */
export function withIdentityLock(
  doc: PolicyDocument,
  address: string,
  locked: boolean,
): PolicyDocument {
  const want = address.trim().toLowerCase();
  const current = doc.identities?.locked ?? [];
  const next = locked
    ? current.includes(want)
      ? current
      : [...current, want]
    : current.filter((a) => a !== want);
  const { identities: _dropped, ...rest } = doc;
  return next.length ? { ...rest, identities: { locked: next } } : rest;
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
  const want = group.trim().toLowerCase();
  for (const [id, account] of Object.entries(ctx.session.accounts ?? {})) {
    const a = account as { name?: unknown; isPersonal?: unknown };
    if (a.isPersonal !== false) continue;
    if (typeof a.name !== "string") continue;
    if (a.name.trim().toLowerCase() !== want) continue;
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
export interface PersonIdentitiesView {
  address: string;
  locked: boolean;
  impersonation: "ok" | "denied" | "unknown";
  identities: AdminIdentity[];
}

/**
 * Every identity a person holds, read by impersonating them.
 *
 * An app-password session cannot impersonate at all, and that is a state the
 * surface shows rather than an error it hides: it answers `denied` and an empty
 * list, so nothing looks like an account with no identities.
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
        locked: identityLocked(target),
        impersonation: "denied",
        identities: [],
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
    locked: identityLocked(target),
    impersonation: "ok",
    identities: await readIdentities(imp.ctx, accountId),
  };
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

/** A group's identity, and whether the agent is granted on it at all. */
export interface GroupIdentityView {
  name: string;
  granted: boolean;
  identity: AdminIdentity | null;
}

/**
 * The group's identity, read as the agent.
 *
 * `granted: false` is a state, not a failure: the agent is not a member of that
 * group, so nothing here writes it, and the surface names the grant that is
 * missing rather than showing a permission error that would read as a bug.
 */
export async function groupIdentity(
  admin: LiveSession,
  name: string,
): Promise<GroupIdentityView> {
  const group = identityAddress(name, "group");
  const ctx = await agentSession(admin);
  const accountId = groupAccountId(ctx, group);
  if (!accountId) return { name: group, granted: false, identity: null };
  const identities = await readIdentities(ctx, accountId);
  return { name: group, granted: true, identity: identities[0] ?? null };
}

/**
 * Write the group's identity, as the agent.
 *
 * A group holds one identity (ADR 0010 §3): when it already has one, this is an
 * update of that one rather than a second identity beside it — the product's
 * rule, applied here so no surface has to know it.
 */
export async function writeGroupIdentity(
  admin: LiveSession,
  name: string,
  id: string | null,
  patch: unknown,
): Promise<{ id: string }> {
  const group = identityAddress(name, "group");
  const ctx = await agentSession(admin);
  const accountId = groupAccountId(ctx, group);
  if (!accountId)
    throw new IdentityAdminError(
      "group_not_granted",
      `The installation's agent is not a member of ${group}, so nothing here can write its identity. Grant the agent on that group and save again.`,
      409,
    );
  const existing = await readIdentities(ctx, accountId);
  const target = id ?? existing[0]?.id ?? null;
  // The one-identity rule, enforced where it is a fact about the account: an id
  // the surface invented is not one of this group's, and the server says so.
  if (target && !existing.some((identity) => identity.id === target))
    throw new IdentityAdminError(
      "identity_not_found",
      `${group} holds no identity with that id.`,
      404,
    );
  return { id: await writeIdentity(ctx, accountId, target, patch) };
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
