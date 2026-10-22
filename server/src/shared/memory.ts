/**
 * The installation's memory: entities, typed relations and facts over time
 * (ADR 0033, ADR 0038) — one definition, both tiers.
 *
 * The memory is **structured**: an *entity* (a booking, a client, a container, a
 * person) with a normalized name, and *facts* about entities with the interval
 * they are true for. A fact that stops being true is **closed** with its
 * `validTo`, never overwritten, so a run can answer "since when", and a
 * **relation** is a fact whose value is another entity.
 *
 * Stalwart holds one document per entity and per fact under `memory/` in the
 * **Master's own account** (addressed by `agent/memory.ts`), the fact carrying
 * the vector it was written with; the index this module builds from those
 * documents is the retrieval's own, rebuilt at boot with no model call.
 *
 * This module is the shape, its parsers, the index and the **selection** a call
 * carries (`recallMemory`): no I/O, so what a call recalls is answerable in a
 * test without a server, and the client can read the same documents the agent
 * wrote.
 *
 * A stored document is a contract: every field below is written by one build and
 * read by the next, and a field that moves moves with every reader and writer
 * of it.
 */

import { errorDetail } from "./errors.js";
import { isInstant, isRecord } from "./json.js";

/**
 * The schema this build writes and reads. A document of another version is
 * refused, so a field of the shape below moves this with it — the version is
 * how a change reaches a memory an installation has already written.
 */
export const MEMORY_VERSION = 4;

/**
 * The versions before the structured memory, which this build reads as well.
 *
 * A sheet of those versions is one *fact about a subject*, and it is **read as
 * an entity sheet**: the subject becomes the entity (its name normalized, its
 * kind unknown), the sentence becomes an `is` fact valid from the instant the
 * sheet was written. Nothing is rewritten on read — the sheet stays on disk
 * exactly as it was, and the next write about that entity is a document of this
 * version.
 *
 * Two fields of those versions have no counterpart here and are not guessed at:
 * `links` named other **sheets**, never entities, and `standing` scoped a fact
 * to one group's calls. A relation is a fact whose value is an entity (a
 * guess would invent one), and a group's conventions live in its instruction
 * (ADR 0038) — the sheet keeps both fields untouched for whoever reads the
 * document itself.
 */
const MEMORY_VERSION_WITHOUT_CORRECTION = 2;
const MEMORY_VERSION_WITHOUT_GROUP = 1;
const LEGACY_SHEET_VERSIONS: readonly number[] = [
  MEMORY_VERSION_WITHOUT_GROUP,
  MEMORY_VERSION_WITHOUT_CORRECTION,
  3,
];

/**
 * How long the one sentence of a fact may be, and the name of the entity it is
 * about.
 *
 * The writer's bound, not the parser's: a document already written is read
 * whatever it holds, and these are what keep one fact small enough that the
 * ceiling a call carries is never spent on a single document.
 */
export const MEMORY_FACT_MAX = 400;
export const MEMORY_SUBJECT_MAX = 200;

/**
 * The shortest entity name this build writes, in characters.
 *
 * A change's own words are what a fact is recalled by (`recallMemory`), so a
 * name of one or two letters is one that turns up as a whole word inside nearly
 * every change — it would be carried ahead of the facts the change is about and
 * spend the ceiling on nothing. Three is the smallest that names something.
 */
export const MEMORY_SUBJECT_MIN = 3;

/** The longest typed relation one fact may state. */
export const MEMORY_PREDICATE_MAX = 60;

/**
 * The oldest a fact may be and still be recalled, in milliseconds.
 *
 * **The pass applies this when it reads the memory** (ADR 0038): what it reads
 * is the memory at its own clock, and a fact whose open interval began longer
 * ago than this is not put in front of a turn. It is not deleted — the
 * "since when" read still answers it, and a person still sees it in
 * Administration — because a fact too old to reason from is not a fact that
 * never happened, and the memory is measured by what it recalls rather than by
 * what it holds.
 */
export const MEMORY_FACT_TTL_MS = 180 * 24 * 60 * 60 * 1_000;

/**
 * How many facts one entity may hold, and how many the installation's memory
 * may hold altogether.
 *
 * A cap **per entity** is the one ADR 0038 names: an entity that keeps
 * accumulating sentences is a subject the agent keeps learning and never
 * settles, and the write is refused with the cap named rather than the memory
 * growing until every pass pays for it. The store-wide ceiling is the same
 * guard for the whole installation.
 */
