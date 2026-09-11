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
 * impersonating them from this session, a group's as the installation's agent,
 * and Stalwart's permission model is the gate: `impersonation: "denied"` is an
 * answer the surface shows, not an error to hide.
 */

import { apiFetch } from "@/jmap/client";
import type { Identity } from "@/jmap/types";

/** Whether this session can act as another principal at all. */
export type Impersonation = "ok" | "denied" | "unknown";

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
  locked: boolean;
  impersonation: Impersonation;
  identities: Identity[];
  /** The identity that account sends from by default, or null when it has not
   * chosen one and the client falls back to its first. */
  defaultIdentityId: string | null;
}

/** A group's identity — a group holds one — and whether the agent is granted on it. */
export interface AdminGroupIdentity {
  name: string;
  granted: boolean;
  identity: Identity | null;
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
  return res.id;
}

/** `POST /api/admin/identities/user/delete` — remove one, as the person. */
export async function deleteUserIdentity(address: string, id: string): Promise<void> {
  await apiFetch<{ ok: true }>("/api/admin/identities/user/delete", {
    method: "POST",
    body: JSON.stringify({ address, id }),
  });
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

/** `GET /api/admin/identities/group` — the one identity a group holds. */
export function fetchGroupIdentity(name: string): Promise<AdminGroupIdentity> {
  return apiFetch<AdminGroupIdentity>(
    `/api/admin/identities/group?name=${encodeURIComponent(name)}`,
  );
}

/** `POST` the same route — set it, as the installation's agent. Answers the id written. */
export async function saveGroupIdentity(
  name: string,
  id: string | null,
  patch: AdminIdentityPatch,
): Promise<string> {
  const res = await apiFetch<{ ok: true; id: string }>("/api/admin/identities/group", {
    method: "POST",
    body: JSON.stringify({ name, id, patch }),
  });
  return res.id;
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
