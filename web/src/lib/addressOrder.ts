/**
 * The order an administration lists accounts and group mailboxes in.
 *
 * An account and a group mailbox are read by the address a person types and
 * recognises, so every list of them — the pickers and the force-password table
 * — is sorted by that address rather than by the order the server happened to
 * answer in. Comparison is case-insensitive, so `Alice@…` and `alice@…` are one
 * place rather than two, and it never looks at a display name: the address is
 * the key a person uses.
 */

/** The comparator itself, for a caller that holds bare addresses. */
export function compareAddress(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/** The same order, applied to entries that carry their address as `name`. */
export function byAddress<T extends { name: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => compareAddress(a.name, b.name));
}
