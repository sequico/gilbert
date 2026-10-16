/**
 * Whether a received message is a person's word (ADR 0033).
 *
 * ADR 0033 runs the conversation in the group's chat and in mail, in words. Mail
 * is the channel that reaches a person away from the product, and it is also the
 * channel anybody can write into, so the record does not trust a message for what
 * the message says about itself: a sentence is a person's word only when **the
 * sender is an address the installation knows** and **the server that received
 * the message vouches for how it arrived** — never the `From:` line, which a
 * sender writes and can write anything into. This module is that one answer,
 * about one received message: what the loop asks before it reads an instruction,
 * an answer or an authorisation out of mail, and nothing more.
 *
 * **The vouching has two shapes, and they differ by who was watching.**
 *
 * - Mail another server handed over is trusted only when this server's own
 *   authentication result on it passes. That is where a forged `From:` lives, and
 *   refusing there is the point of the rule.
 * - Mail this server took from one of its own accounts — an account here writing
 *   to a mailbox here — never crossed a boundary: there is no SPF, DKIM or DMARC
 *   to verify and the server may write no authentication result at all. It is
 *   trusted on the server's own record of that submission instead, which is the
 *   **stronger** of the two facts and not the weaker one: nobody had to be
 *   believed, because the server was there when the account submitted it.
 *
 * A message with neither shape is nobody's word — one that arrived from outside
 * without a passing result, one whose sender the installation does not know, one
 * whose arrival left no readable record — and a `From:` naming somebody the
 * installation knows is exactly the case the rule exists for.
 *
 * **Nothing calls it yet.** Nothing here reads, sends or files mail either: a
 * caller that wants an answer must hand this one a message, which means the mail
 * reading asking for the three properties below and the reply being recognised as
 * the one a run waits for — the channel's own correlation
 * (`In-Reply-To`/`References` against the wait's `asked`, ADR 0033, 0034), which
 * is the loop's to do and deliberately not this module's.
 *
 * **It answers codes, never sentences.** A refusal is one of `TrustRefusal`'s
 * values; the sentence a reader sees is composed where it is shown — in the
 * client, from the code, through `t()` (`refusalSentence` in
 * `web/src/store/mail/mutations.ts` is the shape this product already has for a
 * refused destroy). A string held here would be a string no catalogue can
 * translate.
 *
 * **What the record fixes, and what it leaves open.** It fixes the two shapes
 * above, the mark every one of the agent's own sends carries, and that a run
 * waits where it asked. It does not say where the set of addresses the
 * installation knows comes from: the narrowest reading it supports is that the
 * caller has it — the installation's principals (a user, a group mailbox) or its
 * own list — and hands it over, so this decision reads the set it is given and
 * invents no directory of its own.
 *
 * **The shapes are owed a probe.** What a live Stalwart 0.16 writes is unverified
 * from inside this repository, on all three points the reading rests on (ADR
 * 0033, the debt marked at the end of this file). The mock writes what the
 * reading assumes of it and `server/src/mock/message-arrival.test.ts`
 * pins the two together.
 */

import { sameAddress } from "../shared/address.js";

/**
 * The property a received message carries the serving server's verdict in
 * (RFC 8601).
 *
 * JMAP serves a header as a property named for it, and the client's own read
 * declares the same name (`web/src/jmap/types.ts`).
 */
const AUTH_RESULTS = "header:Authentication-Results:asText";

/** The property the hops a message made are read from, topmost first. */
const HOPS = "header:Received:asText:all";

/** The property the agent's own sends are marked with (ADR 0033). */
const RUN_MARK = "header:X-Gilbert-Run:asText";

/**
 * What one received message carries, as the mail layer hands it over: the
 * properties of the JMAP `Email` this decision reads, narrowed to the four.
 *
 * A message is the protocol's object, not a shape of this module's: `from` is
 * the JMAP address list the client's `Email` declares, and the three headers are
 * JMAP's own property spelling of them.
 */
export interface ReceivedMessage {
  from?: ReadonlyArray<{ email?: string | null }> | null;
  [AUTH_RESULTS]?: string | null;
  [HOPS]?: ReadonlyArray<string> | null;
  [RUN_MARK]?: string | null;
}

