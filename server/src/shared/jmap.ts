/**
 * The JMAP shapes both tiers speak.
 *
 * A method call and the array a response answers with are the protocol's own
 * tuples: the client builds one, the server builds one for Stalwart upstream,
 * and each reads the other's. Declared once here rather than beside each tier's
 * call site, where the two would hold the same three positions in the same
 * order and drift the day one of them gains a name.
 *
 * The shapes are declarations; the two helpers below are runtime, because a
 * sentence built from a refusal and a move's patch are the same words on both
 * sides of the wire, and two spellings of either is the drift this file exists
 * to prevent.
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

/**
 * What a method-level refusal says, when it says anything.
 *
 * A `/set` answers a refusal inside a successful response, so every caller that
 * reads one has to turn it into a sentence for whoever asked. It lives here,
 * beside the shape it reads, because both tiers' writers need it: the admin
 * doors that write identities and contacts, and the app folder both of them
 * write through.
 */
export function refusalOf(
  entry: { type?: unknown; description?: unknown } | undefined,
): string {
  if (!entry) return "the mail server refused the change without saying why";
  const description = typeof entry.description === "string" ? entry.description : "";
  const type = typeof entry.type === "string" ? entry.type : "";
  return description || type || "the mail server refused the change without saying why";
}

/** One message's move into a folder, as an `Email/set` patch of its mailboxes. */
export function moveMailboxPatch(
  mb: Record<Id, boolean>,
  to: Id,
  from: Id | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (from) {
    if (from !== to) patch[`mailboxIds/${from}`] = null;
  } else {
    for (const f of Object.keys(mb)) if (f !== to) patch[`mailboxIds/${f}`] = null;
  }
  patch[`mailboxIds/${to}`] = true;
  return patch;
}