export const MEMORY_FACTS_PER_ENTITY = 50;
export const MEMORY_FACTS_MAX = 5_000;

/**
 * What a call carries, at most (ADR 0038): facts, and the characters of their
 * names and sentences together.
 *
 * The memory is recalled per turn, so what bounds it is the whole reason the
 * selection exists: only the top few reach the turn, and a fact that would
 * outgrow either ceiling is skipped rather than carried — one document that
 * does not fit must not be the end of the selection.
 */
export const RECALL_FACTS_MAX = 20;
export const RECALL_CHARS_MAX = 4_000;

/**
 * How close a fact's vector must be to the change's own words for that fact to
 * be recalled where an embedding exists.
 *
 * A wrong fact recalled is worse than a missing one (ADR 0038), so similarity
 * only ever adds what a person would recognise as the same subject; the exact
 * pass carries the rest. A cosine below this is a topic, not a subject.
 */
export const RECALL_SIMILARITY_FLOOR = 0.62;

/**
 * What a fact came from (ADR 0033): the run that wrote it, or a person.
 *
 * A person's fact is **in force**: the agent reasons from it and proposes
 * against it rather than overwriting it, and the store's own write is where
 * that is refused (`agent/memory.ts`).
 */
export type FactOrigin = { by: "run"; run: string } | { by: "person"; who: string };

/**
 * A person's correction of a fact, beside the origin it corrected (ADR 0033).
 *
 * The document keeps where its conclusion came from and when, and this says who
 * overruled it and when: the two are not one field, because the trace of a
 * conclusion and the word that is in force are two facts about the document.
 */
export interface FactCorrection {
  by: "person";
  who: string;
  at: string;
}

/**
 * What the agent concluded against a person's fact, kept as a proposal
 * (ADR 0033).
 *
 * The in-force sentence is not written over: the document carries the proposal
 * beside it, a person reads it in Administration, and **accepting it makes the
 * sentence the person's own** — the same correction path any person's word takes
 * (`correctFactByPerson`), which is what puts it in force. Dismissing it leaves
 * the document exactly as it was.
 */
export interface FactProposal {
  /** The sentence the agent concluded. */
  fact: string;
  /** The run that concluded it. */
  run: string;
  /** When it was concluded, ISO 8601. */
  at: string;
}

/**
 * What a fact states of its entity: another entity, or a literal value.
 *
 * A value that **is an entity** makes the fact a relation (ADR 0038), which is
 * what one hop of the live retrieval follows; a literal value is the entity's
 * own property — who it is, how it is spelled, what it carries.
 */
export type FactValue = { text: string } | { entity: string };

/**
 * The kinds of thing an entity may be, as the one vocabulary both tiers read.
 *
 * A kind is a hint the first fact gives and later facts keep: it decides
 * nothing in the retrieval and nothing in the store, and `"other"` is what a
 * subject whose kind nobody stated is.
 */
export const ENTITY_KINDS = [
  "person",
  "client",
  "booking",
  "container",
  "place",
  "product",
  "practice",
  "other",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Whether a name is a kind an entity may be. */
export function isEntityKind(x: unknown): x is EntityKind {
  return typeof x === "string" && (ENTITY_KINDS as readonly string[]).includes(x);
}

/**
 * The one spelling a name is compared and indexed in (ADR 0038).
 *
 * Lowercase, trimmed, inner whitespace collapsed: two different names are two
 * entities, and one name written twice is one entity. An alias is an explicit
 * fact, never a guess from a name that looks like another.
 */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The id an entity's document is named by, derived from its normalized name.
 *
 * Derived rather than random so that the same subject has one identity
 * everywhere it is met — a sheet of an earlier version is *projected* onto the
 * entity a later write would make, without a write, a lookup or a model call
 * (ADR 0038). A 64-bit FNV-1a of the normalized name, in hex.
 */
export function entityIdFor(name: string): string {
  return `entity-${fnv64(normalizeName(name))}`;
}

/** FNV-1a over the code points of a text, as 16 hex digits. */
function fnv64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const char of text) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Why an entity name cannot be written, or null when it can.
 *
 * One rule, two doors: the catalogue refuses the model's arguments before
 * anything runs (`agent/tools/memory.ts`), and the store refuses a write of its
 * own (`agent/memory.ts`), and both say the same thing.
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
 * The typed relation a fact states, in the one spelling it is stored in.
 *
 * A relation is a word — `is`, `alias`, `ships-with`, `reports-to` — never a
 * sentence: the sentence is the fact's own, and this is what makes two facts
 * about one entity comparable (the duplicate and the contradiction rules).
 */
