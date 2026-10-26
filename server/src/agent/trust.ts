/**
 * Whether a received message is a person's word (ADR 0029).
 *
 * Mail is a channel that reaches a person away from the product, and it is also
 * the channel anybody can write into, so the record does not trust a message for
 * what the message says about itself: a sentence is a person's word only when
 * **the sender is an address the installation knows** and **the server that
 * received the message vouches for how it arrived** — never the `From:` line,
 * which a sender writes and can write anything into. This module is that one
 * answer, about one received message, and nothing more.
 *
 * **The vouching has two shapes, and they differ by who was watching.**
 *
 * - Mail this server took from one of its own accounts — an account here writing
 *   to a mailbox here — never crossed a boundary: there is no SPF, DKIM or DMARC
 *   to verify and the server may write no authentication result at all. It is
 *   trusted on the server's own record of that submission instead, which is the
 *   **stronger** of the two facts and not the weaker one: nobody had to be
 *   believed, because the server was there when the account submitted it. The
 *   record names **which account authenticated**, and that address must be the
 *   message's own sender: the submission hop is the one place a `From:` is not
 *   evidence, and trusting the line there would let any account here write as a
 *   colleague.
 * - Mail another server handed over is **not read as anybody's word yet**. The
 *   verdict it carries is only worth what the authserv-id on it is worth — the
 *   name of the server that wrote it — and what a live Stalwart writes there is
 *   the probe owed (ADR 0029). Until it is answered, an arriving message is
 *   refused rather than believed: the conversation the product needs is with
 *   people who hold this installation's accounts, and their own mail comes back
 *   as a submission.
 *
 * A message with neither shape is nobody's word — one that arrived from outside,
 * one whose sender the installation does not know, one whose arrival left no
 * readable record — and a `From:` naming somebody the installation knows is
 * exactly the case the rule exists for.
 *
 * **It is called where a mail is read.** `readMessageForAnswer`
 * (`tools/mail.ts`) hands every received message to `personWord` and carries its
 * `word` answer beside the message's own fields. No run takes its answer from
 * mail (ADR 0038): a mail opens a run as a change like any other, and the trust
 * this module decides is what the reading knows about the sender — never a
 * licence to act. The correlation — which run a message answers — is the
 * conversation's own (`In-Reply-To`/`References` against the wait's `asked`, ADR
 * 0029, 0030) and stays the loop's; this module decides only whether the message is anybody's
 * word at all.
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
 * 0029, the debt marked at the end of this file). The mock writes what the
 * reading assumes of it and `server/src/mock/message-arrival.test.ts`
 * pins the two together.
 */

import { sameAddress } from "../shared/address.js";

/**
 * The JMAP property a message's hops are read from, topmost first.
 *
 * Exported because it is a **wire contract with two readers**: this module's
 * policy asks what the line says, and the mail layer that fetches the message
 * (`readMessageForAnswer`) must ask the server for exactly this property. Two
 * spellings of it would leave the policy reading nothing while the fetch looked
 * right.
 */
export const RECEIVED_HOPS = "header:Received:asText:all";

/** The property the agent's own sends are marked with (ADR 0029). */
export const RUN_MARK = "header:X-Gilbert-Run:asText";

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
  [RECEIVED_HOPS]?: ReadonlyArray<string> | null;
  [RUN_MARK]?: string | null;
}

/**
 * Why a message may not be read as a person's word (ADR 0029).
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
interface WordDecision {
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
  /**
   * Taken over an authenticated submission from one of this installation's
   * accounts, naming the account that authenticated — or null when the line does
   * not say which, which is refused rather than guessed at.
   */
  | { kind: "submitted"; sender: string | null }
  /** Handed to this server by another one: nobody here watched it come in. */
  | { kind: "outside" };

/**
 * Whether this received message may be read as a person's word.
 *
 * `own` is the address the agent acts as — the address of the account its
 * session signed in as, which is what its own mail carries when it does not write
 * as the group's identity (ADR 0005). `known` is what the installation knows:
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

  const arrival = arrivalOf(msg);
  if (arrival?.kind !== "submitted") return refused("not_authenticated");
  // The account that authenticated is the sender, or the message is nobody's
  // word: a submission hop without it leaves only the `From:` line, which is
  // what a sender writes.
  return arrival.sender !== null && from !== null && sameAddress(arrival.sender, from)
    ? word()
    : refused("not_authenticated");
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
  const hop = (msg[RECEIVED_HOPS] ?? [])[0];
  if (typeof hop !== "string") return null;
  if (SUBMISSION.test(hop)) return { kind: "submitted", sender: submitterOf(hop) };
  return PEER.test(hop) ? { kind: "outside" } : null;
}

/**
 * The server's own word for a submission taken from an authenticated account:
 * the ESMTP keyword's `A`, or the word itself.
 */
const SUBMISSION = /\bESMTPS?A\b|\bauthenticated\b/i;

/** The clause a hop line names the host it came from in (RFC 5321). */
const PEER = /^\s*from\s+\S/i;

/**
 * The account the receiving server authenticated the submission as.
 *
 * A hop that records a submission names the account in a **parenthesised
 * comment** — `(Authenticated sender: a@b)` or `(Authenticated as a@b)` — and it
 * is that address, not the `From:` the sender wrote, that the reading compares.
 * The parentheses are the whole of the hardening: a sender that connects with a
 * HELO containing the bare word `authenticated` writes it into the hop's
 * `from` clause, outside any comment, and a reading that accepted the word
 * anywhere would take that sender's account for the server's. A line whose
 * comment names nobody returns null, and the caller refuses: what a live
 * Stalwart writes here is the owed probe.
 */
const AUTH_SENDER =
  /\(\s*authenticated(?:\s+(?:sender|as))?\s*(?:as\b|:)?\s*<?([^\s<>()[\]"',;]+@[^\s<>()[\]"',;]+)>?\s*\)/i;

function submitterOf(hop: string): string | null {
  const found = AUTH_SENDER.exec(hop);
  return found?.[1] ?? null;
}

/*
 * ADR-0029 OWED: arrival-record-shape -- what a live Stalwart 0.16 writes
 * is unverified from inside this repository, on the two points this reading
 * rests on: what the first hop line records for a message one of the
 * installation's accounts submitted — the submission marker, and **whether it
 * names the account that authenticated**, which is what the reading now requires
 * (a server that records only the delivery hop there makes local mail refuse, and
 * this reading has to learn that shape); and the authserv-id of the
 * `Authentication-Results` it writes on a message received from outside, whose
 * value is what would make that verdict the server's own rather than a header a
 * sender planted. `scripts/probe-mail-trust.mjs` asks a live server both
 * questions by hand and prints the first hop and the authserv-id it finds; until
 * an answer is recorded, an outside message is refused outright and mail is
 * trusted no further than the shapes above.
 */
