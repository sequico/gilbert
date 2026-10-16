/**
 * The agent's memory, as a document (ADR 0037) — one definition, both tiers.
 *
 * A fact is one small **sheet** in the **Master's own account**: a document
 * named `<id>.json` under `memory/` in that account's `gilbert` app folder,
 * addressed by `server/src/agent/memory.ts`. It is one memory for the
 * installation, recalled by a run wherever that run lives, because a decision
 * taken in one group is better when it knows what the rest of the installation
 * knows.
 *
 * The sheet says the **subject** it is about (a shipper, a mailbox, a client,
 * the group itself), what the agent holds true of it in one sentence, where it
 * came from — the run that wrote it, or a person — when it was written, which
 * other facts it is linked to, and **the group it is about**. The standing set a
 * call carries is the group being worked — what that group keeps about itself —
 * while any fact, standing or not, is recalled by its subject for **any** group:
 * one memory serves the installation, which is the point of it. **A fact is
 * information, never an instruction**: it grants nothing and authorises nothing,
 * the authority classes (ADR 0032) and the trust of a sender (ADR 0033) are
 * untouched by anything it says, and a fact that reads like an order does not
 * become one by being remembered.
 *
 * This module is the shape, its parser and the **selection** a call carries
 * (`recallFacts`): no I/O, so what a call recalls is answerable in a test
 * without a server, and the client can read the same sheet the agent wrote.
 *
 * A stored sheet is a contract: every field below is written by one build and
 * read by the next, and a field that moves moves with every reader and writer
 * of it.
 */

import { errorDetail } from "./errors.js";
import { isRecord } from "./json.js";
import { isInstant } from "./run.js";

/**
 * The schema this build writes and reads. A document of another version is
 * refused, so a field of the shape below moves this with it — the version is
 * how a change reaches a fact an installation has already written.
 */
export const MEMORY_VERSION = 2;

/**
 * The version before this one, which this build reads as well.
 *
 * `group` is the field this version added: a fact records the group it is about,
 * and the standing set a call carries is the group being worked. A document of
 * the version before it reads with no group — a fact about no group this build
 * knows, so it stands for none and is recalled by its subject like any other —
 * rather than being refused, because a version is how a change reaches the facts
 * an installation already wrote, not how it abandons them. Anything else this
 * build does not know stays refused.
 */
const MEMORY_VERSION_WITHOUT_GROUP = 1;

/**
 * How long the one sentence of a fact may be, and the subject it is about.
 *
 * The writer's bound, not the parser's: a sheet already written is read
 * whatever it holds, and these are what keep one fact small enough that the
 * ceiling a call carries is never spent on a single sheet.
 */
export const MEMORY_FACT_MAX = 400;
export const MEMORY_SUBJECT_MAX = 200;

/**
 * The shortest subject this build writes, in characters.
 *
 * A change's own words are what recalls a fact (`recallFacts`), so a subject of
 * one or two letters is one that turns up as a whole word inside nearly every
 * change — it would be carried ahead of the facts the change is about and spend
 * the ceiling on nothing. Three is the smallest that names something.
 */
export const MEMORY_SUBJECT_MIN = 3;

/**
 * Why a subject cannot be written, or null when it can.
 *
 * One rule, two doors: the catalogue refuses the model's arguments before
 * anything runs (`agent/tools.ts`), and the store refuses a write of its own
 * (`agent/memory.ts`), and both say the same thing.
 */
export function subjectProblem(subject: string): string | null {
  const text = subject.trim();
  if (!text) return '"subject" must say what the fact is about.';
  if (text.length < MEMORY_SUBJECT_MIN)
    return `"subject" must be at least ${MEMORY_SUBJECT_MIN} characters: a shorter one names nothing, and nearly every change carries it.`;
  if (text.length > MEMORY_SUBJECT_MAX)
    return `"subject" must be at most ${MEMORY_SUBJECT_MAX} characters.`;
  return null;
}

/**
 * What a call carries, at most (ADR 0037): facts, and the characters of their
 * subjects and sentences together.
 *
 * The memory is recalled on **every** call, so what bounds it is the whole
 * reason the selection exists: the standing set is taken first, and a fact that
 * would outgrow either ceiling is skipped rather than carried — one sheet that
 * does not fit must not be the end of the selection, or a single very long fact
 * would leave the memory empty for the whole installation. A graph that does not
 * fit is a memory that has stopped being worth keeping — the discipline of a
 * page, said as a number.
 */