export function normalizePredicate(predicate: string): string {
  return predicate
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/** Why a predicate cannot be written, or null when it can. */
export function predicateProblem(predicate: string): string | null {
  const text = normalizePredicate(predicate);
  if (!text) return '"predicate" must say how the subject relates to the value.';
  if (text.length > MEMORY_PREDICATE_MAX)
    return `"predicate" must be at most ${MEMORY_PREDICATE_MAX} characters.`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(text))
    return `"${predicate}" is not a relation: a relation is lower-case words joined by dashes, like "is" or "ships-with".`;
  return null;
}

/**
 * Whether a predicate admits one value at a time.
 *
 * A literal value is the entity's own property and a second one **closes** the
 * first (ADR 0038), except `alias`: an entity legitimately answers to several
 * names, and each is an explicit fact. A relation to another entity accumulates
 * — a booking has a shipper and a consignee — so it is never closed by a second
 * edge of the same predicate.
 */
export function singleValued(predicate: string, value: FactValue): boolean {
  return "text" in value && predicate !== "alias";
}

/** Whether two values say the same thing: one relation, or one normalized text. */
export function sameValue(a: FactValue, b: FactValue): boolean {
  if ("entity" in a && "entity" in b) return a.entity === b.entity;
  if ("text" in a && "text" in b) return normalizeName(a.text) === normalizeName(b.text);
  return false;
}

/** Whether a fact is still in force: its interval has no end yet. */
export function isOpen(fact: FactDoc): boolean {
  return fact.validTo === undefined;
}

/**
 * Whether a fact is still **recalled**: open, and its interval began no longer
 * ago than the memory's TTL (ADR 0038).
 */
export function isLive(
  fact: FactDoc,
  now: string,
  ttl: number = MEMORY_FACT_TTL_MS,
): boolean {
  if (!isOpen(fact)) return false;
  const from = Date.parse(fact.validFrom);
  const at = Date.parse(now);
  if (!Number.isFinite(from) || !Number.isFinite(at)) return true;
  return at - from <= ttl;
}

/**
 * Whether a person's word is in force on a fact.
 *
 * A person's own document carries it as its `origin`; a correction also leaves
 * the origin the document had, so the two shapes are one question. It is asked
 * here because the store's own write and the surface's sentence must answer it
 * the same way.
 */
export function isInForce(fact: FactDoc): boolean {
  return fact.origin.by === "person" || fact.correction !== undefined;
}

/* ------------------------------------------------------------------ */
/* The documents                                                      */
/* ------------------------------------------------------------------ */

/**
 * One entity, as it is stored.
 *
 * `normalized` is the entity's identity: the retrieval matches a change's words
 * against it, and an alias is a fact of the entity (`predicate: "alias"`) rather
 * than a second name in this field.
 */
export interface EntityDoc {
  /** The schema version; `MEMORY_VERSION` today. */
  v: 4;
  /** The entity's identity: its document's name under `memory/`. */
  id: string;
  /** What kind of thing it is. A hint the first fact gave; `other` when none. */
  kind: EntityKind;
  /** The name it was first written with, as it was spelled. */
  name: string;
  /** The name it is identified by: `normalizeName(name)` (ADR 0038). */
  normalized: string;
  /** Where the entity came from: the run whose fact made it, or a person. */
  origin: FactOrigin;
  /** When it was created, ISO 8601. */
  at: string;
}

/**
 * One atomic fact, with the interval it is true for.
 *
 * `validFrom` is when it became true and `validTo` when it stopped; an absent
 * `validTo` is a fact still in force. A contradicting fact **closes** the one it
 * replaces (the store writes the older document's `validTo`), a duplicate is not
 * written again, and a closed fact is never recalled by a turn — it is read by
 * the "since when" read, by entity and interval (ADR 0038).
 */