/**
 * Why a message may not be read as a person's word (ADR 0033).
 *
 * One code per thing the reader would be told, because the sentences differ: a
 * message nobody vouched for, a sender the installation does not know, and the
 * agent's own words coming back.
 */
export type TrustRefusal =
  /** The server's account of the arrival does not establish that this is anybody's word. */
  | "not_authenticated"
  /** The sender is not an address the installation knows. */
  | "unknown_sender"
  /** The agent's own words, returned: never a person's answer. */
  | "own_send";

/** One message's answer: whether it is a person's word, and why not. */
export interface WordDecision {
  /** Whether the agent may take this message as that person's own word. */
  word: boolean;
  /** The code of the refusal, or null when the word may be taken. */
  refusal: TrustRefusal | null;
  /** The sender's address, as the message's own line names it. */
  from: string | null;
  /** The run whose own words came back, when the mark named one. */
  run: string | null;
}

/**
 * How the message arrived, as the receiving server's own hop record tells it.
 */
type Arrival =
  /** Taken over an authenticated submission from one of this installation's accounts. */
  | "submitted"
  /** Handed to this server by another one: nobody here watched it come in. */
  | "outside";

/**
 * Whether this received message may be read as a person's word.
 *
 * `own` is the address the agent acts as — the address of the account its
 * session signed in as, which is what its own mail carries when it does not write
 * as the group's identity (ADR 0007). `known` is what the installation knows:
 * `from` must name one of those addresses.
 *
 * The order is the record's, and it fails closed at every step. The agent's own
 * send needs nobody's trust to be recognised, so it is read first: **by the
 * mark** (an echo can come back carrying the group's identity, which is a known
 * principal, so the mark is the only thing that tells it apart) and **by the
 * sender being the agent's own address** (its own mail is its own whether the
 * mark survived the round trip or not). Either one is `own_send`, and for a run
 * waiting on a person that means the wait is not released: an echo of a send is
 * not an answer, so the run goes on waiting for one. Then the sender — the
 * record's first fact, and a sender the installation does not know is nobody's
 * word however the message arrived. Then the arrival itself, whose two shapes
 * are the vouching above; when the server left no readable record of the arrival,
 * there is nothing to read and the answer is `not_authenticated` rather than a
 * guess.
 */
export function personWord(
  msg: ReceivedMessage,
  { own, known }: { own: string; known: ReadonlyArray<string> },
): WordDecision {
  const from = senderOf(msg);
  const run = markOf(msg);
  const refused = (refusal: TrustRefusal): WordDecision => ({
    word: false,
    refusal,
    from,
    run,
  });
  const word = (): WordDecision => ({ word: true, refusal: null, from, run: null });

  if (run !== null) return refused("own_send");
  if (from !== null && sameAddress(from, own)) return refused("own_send");
  if (from === null || !known.some((address) => sameAddress(address, from)))
    return refused("unknown_sender");

  switch (arrivalOf(msg)) {
    case "submitted":
      return word();
    case "outside":
      return authenticatedBy(msg[AUTH_RESULTS] ?? null)
        ? word()
        : refused("not_authenticated");
    default:
      return refused("not_authenticated");
  }
}

/**
 * The sender's address, or null when the message's own line names none.
 *
 * Only the address is read: a display name is what a sender writes, and the
 * known set is compared against the address alone.
 */
function senderOf(msg: ReceivedMessage): string | null {
  const email = msg.from?.[0]?.email;
  return typeof email === "string" && email.trim() ? email : null;
}

/** The run an own send names, or null when the message carries no mark. */
function markOf(msg: ReceivedMessage): string | null {
  const mark = msg[RUN_MARK];
  return typeof mark === "string" && mark.trim() ? mark.trim() : null;
}

/**
 * The arrival the receiving server recorded, or null when it recorded none the
 * reading can use.
 *
 * The hops are the message's `Received` lines in the order the message carries
 * them, and the first is the line this server wrote last: every hop writes its
 * own above the ones before it, so the topmost line is the receiving server's own
 * and a line a sender planted inside its own message sits below it and is never
 * read. That line is the account of the arrival, and it is read for two things
 * alone: the word the server uses for a submission it accepted over an
 * authenticated connection — a message one of this installation's own accounts
 * wrote — and the host the message was handed over by. A line that says neither
 * is not an account this reading can use, and a message whose first hop is
 * missing or unreadable is answered as nobody's word rather than guessed at.
 */
