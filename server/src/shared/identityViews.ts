/**
 * The shapes the identity routes answer with.
 *
 * One definition for the two tiers that meet here: the routes under
 * `/api/admin/identities` build these answers, the administrator's surface
 * reads them, and the person's own session reads two of them. Declared twice —
 * once beside the routes, once beside the fetch calls — a field added on one
 * side and forgotten on the other compiles on both and arrives as `undefined`
 * on one, which is exactly the drift SSOT forbids.
 *
 * `Identity` is here rather than beside the JMAP client that reads it, because
 * it is not this tier's or that tier's: it is the object Stalwart stores, the
 * object a person's own settings write through `Identity/set`, and the object
 * the administration writes through these routes. One shape, named once — the
 * client's `@/jmap/types` re-exports it as its own protocol type.
 *
 * What is not here is what a route *sends*: a write body is a request of its
 * own shape, validated on arrival like every other write. The exception is
 * `IdentityPatch`, because a patch is also what a surface holds while editing
 * an identity, so both tiers name the same set of fields.
 *
 * Type declarations only: no runtime code reaches a bundle through this file.
 */

/** One address on an identity's Reply-To or Bcc line. */
export interface IdentityAddress {
  /**
   * The display name, which JMAP leaves optional — `null` where the address
   * carries none — and Stalwart answers back as it holds it.
   */
  name: string | null;
  email: string;
}

/**
 * An identity: what a person or a group sends as, and the signatures under it.
 *
 * The same shape the client's own settings work with, so an identity means the
 * same thing wherever it is written.
 */
export interface Identity {
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

/** Whether this session can act as another principal at all. */
export type Impersonation = "ok" | "denied" | "unknown";

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
 * The identity a member sends as in one group.
 *
 * One id rather than a whole list: the composer already holds the group's
 * identities and resolves the id against them. The group's own identity — what
 * an unassigned member sends as — is deliberately **not** answered beside it: it
 * is step 2 of the cascade, a rule both tiers import
 * (`./identityAssignment`) and the client derives from the address the session
 * calls the account, so there is no second copy of it to go stale.
 */
export interface MemberAssignmentView {
  group: string;
  /** The identity this member sends as, or null when nothing is assigned. */
  assignedId: string | null;
}

/**
 * One group a person's own session holds, and what their account sends as
 * there (ADR 0007).
 */
export interface PersonGroupIdentities {
  /** The group's own address — what the server calls the account. */
  name: string;
  /** The identities this person's account sends as in that group. */
  identities: Identity[];
  /**
   * False when the person's own session could not read that account. An answer,
   * not a failure: the surface says which group it could not read rather than
   * showing it as one with no identities.
   */
  readable: boolean;
}

/** A person's identities, and whether the installation has taken the account over. */
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
  groups: PersonGroupIdentities[];
}

/**
 * A group's identities, its roster, and who sends as which of them.
 *
 * A group holds one identity per member (ADR 0007) — the group's own address,
 * each member's own display name and signature — so this is a list where the
 * surface used to hold one, and an administrator assigns them by member.
 * `granted: false` is a state, not a failure: the agent is not on that group,
 * so nothing here writes it, and the surface names the grant that is missing
 * rather than showing a permission error that would read as a bug.
 */
export interface GroupIdentityView {
  name: string;
  granted: boolean;
  /**
   * One identity per member (ADR 0007): the group's own address, each member's
   * own display name and signature.
   */
  identities: Identity[];
  /**
   * The group's roster, read as the agent: `null` when it could not be read at
   * all, which is an answer rather than a failure — the identities it holds are
   * still listed, and the surface says the roster is unreadable.
   */
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
