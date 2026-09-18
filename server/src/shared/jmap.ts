/**
 * The JMAP shapes both tiers speak.
 *
 * A method call and the array a response answers with are the protocol's own
 * tuples: the client builds one, the server builds one for Stalwart upstream,
 * and each reads the other's. Declared once here rather than beside each tier's
 * call site, where the two would hold the same three positions in the same
 * order and drift the day one of them gains a name.
 *
 * Type declarations only: no runtime code reaches a bundle through this file.
 */

/** One JMAP method call: name, arguments, call id. */
export type Invocation = [name: string, args: Record<string, unknown>, callId: string];

/** The `methodResponses` array a JMAP request answers with. */
export type MethodResponses = Invocation[];