export interface FactDoc {
  /** The schema version; `MEMORY_VERSION` today. */
  v: 4;
  /** The fact's identity: its document's name under `memory/`. */
  id: string;
  /** The entity it is about, by id. */
  entity: string;
  /** The typed relation it states: `is`, `alias`, `ships-with`, … */
  predicate: string;
  /** Another entity (a relation), or the literal value it holds. */
  value: FactValue;
  /** The fact in the writer's own words, in one sentence. */
  fact: string;
  /** Where the conclusion came from: the run that wrote it, or a person. */
  origin: FactOrigin;
  /** When it was written, ISO 8601. */
  at: string;
  /** When it became true, ISO 8601. */
  validFrom: string;
  /** When it stopped being true; absent while it is in force. */
  validTo?: string;
  /**
   * The vector the fact was written with, where the installation embeds
   * (ADR 0038): the index is rebuilt from these at boot, so a boot costs no
   * model call. Absent on an installation without the capability, and on every
   * sheet read from an earlier version.
   */
  vector?: number[];
  /** The agent's conclusion against this person's fact, awaiting a person. */
  proposal?: FactProposal;
  /** A person's correction of the fact, beside the origin it corrected. */
  correction?: FactCorrection;
}

/**
 * A fact as a reader is handed it: the entity it names, by name.
 *
 * The document names its entity by id, which is what one definition of a
 * subject means; a turn, a panel and a run's record read the **name**, so the
 * projection is here — one place, both tiers (ADR 0033).
 */
export interface FactView extends FactDoc {
  /** The name of the entity the fact is about. */
  entityName: string;
  /** The name of the entity a relation points at, when it points at one. */
  objectName?: string;
}

/* ------------------------------------------------------------------ */
/* Reading a stored document                                          */
/* ------------------------------------------------------------------ */

function isOrigin(x: unknown): x is FactOrigin {
  if (!isRecord(x)) return false;
  if (x.by === "run") return typeof x.run === "string" && !!x.run;
  if (x.by === "person") return typeof x.who === "string" && !!x.who;
  return false;
}

function isCorrection(x: unknown): x is FactCorrection {
  return (
    isRecord(x) &&
    x.by === "person" &&
    typeof x.who === "string" &&
    !!x.who &&
    isInstant(x.at)
  );
}

function isProposal(x: unknown): x is FactProposal {
  return (
    isRecord(x) &&
    typeof x.fact === "string" &&
    !!x.fact.trim() &&
    typeof x.run === "string" &&
    !!x.run &&
    isInstant(x.at)
  );
}

function isFactValue(x: unknown): x is FactValue {
  if (!isRecord(x)) return false;
  if (typeof x.entity === "string" && x.entity) return true;
  return typeof x.text === "string" && !!x.text.trim();
}

function parseJson(
  raw: string,
): { whole: Record<string, unknown> } | { problem: string } {
  let whole: unknown;
  try {
    whole = JSON.parse(raw);
  } catch (err) {
    return { problem: `Not valid JSON${errorDetail(err)}.` };
  }
  if (!isRecord(whole)) return { problem: "The document must be a JSON object." };
  return { whole };
}

/**
 * Parse one stored entity.
 *
 * Strict, like every document here: an entity this build cannot read is refused
 * rather than guessed at. The id must be the one its normalized name derives
 * (`entityIdFor`), because that is what makes two reads of one subject the same
 * entity and what a fact about it points at.
 */
export function parseEntityDocumentDetailed(
  raw: string,
): { entity: EntityDoc } | { problem: string } {
  const parsed = parseJson(raw);
  if ("problem" in parsed) return parsed;
  const whole = parsed.whole;
  if (whole.v !== MEMORY_VERSION)
    return {
      problem: `"v" is ${JSON.stringify(whole.v)}; this build reads version ${MEMORY_VERSION}.`,
    };
  if (typeof whole.id !== "string" || !whole.id)
    return { problem: '"id" must be the entity\'s name.' };
  if (typeof whole.name !== "string" || !whole.name.trim())
    return { problem: '"name" must say what the entity is called.' };
  if (typeof whole.normalized !== "string" || !whole.normalized)
    return { problem: '"normalized" must be the name the entity is identified by.' };
  if (whole.normalized !== normalizeName(whole.name))
    return { problem: '"normalized" must be the entity\'s own name, normalized.' };
  if (!isEntityKind(whole.kind))
    return { problem: `"kind" must be one of ${ENTITY_KINDS.join(", ")}.` };
  if (!isOrigin(whole.origin))
    return { problem: '"origin" must name the run that made the entity, or the person.' };
  if (!isInstant(whole.at))
    return { problem: '"at" must be the instant the entity was created.' };
  if (whole.id !== entityIdFor(whole.normalized))
    return { problem: '"id" must be the id its normalized name derives.' };
  return {
    entity: {
      v: MEMORY_VERSION,
      id: whole.id,
      kind: whole.kind,
      name: whole.name,
      normalized: whole.normalized,
      origin: whole.origin,
      at: whole.at,
    },
  };
}

