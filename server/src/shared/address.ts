/**
 * Whether two addresses are the same address, once for both tiers.
 *
 * The question is asked on both sides of the wire — the server matches a
 * principal against the accounts a group holds, the client matches the identity
 * a reader picked against the ones an account sends as — and the answer has to
 * be the same one, or a match made on one tier is not a match on the other.
 *
 * Tolerant of null on purpose: the value usually arrives from a document or an
 * environment that need not have carried it, and "absent" and "empty" are the
 * same address for this comparison.
 */
export function sameAddress(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}
