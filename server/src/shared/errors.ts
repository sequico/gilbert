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

/**
 * The detail of a thrown value, in the parenthesis the sentences that use it
 * already write, and empty when the value has no words of its own.
 *
 * `errorMessage` answers what the value said; this answers whether there is
 * anything to add. They differ where a failure is composed of the reason and
 * the value's own words: "Not valid JSON (…)" reads worse with an empty
 * parenthesis than with none, and a value thrown without a message leaves one.
 */
export function errorDetail(err: unknown): string {
  return err instanceof Error && err.message ? ` (${err.message})` : "";
}

/**
 * Whether a thrown value is JMAP's lost-compare-and-set refusal.
 *
 * A conditional write carrying a stale `ifInState` is refused with
 * `stateMismatch` (RFC 8620 §5.3), and every writer that retries needs to
 * recognise it. The check is duck-typed on `type`, not `instanceof`, because
 * the two tiers have different error classes and the value can cross the
 * proxy; a value carrying that type is that refusal.
 */
export function isStateMismatch(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: unknown }).type === "stateMismatch"
  );
}

/**
 * A refusal, in the shape every door raises it: a code, a sentence and a status.
 *
 * Each surface names its own class over this one, so a route reads the same
 * fields whichever door raised them — the code the client composes its own
 * sentence from, the status the route answers with, and the message the server
 * keeps for a person reading it directly. The code comes first because it is
 * what the refusal *is*; the sentence and the status follow.
 */
export class CodedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    name = "CodedError",
  ) {
    super(message);
    this.name = name;
  }
}