/**
 * One fact, as this build writes it, or as an earlier version's sheet reads as
 * one.
 *
 * `legacyName` is present exactly when the document was a sheet of an earlier
 * version: the subject it named, which the store projects into an entity
 * without writing anything. The **first** field that is wrong is named and
 * nothing is returned: a document this build cannot read is refused rather than
 * guessed at, so a malformed fact is a defect the caller reports and never a
 * fact the agent then reasons from.
 */
export function parseFactDocumentDetailed(
  raw: string,
): { fact: FactDoc; legacyName?: string } | { problem: string } {
  const parsed = parseJson(raw);
  if ("problem" in parsed) return parsed;
  const whole = parsed.whole;
  if (LEGACY_SHEET_VERSIONS.includes(Number(whole.v))) {
    const sheet = projectLegacySheet(whole);
    return "problem" in sheet ? sheet : { fact: sheet.fact, legacyName: sheet.name };
  }
  if (whole.v !== MEMORY_VERSION)
    return {
      problem: `"v" is ${JSON.stringify(whole.v)}; this build reads version ${MEMORY_VERSION} and the fact sheets of the earlier ones.`,
    };
  if (typeof whole.id !== "string" || !whole.id)
    return { problem: '"id" must be the fact\'s name.' };
  if (typeof whole.entity !== "string" || !whole.entity)
    return { problem: '"entity" must name the entity the fact is about.' };
  if (typeof whole.predicate !== "string" || !whole.predicate)
    return { problem: '"predicate" must say how the subject relates to the value.' };
  if (!isFactValue(whole.value))
    return { problem: '"value" must be another entity, or the text the fact holds.' };
  if (typeof whole.fact !== "string" || !whole.fact.trim())
    return { problem: '"fact" must say what is held true of it.' };
  if (!isOrigin(whole.origin))
    return { problem: '"origin" must name the run that wrote the fact, or the person.' };
  if (!isInstant(whole.at))
    return { problem: '"at" must be the instant the fact was written.' };
  if (!isInstant(whole.validFrom))
    return { problem: '"validFrom" must be the instant the fact became true.' };
  if (whole.validTo !== undefined && !isInstant(whole.validTo))
    return { problem: '"validTo" must be the instant the fact stopped being true.' };
  const proposal = whole.proposal;
  if (proposal !== undefined && !isProposal(proposal))
    return {
      problem:
        '"proposal" must be what the agent concluded, the run that concluded it and when.',
    };
  const correction = whole.correction;
  if (correction !== undefined && !isCorrection(correction))
    return {
      problem: '"correction" must name the person who corrected the fact, and when.',
    };
  const vector = whole.vector;
  if (
    vector !== undefined &&
    (!Array.isArray(vector) || !vector.every((n) => typeof n === "number"))
  )
    return { problem: '"vector" must be the numbers the fact was written with.' };
  const { validTo, ...rest } = whole;
  return {
    fact: {
      v: MEMORY_VERSION,
      id: rest.id as string,
      entity: rest.entity as string,
      predicate: rest.predicate as string,
      value: rest.value as FactValue,
      fact: rest.fact as string,
      origin: rest.origin as FactOrigin,
      at: rest.at as string,
      validFrom: rest.validFrom as string,
      ...(validTo === undefined ? {} : { validTo: validTo as string }),
      ...(vector === undefined ? {} : { vector: vector as number[] }),
      ...(proposal === undefined ? {} : { proposal }),
      ...(correction === undefined ? {} : { correction }),
    },
  };
}