export const RECALL_FACTS_MAX = 20;
export const RECALL_CHARS_MAX = 4_000;

/**
 * What a fact came from (ADR 0037): the run that wrote it, or a person.
 *
 * A person's fact is **in force**: the agent reasons from it and proposes
 * against it rather than overwriting it, and the store's own write is where
 * that is refused (`agent/memory.ts`).
 */
export type FactOrigin = { by: "run"; run: string } | { by: "person"; who: string };

/**
 * One fact, as it is stored.
 *
 * Every field is written when the sheet is, so a document missing one is a
 * document this build did not write. `standing` is what makes a fact part of
 * the small set a group keeps about itself: it is carried by every call of the
 * group it is **about** (`group`), whatever the change at hand names.
 */
export interface FactDoc {
  /** The schema version; `MEMORY_VERSION` today. */
  v: 2;
  /** The fact's identity: its document's name under `memory/`. */
  id: string;
  /** What it is about, in the group's own words. */
  subject: string;
  /** What the agent holds true of it, in one sentence. */
  fact: string;
  origin: FactOrigin;
  /** When it was written, ISO 8601. */
  at: string;
  /** The ids of the facts it is linked to. */
  links: string[];
  /** Whether every call of the group it is about carries it, whatever the change names. */
  standing: boolean;
  /**
   * The group the fact is about: the account of the run that wrote it (ADR 0037).
   *
   * It is what the **standing** set is filtered by — a standing fact is carried
   * by every call of this group and of no other, because the standing set is what
   * a group keeps about itself. Every other fact is recalled by its **subject**
   * for any group: one memory serves the installation, which is the point of it,
   * and a group reasons with what the rest of the installation knows.
   *
   * Empty only for a sheet of the version before this one, which named no group:
   * it stands for none and is recalled by subject like any other.
   */
  group: string;
}

/* ------------------------------------------------------------------ */
/* Reading a stored sheet                                              */
/* ------------------------------------------------------------------ */

function isOrigin(x: unknown): x is FactOrigin {
  if (!isRecord(x)) return false;
  if (x.by === "run") return typeof x.run === "string" && !!x.run;
  if (x.by === "person") return typeof x.who === "string" && !!x.who;
  return false;
}

/**
 * Parse one stored sheet.
 *
 * Strict JSON, an object at the top, then every declared field checked. The
 * **first** field that is wrong is named and nothing is returned: a sheet this
 * build cannot read is refused rather than guessed at, so a malformed fact is a
 * defect the caller reports and never a fact the agent then reasons from. A key
 * this build does not know is ignored — a field a later build added, or a
 * retired one, decides nothing here and does not refuse a sheet that is
 * otherwise whole — and the parsed fact carries only the fields above, so the
 * next write of it drops what was unknown.
 *
 * A `v` this build does not know is refused, because a document written by a
 * newer Gilbert may carry a field whose meaning changed. The one version before
 * this is read instead, with the field it added — `group` — defaulted to none
 * (`MEMORY_VERSION_WITHOUT_GROUP`): its facts are about no group this build
 * knows, so they stand for none and stay recalled by their subject.
 */
