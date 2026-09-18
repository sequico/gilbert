/**
 * How a caught failure reads, once for both tiers.
 *
 * A thrown value is `unknown`: whatever a rejected fetch, a JSON parse or a
 * library decided to throw. Every surface that shows one to a person has to
 * turn it into a sentence — the agent's trail and chat, the installation's
 * administration, the client's own agent panel — and the sentence has to be the
 * same whoever catches it, or the same failure reads two ways in two places and
 * a report of it cannot be searched for.
 *
 * Nothing here is clever on purpose: an `Error` carries a message a person was
 * meant to read, and anything else is stringified rather than hidden.
 */

/** The message of a thrown value, whatever it was thrown as. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