/**
 * An earlier version's sheet, read as one fact about the entity its subject
 * named (ADR 0038).
 *
 * The sentence becomes the `is` fact, valid from the instant it was written; the
 * subject becomes the entity, by the id every reader derives from its normalized
 * name. Nothing is written: the sheet is left exactly as it was, and the next
 * write about that subject is a document of this version.
 */
function projectLegacySheet(
  whole: Record<string, unknown>,
): { fact: FactDoc; name: string } | { problem: string } {
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
  if (whole.proposal !== undefined && !isProposal(whole.proposal))
    return {
      problem:
        '"proposal" must be what the agent concluded, the run that concluded it and when.',
    };
  if (whole.correction !== undefined && !isCorrection(whole.correction))
    return {
      problem: '"correction" must name the person who corrected the fact, and when.',
    };
  return {
    name: whole.subject,
    fact: {
      v: MEMORY_VERSION,
      id: whole.id,
      entity: entityIdFor(whole.subject),
      predicate: "is",
      value: { text: whole.fact },
      fact: whole.fact,
      origin: whole.origin,
      at: whole.at,
      validFrom: whole.at,
      ...(whole.proposal === undefined ? {} : { proposal: whole.proposal }),
      ...(whole.correction === undefined ? {} : { correction: whole.correction }),
    },
  };
}

/**
 * One document of `memory/`, whatever version wrote it: an entity, a fact, or a
 * legacy sheet read as the fact it is.
 */
export type MemoryDocument =
  | { kind: "entity"; entity: EntityDoc }
  | { kind: "fact"; fact: FactDoc; legacyName?: string };

/**
 * Parse one document of the memory folder, deciding which of the two it is.
 *
 * A version prior to this one is a fact sheet; this version's document that
 * carries a `name` is an entity and one that carries an `entity` is a fact. Both
 * parsers are the strict ones above, and the first problem is the answer.
 */
export function parseMemoryDocument(
  raw: string,
): { document: MemoryDocument } | { problem: string } {
  const parsed = parseJson(raw);
  if ("problem" in parsed) return parsed;
  const who = parsed.whole;
  if (LEGACY_SHEET_VERSIONS.includes(Number(who.v))) {
    const sheet = parseFactDocumentDetailed(raw);
    if ("problem" in sheet) return { problem: sheet.problem };
    return {
      document: {
        kind: "fact",
        fact: sheet.fact,
        ...(sheet.legacyName === undefined ? {} : { legacyName: sheet.legacyName }),
      },
    };
  }
  if (who.v === MEMORY_VERSION && typeof who.name === "string") {
    const entity = parseEntityDocumentDetailed(raw);
    return "problem" in entity
      ? entity
      : { document: { kind: "entity", entity: entity.entity } };
  }
  const fact = parseFactDocumentDetailed(raw);
  if ("problem" in fact) return { problem: fact.problem };
  return {
    document: {
      kind: "fact",
      fact: fact.fact,
      ...(fact.legacyName === undefined ? {} : { legacyName: fact.legacyName }),
    },
  };
}

/**
 * The entity a legacy sheet was about, as this build would make it.
 *
 * Projection, never a write: the entity exists in the reading and gets a
 * document the first time something is written about it.
 */
export function entityFromName(name: string, origin: FactOrigin, at: string): EntityDoc {
  return {
    v: MEMORY_VERSION,
    id: entityIdFor(name),
    kind: "other",
    name: name.trim(),
    normalized: normalizeName(name),
    origin,
    at,
  };
}

/* ------------------------------------------------------------------ */
/* The index, and the selection a call carries                        */
/* ------------------------------------------------------------------ */

/**
 * The memory as the retrieval reads it (ADR 0038).
 *
 * Rebuilt from the documents — and from the vectors they carry — with no model
 * call, so a boot costs nothing and the same index answers every turn of a pass.
 */
export interface MemoryIndex {
  /** The entity each normalized name and each alias names. */
  names: Map<string, string>;
  entities: Map<string, EntityDoc>;
  /** Every fact of one entity, open and closed, oldest interval first. */
  facts: Map<string, FactDoc[]>;
  /** The vectors the facts were written with, for the similarity pass. */
  vectors: Array<{ id: string; entity: string; vector: number[] }>;
}

/**
 * Build the index from the documents.
 *
 * The entity's own normalized name wins over an alias of the same spelling: a
 * name that is one entity's is not another's alias, and the order here is what
 * makes that true whatever order the documents were read in.
 */
