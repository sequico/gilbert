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
 * came from — the run that wrote it, or a person — when it was written, and
 * which other facts it is linked to. **A fact is information, never an
 * instruction**: it grants nothing and authorises nothing, the authority
 * classes (ADR 0032) and the trust of a sender (ADR 0033) are untouched by
 * anything it says, and a fact that reads like an order does not become one by
 * being remembered.
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
export const MEMORY_VERSION = 1;

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
 * What a call carries, at most (ADR 0037): facts, and the characters of their
 * subjects and sentences together.
 *
 * The memory is recalled on **every** call, so what bounds it is the whole
 * reason the selection exists: the standing set is taken first and a selection
 * that outgrows either ceiling is cut at the end rather than handed over whole.
 * A graph that does not fit is a memory that has stopped being worth keeping —
 * the discipline of a page, said as a number.
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
 * group, whatever the change at hand names.
 */
export interface FactDoc {
  /** The schema version; `MEMORY_VERSION` today. */
  v: 1;
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
  /** Whether every call of the group carries it, whatever the change names. */
  standing: boolean;
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
  if (whole.v !== MEMORY_VERSION)
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
 * 1. the group's small **standing set** — every fact marked `standing`, because
 *    that is what the group keeps about itself and every call starts from it;
 * 2. what the **change at hand names**: a fact whose subject the change's own
 *    words carry (the surface, the address, the subjects the decision found —
 *    `words` is that text, and the containment is what makes "Maersk" recall a
 *    sheet about it however the sheet spells the subject around it);
 * 3. their **nearest links** — one hop, so a fact about a thing brings what it
 *    is linked to and no further.
 *
 * There is no ranking engine and no index of its own: what the selection needs
 * is the words the change arrived in, and the change already carries them. The
 * ceiling is applied last, so what is cut is the end of the list and never the
 * standing set.
 */
export function recallFacts(facts: readonly FactDoc[], words: string): FactDoc[] {
  const named = fold(words);
  const picked: FactDoc[] = [];
  const held = new Set<string>();
  const take = (fact: FactDoc): void => {
    if (held.has(fact.id)) return;
    held.add(fact.id);
    picked.push(fact);
  };
  for (const fact of facts) if (fact.standing) take(fact);
  if (named)
    for (const fact of facts)
      if (fact.subject && named.includes(fold(fact.subject))) take(fact);
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  for (const fact of [...picked])
    for (const id of fact.links) {
      const linked = byId.get(id);
      if (linked) take(linked);
    }
  return withinCeiling(picked);
}

/** The facts that fit both ceilings, in the order the selection took them. */
function withinCeiling(facts: readonly FactDoc[]): FactDoc[] {
  const kept: FactDoc[] = [];
  let chars = 0;
  for (const fact of facts) {
    if (kept.length >= RECALL_FACTS_MAX) break;
    const size = fact.subject.length + fact.fact.length;
    if (chars + size > RECALL_CHARS_MAX) break;
    chars += size;
    kept.push(fact);
  }
  return kept;
}