function arrivalOf(msg: ReceivedMessage): Arrival | null {
  const hop = (msg[HOPS] ?? [])[0];
  if (typeof hop !== "string") return null;
  if (SUBMISSION.test(hop)) return "submitted";
  return PEER.test(hop) ? "outside" : null;
}

/**
 * The server's own word for a submission taken from an authenticated account:
 * the ESMTP keyword's `A`, or the word itself.
 */
const SUBMISSION = /\bESMTPS?A\b|\bauthenticated\b/i;

/** The clause a hop line names the host it came from in (RFC 5321). */
const PEER = /^\s*from\s+\S/i;

/** The only mechanism result that authenticates a message. */
const PASS = "pass";

/** Results that are a failure and not an absence: any one refuses the message. */
const FAILURES = new Set(["fail", "hardfail", "softfail", "permerror", "temperror"]);

/**
 * Whether the verdict says a message from outside authenticated.
 *
 * RFC 8601 gives the header an `authserv-id` — the server that wrote it, naming
 * itself first — and then one `method=result` property per mechanism, each
 * carrying its own reasons and possibly a comment or a quoted string anywhere.
 * What is read here is the results alone, and two answers are refused rather than
 * guessed at: a header that does not read as that shape at all, and one whose
 * results include a failure — a server that says one mechanism of this message
 * failed has not said this message authenticated, whatever passed beside it. A
 * result that is neither `pass` nor one of the failures is an absence (`none`,
 * `neutral`, `policy`), which authenticates nothing.
 */
function authenticatedBy(header: string | null): boolean {
  if (typeof header !== "string") return false;
  const clauses = stripNonResults(header).split(";");
  // The authserv-id is a clause of its own before the properties, and it carries
  // no `=`: a header with no such clause was not written as one.
  const server = clauses[0]?.trim() ?? "";
  if (!server || server.includes("=") || clauses.length < 2) return false;
  let passed = false;
  for (const clause of clauses.slice(1)) {
    // A method is letters, digits and inner punctuation; a `ptype.property` of a
    // reason is not one, and a clause that carries nothing else is not readable.
    const property = /^\s*([A-Za-z][\w-]*)\s*=\s*([A-Za-z][\w-]*)/.exec(clause);
    if (!property) return false;
    const result = property[2]!.toLowerCase();
    if (FAILURES.has(result)) return false;
    if (result === PASS) passed = true;
  }
  return passed;
}

/**
 * The header without its comments and quoted strings.
 *
 * Both may hold a `;`, which is the character the properties are separated by — a
 * reason such as `(1024-bit key; unprotected)` would otherwise split a clause in
 * two and be read as a property that is not one. Comments nest and both honour a
 * backslash escape, so this walks the value rather than matching it.
 */
function stripNonResults(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let at = 0; at < value.length; at++) {
    const char = value[at]!;
    if ((depth > 0 || quoted) && char === "\\") {
      at++;
      continue;
    }
    if (quoted) {
      if (char === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (char === "(") depth++;
      else if (char === ")") depth--;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "(") depth++;
    else out += char;
  }
  return out;
}

/*
 * ADR-0033 OWED: arrival-record-shape -- what a live Stalwart 0.16 writes
 * is unverified from inside this repository, on the three points this reading
 * rests on: the shape of the `Authentication-Results` it writes on a message it
 * received as the receiving server's own header rather than one a sender planted;
 * what its own first hop line records for a message one of the installation's
 * accounts submitted, and in particular **whether the submission marker this
 * reading looks for is on that line** (if the server writes only its delivery hop
 * there, local mail is refused and this reading has to learn that shape); and
 * whether JMAP answers the hops in the message's own order, topmost first, which
 * is what makes the line read here the server's own. `scripts/probe-*.mjs` is how
 * this repository asks a live server, by hand; until an answer is recorded, mail
 * is trusted no further than the shapes above, and the record's own consequence
 * says the same.
 */
