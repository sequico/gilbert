/**
 * The installation's one agent, as both tiers read it (ADR 0027, 0032).
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

import { isInstant, isRecord } from "./json.js";
import { isRunEnding, type RunEnding } from "./run.js";

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

/**
 * The last pass, as the loop leaves it for a reader (`agent/status.json`).
 *
 * A pass is not an event and writes no log line, which is how an installation
 * whose agent was working looked exactly like one whose agent had stopped: the
 * runs in flight said what was moving, and nothing said whether anything had
 * been read at all. The document is written after a pass that worked something
 * or found a gap, and at most once a minute otherwise, so a reader has an
 * answer that is fresh and a quiet installation still pays almost nothing.
 */
export interface PassStatusDoc {
  /** The version this build writes. A reader does not insist on it. */
  v: number;
  /** When the pass ended, ISO 8601. */
  at: string;
  /** How long it took, in milliseconds. */
  ms: number;
  /** Whether this process held the installation's claim and worked at all. */
  claimed: boolean;
  /** The accounts it resolved. */
  accounts: number;
  /** Changes it read; runs it opened; waits that had come due. */
  changes: number;
  runs: number;
  due: number;
  /** What it could not cover, named (ADR 0030). */
  gaps: string[];
  /**
   * The last run the loop ended, or absent when it has ended none since this
   * process took the claim.
   *
   * Kept from pass to pass, unlike the counts beside it: a reader wants to know
   * what the agent's last act was without opening a group's list, and a quiet
   * pass that wiped it would leave the answer "nothing" where there was a run.
   * The instant it ended is the run's own, in the listing — this says what, not
   * when, so that a pass which skipped its own write cannot make a stale date
   * read as a recent one.
   */
  lastEnded?: {
    id: string;
    ending: RunEnding;
    /** The ending's own sentence, as the conversation has it. */
    why: string;
  };
  /**
   * What the installation spent today, in tokens (ADR 0038).
   *
   * The daily ceiling's counter: one write per pass, reset when the date
   * changes, so a day's spend is one field rather than a sum over every run.
   */
  spent?: {
    /** The UTC date the count belongs to, `YYYY-MM-DD`. */
    date: string;
    tokens: number;
  };
}

/** The app-folder path of the last pass's document. */
export const PASS_STATUS_FILE = "agent/status.json";

/**
 * Whether a value is a pass-status document this build reads.
 *
 * A **report**, not a contract: the version is not insisted on, so a document
 * written by a build that bumped it — with a field this one does not know, or a
 * version number it has never seen — is still read rather than turned into the
 * silence the document exists to cure. Every field the surface draws must be
 * there and sane; anything else is ignored.
 */
export function isPassStatusDoc(x: unknown): x is PassStatusDoc {
  const ended = isRecord(x) ? (x as { lastEnded?: unknown }).lastEnded : undefined;
  const spent = isRecord(x) ? (x as { spent?: unknown }).spent : undefined;
  return (
    isRecord(x) &&
    typeof x.v === "number" &&
    isInstant(x.at) &&
    isFiniteNumber(x.ms) &&
    typeof x.claimed === "boolean" &&
    isCount(x.accounts) &&
    isCount(x.changes) &&
    isCount(x.runs) &&
    isCount(x.due) &&
    Array.isArray(x.gaps) &&
    x.gaps.every((one) => typeof one === "string") &&
    (spent === undefined ||
      (isRecord(spent) &&
        typeof spent.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(spent.date) &&
        isCount(spent.tokens))) &&
    (ended === undefined ||
      (isRecord(ended) &&
        typeof ended.id === "string" &&
        !!ended.id &&
        isRunEnding(ended.ending) &&
        typeof ended.why === "string"))
  );
}

/** A finite number, whole or not: a duration in milliseconds. */
function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** A whole, finite count: what every tally on the pass's own document is. */
function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
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
 * here starts or stops anything** — the server's own boot does that (ADR 0027),
 * so a control that pretended otherwise would be a lie. The model's own fields
 * are the installation section's (ADR 0009), which a surface links to rather
 * than copies.
 */
export interface AgentStatus {
  /**
   * The claim as it is stored, or null when nobody holds one.
   *
   * A claim that is **stored but past its expiry** is a claim nobody is believed
   * to hold: the instant means one thing (ADR 0032), and a reader that showed a
   * lapsed claim as a held one would report an agent where there is none.
   */
  claim: ClaimDoc | null;
  /** How often the supervisor asks the loop for a pass, in seconds. */
  passSeconds: number;
  /**
   * What the last pass did, or null when no pass has been recorded.
   *
   * The pump's own answer: an installation whose agent is working and one whose
   * agent has stopped look the same from the runs alone, and this is the line
   * that tells them apart.
   */
  lastPass: PassStatusDoc | null;
  /**
   * Why the document that should carry `lastPass` could not be used, when it is
   * there and this build cannot read it.
   *
   * Absent from the answer when there is no document at all — no pass has been
   * written yet — and present when there is one and it is unreadable: the two
   * are different answers to "is the pump turning", and drawing them as one
   * `null` says "it never ran" about a document somebody has to look at.
   */
  lastPassProblem?: string;
}

/**
 * The signature a step the agent settles carries (ADR 0024).
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
