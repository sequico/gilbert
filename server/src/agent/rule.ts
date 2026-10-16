/**
 * A group's engagement, as a document (ADR 0035).
 *
 * One rule is one document in the **group's own account**: `<id>.json` under
 * `rules/` in that account's `gilbert` app folder, addressed by `./rules`. It
 * says two things and nothing else — **what it watches**, the surfaces of the
 * group's own account whose activity wakes it (the vocabulary of
 * `./accountEvent`), and **in prose what should happen** when that activity is
 * met. It may also **declare that it sends**, which is the one power a rule
 * carries of its own (ADR 0032, class 3).
 *
 * There is deliberately no list of permitted actions here: what bounds the
 * agent is the authority classes (ADR 0032), not the rule (ADR 0035). A rule is
 * an instruction written in advance; a sentence in the chat or in the mail is
 * an instruction written now, and it is a plan rather than a rule (ADR 0033).
 *
 * This module is the shape, its parser and the one test of whether a rule
 * watches an event: no I/O, so what a rule means is answerable in a test
 * without a server. A stored rule is a contract: every field below is written
 * by one build and read by the next, and a field that moves moves with every
 * reader and writer of it.
 */

import { errorDetail } from "../shared/errors.js";
import { isRecord } from "../shared/json.js";
import type { AccountEvent, AccountEventSource } from "./accountEvent.js";

/**
 * The schema this build writes and reads. A document of another version is
 * refused, so a field of the shape below moves this with it — the version is
 * how the change reaches a rule an installation has already written.
 */
export const RULE_VERSION = 1;

/** Every surface a rule may watch (ADR 0031, 0035), in the record's order. */
export const RULE_SURFACES: readonly AccountEventSource[] = [
  "chat",
  "mail",
  "knowledge",
  "workorder",
  "files",
];

/** Whether a value names a surface a rule can watch. */
export function isRuleSurface(x: unknown): x is AccountEventSource {
  return typeof x === "string" && (RULE_SURFACES as readonly string[]).includes(x);
}

/**
 * One rule, as it is stored.
 *
 * `watches` is a list of surfaces and never a list of actions: a rule that
 * wrote "a message arrived" and a rule that wrote "mail" watch the same
 * activity, and the prose decides what to do about it.
 */
export interface RuleDoc {
  /** The schema version; `RULE_VERSION` today. */
  v: 1;
  /** The rule's identity: its document's name under `rules/`. */
  id: string;
  /** The surfaces of the group's account whose activity wakes this rule. */
  watches: AccountEventSource[];
  /** In prose, what should happen when that activity is met. */
  instruction: string;
  /** Whether the rule declares that it sends (ADR 0032, class 3). */
  sends: boolean;
}

/**
 * Parse one stored rule.
 *
 * Strict JSON, an object at the top, then every declared field checked. The
 * **first** field that is wrong is named and nothing is returned: a rule this
 * build cannot read is refused with its path and the reason (as an unreadable
 * run is, ADR 0034), never guessed at. A key this build does not know is
 * ignored — a field a later build added, or a retired one, decides nothing here
 * and does not refuse a rule that is otherwise whole — and the parsed rule
 * carries only the fields above, so the next write of it drops what was
 * unknown.
 *
 * A `v` this build does not know is refused. That is what the field is for: a
 * document written by a newer Gilbert may carry a field whose meaning changed,
 * and reading it as though it had not is worse than saying so.
 */
export function parseRuleDocumentDetailed(
  raw: string,
): { rule: RuleDoc } | { problem: string } {
  let whole: unknown;
  try {
    whole = JSON.parse(raw);
  } catch (err) {
    return { problem: `Not valid JSON${errorDetail(err)}.` };
  }
  if (!isRecord(whole)) return { problem: "The document must be a JSON object." };
  if (whole.v !== RULE_VERSION)
    return {
      problem: `"v" is ${JSON.stringify(whole.v)}; this build reads version ${RULE_VERSION}.`,
    };
  if (typeof whole.id !== "string" || !whole.id)
    return { problem: '"id" must be the rule\'s name.' };
  if (
    !Array.isArray(whole.watches) ||
    !whole.watches.length ||
    !whole.watches.every(isRuleSurface)
  )
    return {
      problem: `"watches" must be a non-empty list of the surfaces a rule can watch (${RULE_SURFACES.join(", ")}).`,
    };
  if (typeof whole.instruction !== "string" || !whole.instruction.trim())
    return { problem: '"instruction" must say what should happen.' };
  if (typeof whole.sends !== "boolean")
    return { problem: '"sends" must be true or false.' };
  return {
    rule: {
      v: RULE_VERSION,
      id: whole.id,
      watches: whole.watches,
      instruction: whole.instruction,
      sends: whole.sends,
    },
  };
}

/**
 * Whether a rule watches what happened.
 *
 * The whole of the matching: a rule is woken by an event on a surface it names,
 * and by nothing else. What the event carries is read when the rule's
 * instruction is carried out, not here.
 */
export function ruleApplies(rule: RuleDoc, event: AccountEvent): boolean {
  return rule.watches.includes(event.source);
}
