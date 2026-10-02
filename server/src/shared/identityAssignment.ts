/**
 * Which identity a member sends as in a group (ADR 0007) — one definition,
 * both tiers.
 *
 * A group's account holds one identity per member, and the administration
 * **assigns** a member theirs: the fact is recorded in `gilbert/identity-
 * assignments.json` in the group's own account, keys are member addresses and
 * values are ids of that account's identities. The binding is a record and not
 * a comparison of display names, because the display name is what a recipient
 * reads in the From line: a name that is also a key fails the moment either
 * side is written differently — a rename in the person's own account, a
 * spelling that differs by case, a name nobody ever set — and the member is
 * then told no identity was set for them in a group that holds one.
 *
 * The server writes the document as the installation's agent, in the same
 * action that writes the identity; the client reads the assignment and applies
 * the cascade below. Both tiers import this module rather than restating the
 * rule, so a member's From line cannot differ between the composer and the
 * surface that assigned it.
 */

import { isEmailAddress } from "./address.js";
import { isRecord } from "./json.js";

/** The file a group's member-to-identity assignment lives in. */
export const GROUP_ASSIGNMENTS_FILE = "identity-assignments.json";

/** The document as it is written, and the only shape a reader accepts. */
export interface AssignmentDoc {
  /** Format version: a reader that does not know one reads nothing. */
  v: 1;
  /** Member address (lowercased) to the id of an identity of this account. */
  members: Record<string, string>;
  updatedAt?: string;
  updatedBy?: string;
}

/** Whether a member address is one this document may carry a key for. */
export function isMemberKey(address: string): boolean {
  return isEmailAddress(address);
}

/**
 * The document's own shape, checked rather than assumed.
 *
 * A document that is not this shape is read as none: the alternative is a
 * corrupt file taking down the surface that reads it, which is what every
 * reader of an app-folder document here does.
 */
export function toAssignmentDoc(raw: unknown): AssignmentDoc | null {
  if (!isRecord(raw)) return null;
  const r = raw;
  if (r.v !== 1) return null;
  if (!isRecord(r.members)) return null;
  const members: Record<string, string> = {};
  for (const [key, value] of Object.entries(r.members)) {
    if (!isMemberKey(key)) continue;
    if (typeof value !== "string" || !value) continue;
    members[key.trim().toLowerCase()] = value;
  }
  return {
    v: 1,
    members,
    ...(typeof r.updatedAt === "string" ? { updatedAt: r.updatedAt } : {}),
    ...(typeof r.updatedBy === "string" ? { updatedBy: r.updatedBy } : {}),
  };
}

/** The assignment a member holds, or null when they hold none. */
export function assignmentFor(
  assignments: Record<string, string>,
  member: string | null | undefined,
): string | null {
  if (!member) return null;
  return assignments[member.trim().toLowerCase()] ?? null;
}

/**
 * The identity a mailbox sends as when nothing is assigned: **the account's
 * own** — the one whose address is the account's own address, which is what
 * the installation's agent sends as, else the first the account holds.
 *
 * This is the middle step of the cascade below and the whole of the agent's
 * rule, so a member with no assignment and the agent send a group's mail
 * identically rather than by two rules that happen to agree.
 */
export function accountOwnIdentity<T extends { id: string; email: string }>(
  identities: readonly T[],
  accountAddress: string | null | undefined,
): T | undefined {
  if (!identities.length) return undefined;
  const own = (accountAddress ?? "").trim().toLowerCase();
  const carrying = own
    ? identities.find((i) => i.email.trim().toLowerCase() === own)
    : undefined;
  return carrying ?? identities[0];
}

/**
 * Which identity the composer offers in a group's mailbox, in one cascade:
 *
 *   1. the identity the administration **assigned** that member, when there is
 *      one and the account still holds it;
 *   2. else the group's **own** identity — the one the agent sends as;
 *   3. else nothing: a group holding no identity at all is the one state with
 *      nothing to send as, and the composer says so.
 *
 * Never another member's: an identity assigned to somebody else is not a
 * fallback, and step 2 is the account's own voice rather than a member's.
 */
export function groupSenderIdentity<T extends { id: string; email: string }>(
  identities: readonly T[],
  assignmentId: string | null | undefined,
  accountAddress: string | null | undefined,
): T | undefined {
  if (assignmentId) {
    const assigned = identities.find((i) => i.id === assignmentId);
    if (assigned) return assigned;
  }
  return accountOwnIdentity(identities, accountAddress);
}

/** Whether this identity is an account's own: the one step 2 picks. */
export function isAccountOwnIdentity(
  identity: { id: string; email: string },
  accountAddress: string | null | undefined,
  identities: readonly { id: string; email: string }[],
): boolean {
  return accountOwnIdentity(identities, accountAddress)?.id === identity.id;
}
