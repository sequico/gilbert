/**
 * One count a provider reported, or null.
 *
 * A model provider answers with whatever it has: a token count, a `null`, a
 * string, a negative number. Two callers read those numbers out of a reply —
 * the document validator, which stores what a run spent, and the model client,
 * which is the one that saw the reply — and both want the same answer to "is
 * this a count?": a finite, non-negative number, or nothing. Declared here
 * rather than in the server's own helpers module because the agent documents
 * are read by the client too, and that module reaches the JMAP client.
 *
 * Pure: no runtime API at all.
 */

/** A reported count, or null when the provider did not report one. */
export function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
