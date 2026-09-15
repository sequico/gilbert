/**
 * The identities an administrator sets, as the client calls them (ADR 0007).
 *
 * One function per route the server serves under `/api/admin/identities`. The
 * answer shapes are read from the same declarations the routes build: an
 * identity is `Identity`, the object the person's own settings already work
 * with, so an identity means the same thing wherever it is written and no
 * field can be added on one side and forgotten on the other.
 *
 * The write needs no credential of its own. A person's identity is written by
 * impersonating them from this session, a group's as the Master,
 * and Stalwart's permission model is the gate: `impersonation: "denied"` is an
 * answer the surface shows, not an error to hide.
 */

import { apiFetch } from "@/jmap/client";
import type { Identity } from "@/jmap/types";
import { useMail } from "@/store/mail";

/**
 * Read this session's identity lists again, after one of the writes below.
 *
 * The write is the server's and is made as somebody else — an impersonation of
 * the account, or the agent for a group (ADR 0007) — so nothing in this
 * session's own store learns about it. The lists the session is holding are the
 * ones it goes on showing, which is how the administration and the person's own
 * Settings come to disagree: one deleted identity stays on the person's page for
 * the rest of the session.
 *
 * It lives here, under the routes, rather than in each surface that calls them:
 * a write is what invalidates the lists, so a fourth caller cannot forget to say
 * so. Best effort on purpose — the write has already succeeded, and a failed
 * read is not a failed change — and the surfaces that show a list read it again
 * when they open.
 */
async function afterIdentityWrite(): Promise<void> {
  await useMail.getState().refreshIdentities();
}

/** Whether this session can act as another principal at all. */
export type Impersonation = "ok" | "denied" | "unknown";

/**
 * Whether an account's identity has been taken over, or that the server could
 * not read the record at all.
 *
 * `"unknown"` is the third answer, and it is not the same as "not enforced":
 * the lock is a file in the locked account's own app folder, so a session that
 * cannot impersonate the account cannot read it and must not claim the account
 * is free. `IdentityLockUnknownReason` says what stopped the read.
 */
export type IdentityLockState = true | false | "unknown";

/** Why a lock state comes back `"unknown"`: the read the account refused. */
export type IdentityLockUnknownReason = "impersonation_denied";

/** The identity fields an administrator writes; `id` and `mayDelete` are the server's. */
export type AdminIdentityPatch = Partial<
  Pick<Identity, "name" | "email" | "replyTo" | "bcc" | "textSignature" | "htmlSignature">
>;

/** One account of the directory the picker offers, as `GET /api/admin/users` lists it. */
export interface AdminDirectoryUser {
  id: string;
  name: string;
}

/** The account directory, and what the server was willing to say about itself. */
export interface AdminUserDirectory {
  users: AdminDirectoryUser[];
  enumeration: boolean;
  enumerationMessage?: string | null;
  impersonation: Impersonation;
}

/** One group mailbox of the directory the picker offers, as `GET /api/admin/groups` lists it. */
export interface AdminDirectoryGroup {
  id: string;
  name: string;
}

/** The group directory, and whether the server could list it at all. */
export interface AdminGroupDirectory {
  groups: AdminDirectoryGroup[];
  enumeration: boolean;
  enumerationMessage?: string | null;
}

/** A person's identities, and whether the installation has taken the account over. */
export interface AdminUserIdentities {
  address: string;
  /** `"unknown"` when the server could not read the account's own lock file. */
  locked: IdentityLockState;
  /**
   * What stopped that read: null exactly when `locked` is `true` or `false`, and
   * the reason when it is `"unknown"`.
   */
  lockUnknownReason: IdentityLockUnknownReason | null;
  impersonation: Impersonation;
  identities: Identity[];
  /** The identity that account sends from by default, or null when it has not
   * chosen one and the client falls back to its first. */
  defaultIdentityId: string | null;
  /**
   * The groups this person belongs to, and what their own account may send as
   * in each (ADR 0007). Read as the person, so it is the same list their own
   * Identities & signatures section shows beneath their own.
   */
  groups: AdminPersonGroup[];
}

/** One group a person belongs to, and the identities their account sends as there. */
export interface AdminPersonGroup {
  /** The group's own address — what the server calls the account. */
  name: string;
  identities: Identity[];
  /**
   * False when the person's own session could not read that account. An answer,
   * not a failure: the surface says which group it could not read rather than
   * showing it as one with no identities.
   */
  readable: boolean;
}

/**
 * A group's identities, its roster, and whether the agent is granted on it.
 *
 * A group holds **one identity per member** (ADR 0007) — the group's own
 * address, each member's own display name and signature — so this is a list
 * where it used to be one, and the administrator assigns them by member.
 * `members` is that roster, read as the agent: `null` when it could not be read
 * at all, which is an answer rather than a failure — the identities it holds
 * are still listed, and the surface says the roster is unreadable.
 */
export interface AdminGroupIdentity {
  name: string;
  granted: boolean;
  identities: Identity[];
  members: string[] | null;
  /**
   * Which identity each member is **assigned**, by member address (ADR 0007).
   * The fact that binds a member to theirs; a member absent from it has been
   * assigned nothing and sends as `groupSenderId`.
   */
  assignments: Record<string, string>;
  /** The group's own identity: what an unassigned member sends as. */
  groupSenderId: string | null;
}

/* ------------------------------------------------------------------ */
/* The directories the pickers offer                                   */
/* ------------------------------------------------------------------ */

/** `GET /api/admin/users` — the accounts an identity may belong to. */
export function fetchAdminUserDirectory(): Promise<AdminUserDirectory> {
  return apiFetch<AdminUserDirectory>("/api/admin/users");
}

