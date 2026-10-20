/**
 * A group's engagement, as a document (ADR 0035).
 *
 * One rule is one document in the **group's own account**: `<id>.json` under
 * `rules/` in that account's `gilbert` app folder, addressed by `./rules`. It
 * says two things — **what wakes it and what it may touch**, one mode per
 * surface of the group's own account (ADR 0035), and **in prose what should
 * happen** when it is woken. It may also **declare that it sends**, which is
 * the one power a rule carries of its own (ADR 0032, class 3).
 *
 * A surface mode is not an authority class: `watch` and `ondemand` say *where*
 * a run may act, and the classes still decide whether a particular act needs a
 * person's word (ADR 0032). A rule is an instruction written in advance; a
 * sentence in the chat or in the mail is an instruction written now, and it is
 * a plan rather than a rule (ADR 0033).
 *
 * This module is the shape, its parser and the one test of whether a rule
 * watches an event: no I/O, so what a rule means is answerable in a test
 * without a server. A stored rule is a contract: every field below is written
 * by one build and read by the next, and a field that moves moves with every
 * reader and writer of it.
 */

import { errorDetail } from "../shared/errors.js";
import { isRecord } from "../shared/json.js";
import {
  isSurfaceMatrix,
  SURFACES,
  type SurfaceMatrix,
  type SurfaceName,
} from "../shared/surfaces.js";
import type { AccountEvent, AccountEventSource } from "./accountEvent.js";

/** The surfaces a rule's matrix names, in the editor's order. */
export { SURFACES as RULE_SURFACES } from "../shared/surfaces.js";
export type { SurfaceMode } from "../shared/surfaces.js";

/** One surface a rule's matrix names (`calendar` has no event source yet). */
export type RuleSurface = SurfaceName;

/** One rule's matrix: what wakes it and what it may touch (`surfaces.ts`). */
export type RuleSurfaces = SurfaceMatrix;

/** Whether a value is a complete matrix this build writes. */
export const isRuleSurfaces = isSurfaceMatrix;

/**
 * The schema this build writes and reads. A document of another version is
 * refused, so a field of the shape below moves this with it — the version is
 * how the change reaches a rule an installation has already written.
 */
export const RULE_VERSION = 2;

/**
 * One rule, as it is stored.
 *
 * A rule says **what may wake it and what it may touch** — one mode per surface
 * of the group's own account — and **in prose what should happen** when it is
 * woken. It may also **declare that it sends**, which is the one power it
 * carries of its own (ADR 0032, class 3). The authority classes still bound
 * every act: a surface `ondemand` says *where* the run may act, never that a
 * destructive act needs no person's word.
 */
export interface RuleDoc {
  /** The schema version; `RULE_VERSION` today. */
  v: 2;
  /** The rule's identity: its document's name under `rules/`. */
  id: string;
  /** The surface matrix: what wakes it and what it may touch. */
  surfaces: RuleSurfaces;
  /** In prose, what should happen when that activity is met. */
  instruction: string;
  /** Whether the rule declares that it sends (ADR 0032, class 3). */
  sends: boolean;
}

/** The surfaces a v1 rule's `watches` could name: the event sources of then. */
const V1_WATCH_SURFACES: readonly AccountEventSource[] = [
  "chat",
  "mail",
  "knowledge",
  "workorder",
  "files",
];

/**
 * The matrix a v1 rule becomes, without widening what it could do.
 *
 * The watched surfaces keep waking it; every other surface becomes `ondemand`,
 * which is what the v1 guard allowed (a rule could write any surface). Chat is
 * `watch` because every rule now has it. Nothing is turned `off`: the migration
 * narrows no write, and the administrator tightens the matrix when they review
 * the rule.
 */
function migratedSurfaces(watches: readonly AccountEventSource[]): RuleSurfaces {
  const surfaces: RuleSurfaces = {
    chat: "watch",
    mail: "ondemand",
    files: "ondemand",
    knowledge: "ondemand",
    workorder: "ondemand",
    calendar: "ondemand",
  };
  for (const surface of watches) surfaces[surface] = "watch";
  // A v1 rule that watched chat keeps it watch; the line above says the same,
  // and the literal type requires it.
  surfaces.chat = "watch";
  return surfaces;
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
 * A **v1** document is read as the matrix it means (ADR 0035): the surfaces it
 * watched stay `watch`, every other surface is `ondemand`, and chat is `watch`.
 * A `v` beyond this build is refused: a document written by a newer Gilbert may
 * carry a field whose meaning changed, and reading it as though it had not is
 * worse than saying so.
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
  if (whole.v !== 1 && whole.v !== RULE_VERSION)
    return {
      problem: `"v" is ${JSON.stringify(whole.v)}; this build reads versions 1 and ${RULE_VERSION}.`,
    };
  if (typeof whole.id !== "string" || !whole.id)
    return { problem: '"id" must be the rule\'s name.' };
  let surfaces: RuleSurfaces;
  if (whole.v === 1) {
    if (
      !Array.isArray(whole.watches) ||
      !whole.watches.length ||
      !whole.watches.every(
        (one): one is AccountEventSource =>
          typeof one === "string" &&
          (V1_WATCH_SURFACES as readonly string[]).includes(one),
      )
    )
      return {
        problem: `"watches" must be a non-empty list of the surfaces a rule could watch (${V1_WATCH_SURFACES.join(", ")}).`,
      };
    surfaces = migratedSurfaces(whole.watches);
  } else {
    if (!isRecord(whole.surfaces) || !isRuleSurfaces(whole.surfaces))
      return {
        problem: `"surfaces" must give every surface a mode (${SURFACES.join(", ")}) and keep chat at "watch".`,
      };
    surfaces = whole.surfaces;
  }
  if (typeof whole.instruction !== "string" || !whole.instruction.trim())
    return { problem: '"instruction" must say what should happen.' };
  if (typeof whole.sends !== "boolean")
    return { problem: '"sends" must be true or false.' };
  return {
    rule: {
      v: RULE_VERSION,
      id: whole.id,
      surfaces,
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
  return rule.surfaces[event.source] === "watch";
}
