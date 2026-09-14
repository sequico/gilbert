/**
 * Which identities the compose picker offers.
 *
 * Someone using a unique address per service, on a server with an alias domain,
 * ends up with every local part twice and a picker they cannot use — while only
 * ever sending from a handful (#73). Hiding is presentation only: the identity
 * still exists, still receives, and is still listed in Settings, the same way an
 * unsubscribed folder is still a folder.
 *
 * Three things it will not do, because a sender picker that cannot offer a
 * sender is worse than a cluttered one:
 *
 *   - hide the identity a draft is already using, which would leave the select
 *     with no matching option and reset the From line under the writer
 *   - hide the default identity, which is what a new draft starts on
 *   - hide everything; if every identity is hidden it shows them all instead
 *
 * Which identity a **group** mailbox offers is not decided here: that is the
 * assignment the administration recorded, with the group's own identity behind
 * it (ADR 0007), and it lives in `@gilbert/shared/identityAssignment`.
 */ import type { Identity } from "@/jmap/types";
import { sameAddress } from "@/lib/address";

export function visibleIdentities<T extends Pick<Identity, "id">>(
  identities: T[],
  hidden: readonly string[],
  keep: Array<string | null | undefined> = [],
): T[] {
  if (!hidden.length) return identities;
  const hide = new Set(hidden);
  for (const k of keep) if (k) hide.delete(k);
  const shown = identities.filter((i) => !hide.has(i.id));
  // Everything hidden: show the lot rather than an empty picker.
  return shown.length ? shown : identities;
}

/**
 * Which of an account's own identities is **theirs**, in one place.
 *
 * A group's account holds one identity per member, and a member is bound to
 * theirs by an assignment the administration records (ADR 0007) — so *which* of
 * a person's own identities is theirs is read here for one thing only: the
 * display name to write on the identity the administration creates for them,
 * read from their own account rather than typed a second time.
 *
 * The rule, in order:
 *
 *   1. the identity carrying **their own address** — an identity is a claim
 *      about who is sending, and the one claiming the person's own address
 *      claims to be them
 *   2. the identity their account **sends from by default**
 *   3. the first by address — a defined one, rather than whichever order the
 *      list a surface happens to hold arrived in
 *
 * `undefined` means the account holds no identity at all, which is an answer:
 * somebody with none has no name to be bound by.
 *
 * It is read for one purpose, and it is not a binding: the display name an
 * administrator writes on the identity they create for a member in a group.
 * What a member sends as there is the assignment, and it is written down.
 */
export function ownIdentity<T extends Pick<Identity, "id" | "name" | "email">>(
  identities: T[],
  address: string | null | undefined,
  defaultId: string | null | undefined,
): T | undefined {
  if (!identities.length) return undefined;
  const claiming = address
    ? identities.find((identity) => sameAddress(identity.email, address))
    : undefined;
  if (claiming) return claiming;
  const chosen = defaultId
    ? identities.find((identity) => identity.id === defaultId)
    : undefined;
  return chosen ?? [...identities].sort((a, b) => a.email.localeCompare(b.email))[0];
}

/** Whether hiding this one would be refused, so the UI can say so. */
export function isAlwaysVisible(
  id: string,
  keep: Array<string | null | undefined>,
): boolean {
  return keep.some((k) => k === id);
}