/** `GET /api/admin/groups` — the group mailboxes an identity may belong to. */
export function fetchAdminGroups(): Promise<AdminGroupDirectory> {
  return apiFetch<AdminGroupDirectory>("/api/admin/groups");
}

/* ------------------------------------------------------------------ */
/* A person's identities                                               */
/* ------------------------------------------------------------------ */

/** `GET /api/admin/identities/user` — every identity the account holds. */
export function fetchUserIdentities(address: string): Promise<AdminUserIdentities> {
  return apiFetch<AdminUserIdentities>(
    `/api/admin/identities/user?address=${encodeURIComponent(address)}`,
  );
}

/** `POST` the same route — add one (`id: null`) or change one. Answers the id written. */
export async function saveUserIdentity(
  address: string,
  id: string | null,
  patch: AdminIdentityPatch,
): Promise<string> {
  const res = await apiFetch<{ ok: true; id: string }>("/api/admin/identities/user", {
    method: "POST",
    body: JSON.stringify({ address, id, patch }),
  });
  await afterIdentityWrite();
  return res.id;
}

/** `POST /api/admin/identities/user/delete` — remove one, as the person. */
export async function deleteUserIdentity(address: string, id: string): Promise<void> {
  await apiFetch<{ ok: true }>("/api/admin/identities/user/delete", {
    method: "POST",
    body: JSON.stringify({ address, id }),
  });
  await afterIdentityWrite();
}

/**
 * `POST /api/admin/identities/user/lock` — take the account's identity over, or
 * give it back. The lock is the installation's record and ends no session: it is
 * read where the product asks what to offer, so the caller's own session sees it
 * by re-reading itself. The state the server holds comes back.
 */
export async function setUserIdentityLock(
  address: string,
  locked: boolean,
): Promise<boolean> {
  const res = await apiFetch<{ ok: true; locked: boolean }>(
    "/api/admin/identities/user/lock",
    { method: "POST", body: JSON.stringify({ address, locked }) },
  );
  return res.locked;
}

/**
 * `POST /api/admin/identities/user/default` — the identity that account sends
 * from by default, or `null` to clear it.
 *
 * The default is not a Stalwart property: it is one key of the account's own
 * settings document, so this route and that account's Identities & signatures
 * section are one stored value rather than two that can disagree.
 */
export async function setUserDefaultIdentity(
  address: string,
  identityId: string | null,
): Promise<string | null> {
  const res = await apiFetch<{ ok: true; identityId: string | null }>(
    "/api/admin/identities/user/default",
    { method: "POST", body: JSON.stringify({ address, identityId }) },
  );
  return res.identityId;
}

/* ------------------------------------------------------------------ */
/* A group's identity                                                  */
/* ------------------------------------------------------------------ */

/** `GET /api/admin/identities/group` — a group's identities, roster and assignments. */
export function fetchGroupIdentity(name: string): Promise<AdminGroupIdentity> {
  return apiFetch<AdminGroupIdentity>(
    `/api/admin/identities/group?name=${encodeURIComponent(name)}`,
  );
}

/**
 * `POST` the same route — write one of the group's identities **and assign it
 * to a member**, as the agent.
 *
 * `member` is the member's address, which is what binds the identity to them
 * (ADR 0007): the display name is what a recipient reads, not a key. `id` names
 * the identity to write, `null` meaning "the one this member already holds, else
 * a new one", so a save that lands twice changes one identity rather than
 * making a second. Answers the id written.
 */
export async function saveGroupIdentity(
  name: string,
  member: string,
  id: string | null,
  patch: AdminIdentityPatch,
): Promise<string> {
  const res = await apiFetch<{ ok: true; id: string }>("/api/admin/identities/group", {
    method: "POST",
    body: JSON.stringify({ name, member, id, patch }),
  });
  await afterIdentityWrite();
  return res.id;
}

/* ------------------------------------------------------------------ */
/* What a member sends as in a group                                    */
/* ------------------------------------------------------------------ */

/**
 * The identity the signed-in member sends as in one group.
 *
 * One id rather than a whole list: the composer already holds the group's
 * identities and resolves the id against them. The group's own identity — what
 * an unassigned member sends as — is deliberately **not** answered beside it: it
 * is step 2 of the cascade, a rule both tiers import
 * (`@gilbert/shared/identityAssignment`) and the store derives from the address
 * the session calls the account, so there is no second copy of it to go stale.
 */
export interface MemberAssignment {
  group: string;
  /** The identity assigned to this member, or null when none is. */
  assignedId: string | null;
}

/** `GET /api/identities/assignment?group=` — as the member, for their own composer. */
export function fetchMemberAssignment(group: string): Promise<MemberAssignment> {
  return apiFetch<MemberAssignment>(
    `/api/identities/assignment?group=${encodeURIComponent(group)}`,
  );
}

/* ------------------------------------------------------------------ */
/* The signature that does not fit                                     */
/* ------------------------------------------------------------------ */

/**
 * `POST /api/admin/identities/signature-html` — keep the full HTML of an
 * over-sized signature in the **target's own** Files, and answer the blob id.
 *
 * The client turns that id into the marker signature (`buildMarkerSignature`),
 * which is the only shape of an over-sized one that fits the server's limit;
 * the file itself is stored where the account's own client looks for it when it
 * reads the marker back.
 */
export async function storeAdminSignatureHtml(
  kind: "user" | "group",
  target: string,
  html: string,
): Promise<string> {
  const res = await apiFetch<{ blobId: string }>("/api/admin/identities/signature-html", {
    method: "POST",
    body: JSON.stringify({ kind, target, html }),
  });
  return res.blobId;
}
