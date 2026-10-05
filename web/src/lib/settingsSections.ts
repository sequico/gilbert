/**
 * What a person's Settings nav may offer (ADR 0007).
 *
 * An administrator who has taken over an account's identity records it in the
 * installation's policy, and the product then offers that person no **Identity &
 * signatures** section at all: no path to add, change or remove an identity,
 * and none to a signature of their own. The rule belongs to the surface, not to
 * the server — a client that speaks JMAP directly can still write the account's
 * own identity — so what the lock decides is which sections are shown, and that
 * decision lives here rather than in the list a surface happens to hold.
 */

/** The settings section an identity lock takes away. */
export const IDENTITIES_SECTION = "identities";

/**
 * The sections to show: the caller's list, minus the identity section while the
 * account's identity is locked. Order is the caller's and nothing else is
 * touched, so a section added later needs no change here.
 */
export function visibleSettingsSections<T extends { id: string }>(
  sections: T[],
  identityLocked: boolean,
): T[] {
  if (!identityLocked) return sections;
  return sections.filter((s) => s.id !== IDENTITIES_SECTION);
}
