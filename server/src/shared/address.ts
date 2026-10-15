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

/**
 * Whether a string is an address this product will accept.
 *
 * One predicate for a value every door names an address with — the policy
 * editor, the identity doors, the assignment document — so a value accepted at
 * one is not refused at another. A domain is required (a local part alone is
 * not an address), and the check is deliberately structural rather than
 * exhaustive: what a server actually accepts is the server's answer, and this
 * only refuses the obviously-not.
 *
 * `<>` is refused and the other punctuation is not. Angle brackets are the one
 * thing here that cannot be part of an address: they are the wrapper a message
 * puts around one (`Ann <ann@example.com>`), so a value carrying them is the
 * display form rather than the address, and accepting it passes the brackets on
 * to a door that will refuse them. An apostrophe, a comma, a semicolon and a
 * quote are all legal in a local part, so they stay accepted — refusing them is
 * how a person whose address holds one stops being able to write to anybody.
 */
export function isEmailAddress(value: string): boolean {
  return /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(value.trim());
}
