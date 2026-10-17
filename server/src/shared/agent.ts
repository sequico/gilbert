/**
 * The installation's one agent, as both tiers read it (ADR 0031, 0036).
 *
 * The claim is a **stored document** — one `agent-claim.json` in the app folder
 * of the account the agent signs in as — in the same position a run and a fact
 * are in: its shape is a contract every build writes and the next one reads, so
 * it lives here rather than beside the code that takes it, and the client's
 * Administration surface reads the very shape the server writes.
 *
 * What takes, renews and releases a claim is the server's own (`agent/claim.ts`):
 * none of it is I/O-free enough to be here, and the claim's document is smaller
 * than the two transitions that write it.
 *
 * Type declarations and the one predicate that reads a stored claim: no runtime
 * code reaches a bundle through this file beyond that check.
 */

import { isRecord } from "./json.js";
import { isInstant } from "./run.js";

/** The claim's document, in the app folder's own top level. */
export const CLAIM_FILE = "agent-claim.json";

/**
 * How long a claim that is not renewed is believed.
 *
 * The one number that says both when a live holder must renew and how long a
 * dead one's claim blocks the next start. Ten minutes is long enough that a
 * working agent's renewals are ordinary and short enough that a crash is
 * noticed by a restart rather than by a person.
 */
export const CLAIM_TTL_MS = 10 * 60_000;

/** The claim as it is stored. */
export interface ClaimDoc {
  v: 1;
  /** Who holds it. */
  holder: string;
  /** When it was taken, or last renewed. */
  takenAt: string;
  /** The instant it stops being believed, ISO 8601. */
  expires: string;
}

/** Whether a value is a claim this build reads. */
export function isClaimDoc(x: unknown): x is ClaimDoc {
  return (
    isRecord(x) &&
    x.v === 1 &&
    typeof x.holder === "string" &&
    !!x.holder &&
    isInstant(x.takenAt) &&
    isInstant(x.expires)
  );
}

/**
 * Where the installation's agent is, as `GET /api/admin/agent` answers it.
 *
 * What an administrator reads about the process itself, and nothing it could act
 * on: the claim is a fact about who is working the installation, and **nothing
 * here starts or stops anything** — the server's own boot does that (ADR 0031),
 * so a control that pretended otherwise would be a lie. The model's own fields
 * are the installation section's (ADR 0011), which a surface links to rather
 * than copies.
 */
export interface AgentStatus {
  /**
   * The claim as it is stored, or null when nobody holds one.
   *
   * A claim that is **stored but past its expiry** is a claim nobody is believed
   * to hold: the instant means one thing (ADR 0036), and a reader that showed a
   * lapsed claim as a held one would report an agent where there is none.
   */
  claim: ClaimDoc | null;
  /** How often the supervisor asks the loop for a pass, in seconds. */
  passSeconds: number;
}

/**
 * The signature a step the agent settles carries (ADR 0028).
 *
 * A step's `by` is the actor, and the record says a step the agent checks is
 * signed as the agent, which is not a person. The value cannot be mistaken for
 * an address, so no reader composes a name out of it that looks like somebody —
 * and one constant keeps the workorder's signature and a page's proposal
 * attribution from spelling the agent two ways.
 */
export const AGENT_SIGNATURE = "gilbert-agent";

/**
 * Whether one of a document's signatures is the agent's rather than a person's.
 *
 * A surface asks this to say who settled a step — the agent, or the person the
 * address names — instead of showing the stored value as though it were
 * somebody's name.
 */
export function isAgentSignature(value: string | null | undefined): boolean {
  return value === AGENT_SIGNATURE;
}