export function buildMemoryIndex(
  entities: readonly EntityDoc[],
  facts: readonly FactDoc[],
): MemoryIndex {
  const index: MemoryIndex = {
    names: new Map(),
    entities: new Map(),
    facts: new Map(),
    vectors: [],
  };
  for (const entity of entities) {
    index.entities.set(entity.id, entity);
    index.names.set(entity.normalized, entity.id);
  }
  const byEntity = new Map<string, FactDoc[]>();
  for (const fact of facts) {
    const held = byEntity.get(fact.entity);
    if (held) held.push(fact);
    else byEntity.set(fact.entity, [fact]);
    if (fact.vector?.length)
      index.vectors.push({ id: fact.id, entity: fact.entity, vector: fact.vector });
    if (fact.predicate === "alias" && "text" in fact.value) {
      const alias = normalizeName(fact.value.text);
      if (!index.names.has(alias)) index.names.set(alias, fact.entity);
    }
  }
  for (const [entity, held] of byEntity)
    index.facts.set(
      entity,
      [...held].sort(
        (a, b) => a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id),
      ),
    );
  return index;
}

/** The entity a name (or an alias) identifies, or null when the memory holds none. */
export function resolveEntity(index: MemoryIndex, name: string): EntityDoc | null {
  const id = index.names.get(normalizeName(name));
  return id === undefined ? null : (index.entities.get(id) ?? null);
}

/** The facts of one entity, open and closed, oldest interval first. */
export function factsOf(index: MemoryIndex, entityId: string): readonly FactDoc[] {
  return index.facts.get(entityId) ?? [];
}

/** One fact as its readers see it, with the names its ids stand for. */
export function factView(fact: FactDoc, index: MemoryIndex): FactView {
  const entityName = index.entities.get(fact.entity)?.name ?? fact.entity;
  if (!("entity" in fact.value)) return { ...fact, entityName };
  const objectName = index.entities.get(fact.value.entity)?.name;
  return { ...fact, entityName, ...(objectName === undefined ? {} : { objectName }) };
}

/**
 * The one spelling a text is compared in.
 *
 * A name is a name a group wrote, and the same name is spelled with a different
 * capital letter far more often than it is a different subject.
 */
function fold(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Whether one folded text mentions the other, as a **whole word**.
 *
 * A change's own words are what recalls a fact (`recallMemory`), and a name has
 * to be named as a word for that rather than found inside one: a name of one or
 * two letters is a substring of nearly every change, and a containment that took
 * it would carry those facts ahead of the ones the change is about.
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

/** Cosine similarity of two vectors, or 0 when either has no length. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let at = 0; at < a.length; at += 1) {
    const one = a[at] ?? 0;
    const two = b[at] ?? 0;
    dot += one * two;
    left += one * one;
    right += two * two;
  }
  if (!left || !right) return 0;
  return dot / Math.sqrt(left * right);
}

/**
 * The similarity of each fact's vector to one embedded text (ADR 0038).
 *
 * The vector belongs to the fact, so this is what an installation that offers
 * embeddings adds to the retrieval: a fact is as close as its own vector is,
 * and the entity is as close as its nearest fact.
 */
export function similarityOf(
  index: MemoryIndex,
  words: readonly number[],
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const held of index.vectors) scores.set(held.id, cosine(words, held.vector));
  return scores;
}

/** What one turn's retrieval is given (`recallMemory`). */
export interface RecallQuery {
  /** The change's own words. */
  words: string;
  /** The pass's clock: a fact past the TTL is not recalled (ADR 0038). */
  now: string;
  /**
   * The similarity of each fact to the change's words, where the installation
   * embedded them (`similarityOf`). Absent on one that offers no embedding, and
   * then the retrieval is exact only.
   */
  similarity?: ReadonlyMap<string, number>;
}

/** What one turn's retrieval found, and which retrieval it was (ADR 0038). */
export interface Recall {
  facts: FactView[];
  /** What the run records it used: exact, or exact and similarity. */
  retrieval: "exact" | "exact+similarity";
}