export function parseFactDocumentDetailed(
  raw: string,
): { fact: FactDoc } | { problem: string } {
  let whole: unknown;
  try {
    whole = JSON.parse(raw);
  } catch (err) {
    return { problem: `Not valid JSON${errorDetail(err)}.` };
  }
  if (!isRecord(whole)) return { problem: "The document must be a JSON object." };
  const withoutGroup = whole.v === MEMORY_VERSION_WITHOUT_GROUP;
  if (whole.v !== MEMORY_VERSION && !withoutGroup)
    return {
      problem: `"v" is ${JSON.stringify(whole.v)}; this build reads version ${MEMORY_VERSION}.`,
    };
  if (typeof whole.id !== "string" || !whole.id)
    return { problem: '"id" must be the fact\'s name.' };
  if (typeof whole.subject !== "string" || !whole.subject.trim())
    return { problem: '"subject" must say what the fact is about.' };
  if (typeof whole.fact !== "string" || !whole.fact.trim())
    return { problem: '"fact" must say what is held true of it.' };
  if (!isOrigin(whole.origin))
    return {
      problem: '"origin" must name the run that wrote the fact, or the person.',
    };
  if (!isInstant(whole.at))
    return { problem: '"at" must be the instant the fact was written.' };
  if (
    !Array.isArray(whole.links) ||
    !whole.links.every((id) => typeof id === "string" && !!id)
  )
    return { problem: '"links" must be the ids of the facts it is linked to.' };
  if (typeof whole.standing !== "boolean")
    return { problem: '"standing" must be true or false.' };
  // A version-1 sheet named no group, and reads as a fact about none; a sheet
  // of this version names one, and one that names none is a document this build
  // did not write.
  const group = withoutGroup ? (whole.group ?? "") : whole.group;
  if (typeof group !== "string" || (!withoutGroup && !group))
    return { problem: '"group" must name the group the fact is about.' };
  return {
    fact: {
      v: MEMORY_VERSION,
      id: whole.id,
      subject: whole.subject,
      fact: whole.fact,
      origin: whole.origin,
      at: whole.at,
      links: whole.links,
      standing: whole.standing,
      group,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The selection a call carries                                        */
/* ------------------------------------------------------------------ */

/**
 * The one spelling a subject or a name is compared in.
 *
 * A subject is a name a group wrote, and the same name is spelled with a
 * different capital letter far more often than it is a different subject.
 */
function fold(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Whether one folded text mentions the other, as a **whole word**.
 *
 * A change's own words are what recall a fact (`recallFacts`), and a subject has
 * to be named as a word for that rather than found inside one: a subject of one
 * or two letters is a substring of nearly every change, and a containment that
 * took it would carry those facts ahead of the ones the change is about. Both
 * texts arrive folded, and the boundary is a character that is not part of a
 * word on either side of the match.
 */
function mentions(haystack: string, needle: string): boolean {
  if (!needle) return false;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + 1)
  ) {
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + needle.length]))
      return true;
  }
  return false;
}

/** Whether a character of a folded text is part of a word. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9_]/.test(char);
}

/**
 * Whether two spellings name one subject: the store's own identity.
 *
 * One rule for one question — the write that must find the sheet a subject
 * already holds asks it here, so a second spelling of it cannot exist.
 */
export function sameSubject(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/**
 * What one call carries out of the memory: a selection, never the whole graph.
 *
 * Three parts, in the order they are taken (ADR 0037):
 *
 * 1. the **standing set of the group being worked** — every fact marked
 *    `standing` that is about `group`, because that is what a group keeps about
 *    itself and every call of it starts from there. A standing fact of another
 *    group is not carried: a group's conventions are its own;
 * 2. what the **change at hand names**: a fact whose subject the change's own
 *    words carry as a whole word, whatever group it is about (the surface, the
 *    address, the subjects the decision found — `words` is that text, and the
 *    match is what makes "Maersk" recall a sheet about it however the sheet
 *    spells the subject around it, while a subject of one or two letters — which
 *    nearly every change contains — is not a word the change named). One memory
 *    serves the installation, so a fact learned in one group is recalled in
 *    another when a change names its subject;
 * 3. their **nearest links** — one hop, so a fact about a thing brings what it
 *    is linked to and no further.
 *
 * There is no ranking engine and no index of its own: what the selection needs
 * is the words the change arrived in, and the change already carries them. Both
 * ceilings are applied as each fact is taken, so the facts that fit are carried
 * and one that does not is **skipped** rather than ending the selection — and the
 * standing set is taken first, so it is the last thing a ceiling costs.
 */
export function recallFacts(
  facts: readonly FactDoc[],
  words: string,
  group: string,
): FactDoc[] {
  const named = fold(words);
  const picked: FactDoc[] = [];
  const held = new Set<string>();
  /** The characters of the subjects and sentences carried so far. */
  let chars = 0;
  const take = (fact: FactDoc): void => {
    if (held.has(fact.id)) return;
    held.add(fact.id);
    const size = fact.subject.length + fact.fact.length;
    /*
     * A fact that does not fit is skipped, and the ones after it are still
     * considered: a cut that stopped here would let one very long sheet — one a
     * person wrote, read whatever it holds — empty the memory for every call of
     * the installation, silently.
     */
    if (picked.length >= RECALL_FACTS_MAX || chars + size > RECALL_CHARS_MAX) return;
    chars += size;
    picked.push(fact);
  };
  for (const fact of facts) if (fact.standing && fact.group === group) take(fact);
  if (named)
    for (const fact of facts)
      if (fact.subject && mentions(named, fold(fact.subject))) take(fact);
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  for (const fact of [...picked])
    for (const id of fact.links) {
      const linked = byId.get(id);
      if (linked) take(linked);
    }
  return picked;
}
