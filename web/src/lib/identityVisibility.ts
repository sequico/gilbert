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
 */
import type { Identity } from "@/jmap/types";

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
 * Which identities a group mailbox offers the reader (ADR 0007).
 *
 * A group's account holds one identity per member, all carrying the group's
 * own address and each carrying that member's own name and signature. The
 * member is bound to their identity by the display name -- it is that member's
 * own identity name, read from their own account rather than typed a second
 * time there -- so matching on the name is matching on the person.
 *
 * A member sends as themselves or not at all: enforcing identities means
 * nothing while the picker under it still offers somebody else's, so this
 * never returns more than what matched. While the reader's own list is
 * unknown no name can match, and the account's default identity stands in if
 * it is in the list, else the first, else nothing: one identity, never the
 * whole membership. Once that list is here and holds no matching name, the
 * answer is nothing at all -- the account's default is somebody's identity,
 * not necessarily the reader's, and it is never offered in their place.
 */
/**
 * The key two display names are compared by, in one place.
 *
 * A group's account holds one identity per member, and the identity that
 * belongs to a member is the one carrying their name (ADR 0007). That name is
 * typed in one account and read on another surface, so the comparison is
 * trimmed and case-folded rather than a spelling test — and there is one of it,
 * because a picker and an administration that folded differently would
 * disagree about which identity belongs to whom.
 */
export function displayNameKey(name?: string | null): string {
  return (name ?? "").trim().toLowerCase();
}

export function offeredInGroupAccount<T extends Pick<Identity, "id" | "name">>(
  identities: T[],
  mine: { name?: string | null } | undefined,
  defaultId?: string | null,
): T[] {
  if (mine === undefined) {
    const instead = identities.find((i) => i.id === defaultId) ?? identities[0];
    return instead ? [instead] : [];
  }
  const wanted = displayNameKey(mine.name);
  if (!wanted) return [];
  return identities.filter((i) => displayNameKey(i.name) === wanted);
}

/** Whether hiding this one would be refused, so the UI can say so. */
export function isAlwaysVisible(
  id: string,
  keep: Array<string | null | undefined>,
): boolean {
  return keep.some((k) => k === id);
}