/**
 * What one turn carries out of the memory: a selection, never the whole graph.
 *
 * The change's words are matched against the known subjects — **exact first**
 * (a name or an alias named as a whole phrase), **then similarity** where the
 * installation embedded the words — and what matches is ranked by subject, then
 * similarity, then recency (ADR 0038). Each selected entity brings its facts
 * valid at that moment, and relations are followed **one hop**: an entity a
 * selected entity's relation points at brings its own facts, and no further.
 *
 * The TTL and both ceilings are applied here: a fact older than the memory's TTL
 * is not recalled, a closed fact is never recalled (`isLive`), and one that does
 * not fit is skipped rather than ending the selection — so one very long
 * document cannot empty the memory for every call.
 */
export function recallMemory(index: MemoryIndex, query: RecallQuery): Recall {
  const named = fold(query.words);
  const exact = new Set<string>();
  if (named)
    for (const [name, id] of index.names) if (mentions(named, name)) exact.add(id);
  const nearest = new Map<string, number>();
  if (query.similarity)
    for (const [entityId, facts] of index.facts)
      for (const fact of facts) {
        const score = query.similarity.get(fact.id);
        if (score === undefined || score < RECALL_SIMILARITY_FLOOR) continue;
        nearest.set(entityId, Math.max(nearest.get(entityId) ?? -1, score));
      }
  /** The newest valid interval one entity holds, for the recency tie-break. */
  const newest = (id: string): string =>
    factsOf(index, id).reduce(
      (latest, fact) =>
        isLive(fact, query.now) && fact.validFrom > latest ? fact.validFrom : latest,
      "",
    );
  const candidates = [...new Set([...exact, ...nearest.keys()])]
    .filter((id) => index.entities.has(id))
    .sort((a, b) => {
      const subject = Number(exact.has(b)) - Number(exact.has(a));
      if (subject) return subject;
      const similarity = (nearest.get(b) ?? 0) - (nearest.get(a) ?? 0);
      if (similarity) return similarity;
      const recency = newest(b).localeCompare(newest(a));
      if (recency) return recency;
      return a.localeCompare(b);
    });
  const picked: FactView[] = [];
  const held = new Set<string>();
  let chars = 0;
  const take = (fact: FactDoc): void => {
    if (held.has(fact.id) || picked.length >= RECALL_FACTS_MAX) return;
    const view = factView(fact, index);
    const size = view.entityName.length + view.fact.length;
    if (chars + size > RECALL_CHARS_MAX) return;
    held.add(fact.id);
    chars += size;
    picked.push(view);
  };
  const live = (entityId: string): FactDoc[] =>
    factsOf(index, entityId)
      .filter((fact) => isLive(fact, query.now))
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom) || a.id.localeCompare(b.id));
  for (const id of candidates) for (const fact of live(id)) take(fact);
  /*
   * One hop, and only one: what a selected entity's relation points at is
   * carried with it, and the snapshot is taken before the walk so a chain of
   * relations cannot pull the whole memory in behind the first fact.
   */
  for (const fact of [...picked])
    if ("entity" in fact.value)
      for (const related of live(fact.value.entity)) take(related);
  return { facts: picked, retrieval: query.similarity ? "exact+similarity" : "exact" };
}

/**
 * One entity's facts over an interval, **including the closed ones** — the
 * "since when" read (ADR 0038).
 *
 * The live retrieval ignores a closed fact; a run that asks when something
 * stopped being true is answered here, by entity and interval: every fact whose
 * own `[validFrom, validTo]` overlaps the one asked for, oldest first, so the
 * sequence of what was true is readable in one list. The TTL does not apply —
 * age is not a reason to hide a fact from history.
 */
export function historyOf(
  index: MemoryIndex,
  name: string,
  interval: { from?: string; to?: string } = {},
): FactView[] {
  const entity = resolveEntity(index, name);
  if (!entity) return [];
  const from = interval.from ?? "";
  const to = interval.to ?? "";
  /*
   * A bound written as a day — `2026-03-01`, the way a person asks it — covers
   * that whole day: compared as instants, the day alone sorts before every
   * instant in it and would answer nothing for the day somebody asked about.
   */
  const before = (starts: string): boolean =>
    !to || (to.length > 10 ? starts <= to : starts.slice(0, 10) <= to);
  return factsOf(index, entity.id)
    .filter((fact) => (fact.validTo ?? "\uffff") >= from && before(fact.validFrom))
    .map((fact) => factView(fact, index));
}
