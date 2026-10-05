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

/** A JMAP id. */
export type Id = string;

/** Why one object in a `/set` was refused. */
export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
  /**
   * The node already carrying the name, on an `alreadyExists` refusal from
   * `FileNode/set` (`find_sibling_collision`, `crates/jmap/src/file/set.rs`,
   * v0.16.21). It is what lets a caller that lost a create race adopt the node
   * somebody else made instead of reporting a name nobody can see.
   */
  existingId?: Id;
  [k: string]: unknown;
}

/**
 * The answer a `/set` method gives, as both tiers read it out of a batch: the
 * client types its own writes with it, and the server reads Stalwart's reply
 * through it.
 */
export interface SetResponse<T = Record<string, unknown>> {
  accountId: Id;
  oldState: string | null;
  newState: string;
  created?: Record<string, T>;
  updated?: Record<string, T | null>;
  destroyed?: Id[];
  notCreated?: Record<string, SetError>;
  notUpdated?: Record<string, SetError>;
  notDestroyed?: Record<string, SetError>;
}
