/**
 * The one place the installation's memory is addressed (ADR 0033, ADR 0038).
 *
 * The memory is **entities, typed relations and facts with an interval**, one
 * document each under `memory/` in the **Master's own account** — one memory for
 * the installation wherever the run that recalls it lives. The shape, its
 * parsers, the index and the selection a call carries are
 * `@gilbert/shared/memory`; what lives here is where a document is, how the
 * store is read, and the writes that keep it true.
 *
 * **A fact about a subject the memory does not hold creates the entity**, and a
 * relation is a fact whose value is another entity. A contradicting fact
 * **closes** the one it replaces — the older document gets its `validTo`, never a
 * new sentence over it — and a duplicate is not written again. A document of an
 * earlier version is read as an entity and an `is` fact without being touched
 * (`shared/memory.ts`).
 *
 * **A person's fact is in force.** The agent's write does not replace it: what
 * it concluded is written beside it as a proposal, and correcting one is the
 * surface's to do. A document the parser would refuse is never written, so the
 * store and its reader cannot disagree about what a fact is.
 *
 * **One reading answers a whole pass.** The store is read once per pass
 * (`agent/loop.ts`) and that one reading answers both the retrieval a turn
 * carries and the writes the pass makes, so a large memory is not walked again
 * for every change.
 *
 * JMAP offers no lock, so a write of the store carries the account's FileNode
 * state as `ifInState` (`appFolder.ts`) — a **create** as much as a replace — and
 * the token is read **before** the documents: a write landing between the two
 * advances the state past the token, so a write carrying it is refused rather
 * than overwriting a change this read never saw.
 */
// ADR-0033 OWED: memory-pruning -- a closed fact keeps its document and leaves
// the live retrieval, and the facts no run ever recalled are what a person is
// shown first when the store is pruned by hand.

import { randomUUID } from "node:crypto";
import {
  appFolderState,
  type Ctx,
  destroyAppNode,
  ensureFolderPath,
  findAppFileAt,
  findFolderPath,
  listAppSheets,
  readAppFileAt,
  writeAppFileAt,
} from "../appFolder.js";
import { isStateMismatch } from "../jmap.js";
import { CodedError, errorMessage } from "../shared/errors.js";
import { isInstant } from "../shared/json.js";
import {
  buildMemoryIndex,
  type EntityDoc,
  type EntityKind,
  entityFromName,
  type FactDoc,
  type FactValue,
  type FactView,
  factsOf,
  historyOf,
  isInForce,
  isOpen,
  MEMORY_FACT_MAX,
  MEMORY_FACTS_MAX,
  MEMORY_FACTS_PER_ENTITY,
  MEMORY_VERSION,
  type MemoryDocument,
  type MemoryIndex,
  normalizePredicate,
  parseFactDocumentDetailed,
  parseMemoryDocument,
  type Recall,
  recallMemory,
  resolveEntity,
  sameValue,
  similarityOf,
  singleValued,
  subjectProblem,
} from "../shared/memory.js";
import { embedTexts, type ModelAccess, type UsageMeter } from "./model.js";

/** Where the installation's memory lives under the Master's app folder. */
const MEMORY_DIR = "memory";

/**
 * A document's path, app-folder-relative.
 *
 * An id is a file name and nothing else: an id carrying a path separator would
 * file the document in a folder of its own rather than beside its siblings. `.`
 * and `..` are refused by the same test, and by `pathSegments` after it. A name
 * this store cannot file is the caller's own mistake, so it is refused as one
 * (400) rather than as a mail-server fault.
 */
function documentPath(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new MemoryError(
      "fact_id_invalid",
      `"${id}" is not a document name: the memory is named by one plain file name.`,
      400,
    );
  return `${MEMORY_DIR}/${id}.json`;
}

/** A fact's document path, app-folder-relative. */
export function factPath(id: string): string {
  return documentPath(id);
}

/** An entity's document path: entities and facts live in the one folder, named once. */
export const entityPath = factPath;

/**
 * A document of the memory this build cannot use.
 *
 * The code is what a surface composes its own sentence from, as `RunError` is
 * for runs: a document that cannot be read, an entity the memory holds nothing
 * for, and the two refusals the writes are built on — a person's fact, which is
 * in force, and a memory that is full.
 */
export class MemoryError extends CodedError {
  constructor(code: string, message: string, status = 502) {
    super(code, message, status, "MemoryError");
  }
}

/** A fact together with the compare-and-set token its read saw. */
interface FactRecord {
  fact: FactDoc;
  /** The FileNode state at read time: pass it as `ifInState` to replace. */
  state: string;
}

/**
 * The installation's memory as one reading of it saw it (ADR 0038).
 *
 * `state` is the account's FileNode state at the moment of the read — the token
 * **every** write of the store carries — `now` is the pass's clock, which the
 * TTL is applied against when a turn recalls what is in the store, and `index` is
 * the retrieval's own: rebuilt from the documents and the vectors they carry,
 * with no model call.
 *
 * The store is read **once per pass**, and that one reading answers both the
 * retrieval a turn carries and the writes the pass makes (`agent/loop.ts`), so a
 * store of many thousands of documents is not walked again for every change in
 * the pass. What that costs is written down where it is paid: a fact written
 * during a pass is visible to the **next** pass and not to the pass that wrote
 * it, and the writes of one process are made one at a time, so the token a
 * write carries is the one the write before it produced.
 */
export interface MemoryStore {
  state: string;
  /** The pass's clock: the instant the TTL is read against. */
  now: string;
  entities: EntityDoc[];
  /**
   * The entities that have a document of their own. The rest are **projected**
   * from a sheet of an earlier version, and the first write about one makes it a
   * document of this version — which it cannot do without knowing which are
   * which (`agent/memory.ts`'s `ensureEntity`).
   */
  entitiesOnDisk: readonly string[];
  facts: FactDoc[];
  /** The names, the relations and the vectors, as the retrieval reads them. */
  index: MemoryIndex;
  /**
   * Whether the memory folder existed when this read happened. A first write
   * into a folder this read did not find has to make it, which moves the state
   * the read answered; the writer then takes a fresh one.
   */
  folder: boolean;
  /**
   * Documents this build cannot read, each with its path and the reason. They
   * are **reported, never skipped and never fatal**: one bad document must not
   * stop every group's pass, so the readable facts are answered beside the
   * problem.
   */
  problems: string[];
}

function unreadable(path: string, why: string): MemoryError {
  return new MemoryError(
    "fact_unreadable",
    `The memory document at ${path} is not readable: ${why} It has been left exactly as it is.`,
  );
}

/**
 * One fact's document by id, or null when there is none.
 *
 * A document that is there with bytes that do not come back is unreadable, not
 * absent, and a document the parser refuses is a defect the caller reports: the
 * alternative is a fact the agent reasons from and nobody explains. A document
 * of an earlier version is answered as the fact it reads as.
 */
async function readFactDoc(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<FactDoc | null> {
  const path = factPath(id);
  let found: Awaited<ReturnType<typeof readAppFileAt>>;
  try {
    found = await readAppFileAt(ctx, accountId, path);
  } catch (err) {
    throw unreadable(path, errorMessage(err));
  }
  if (!found) return null;
  const parsed = parseFactDocumentDetailed(found.text);
  if ("problem" in parsed) throw unreadable(path, parsed.problem);
  if (parsed.fact.id !== id)
    throw unreadable(path, `it names the fact "${parsed.fact.id}".`);
  return parsed.fact;
}

/** One fact by id, with the token a replace of it needs, or null when there is none. */
export async function readFact(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<FactRecord | null> {
  const state = await appFolderState(ctx, accountId);
  const fact = await readFactDoc(ctx, accountId, id);
  return fact ? { fact, state } : null;
}

/**
 * The whole memory, as one reading of it (ADR 0038): the entities, the facts, and
 * the index the retrieval is made from.
 *
 * The walk is `listAppSheets`, as the runs' is: the store is read once per pass
 * and a pass every ten seconds, so a document whose stamp has not moved is not
 * downloaded again. A document that cannot be read is **reported**, never
 * skipped: it is one thing the installation can no longer see, and a listing that
 * hid it would answer "this is what I know" about a store it could not read.
 *
 * A sheet of an earlier version is projected into the entity and the `is` fact it
 * reads as, with the entity's id derived from its normalized name; when both a
 * legacy sheet and an entity document name one entity, the document on disk is
 * the one that stands.
 *
 * **Growth is not bounded here**, and that is what this reader is honest about:
 * every write spends a blob JMAP offers no way to reclaim (`appFolder.ts`), so a
 * memory that grows costs the account's upload quota; pruning is a person's
 * decision, taken from Administration, and nothing does it on its own.
 */
export async function listMemory(
  ctx: Ctx,
  accountId: string,
  now = new Date().toISOString(),
): Promise<MemoryStore> {
  // The folder is made by the first write, never by a read: a pass is a read,
  // and a read that creates a folder moves the account state under every writer.
  const folder = await findFolderPath(ctx, accountId, MEMORY_DIR);
  const state = await appFolderState(ctx, accountId);
  const entities = new Map<string, EntityDoc>();
  const projected = new Map<string, EntityDoc>();
  const facts: FactDoc[] = [];
  const problems: string[] = [];
  /** One document of the folder, or the refusal `listAppSheets` reports. */
  const read = (id: string, text: string): MemoryDocument => {
    const parsed = parseMemoryDocument(text);
    if ("problem" in parsed)
      throw new Error(unreadable(documentPath(id), parsed.problem).message);
    return parsed.document;
  };
  for (const row of await listAppSheets(ctx, accountId, MEMORY_DIR, read)) {
    if (row.problem) {
      problems.push(row.problem);
      continue;
    }
    if (!row.doc) continue;
    if (row.doc.kind === "entity") {
      if (row.doc.entity.id !== row.id) {
        problems.push(
          unreadable(documentPath(row.id), `it names the entity "${row.doc.entity.id}".`)
            .message,
        );
        continue;
      }
      entities.set(row.doc.entity.id, row.doc.entity);
      continue;
    }
    if (row.doc.fact.id !== row.id) {
      problems.push(
        unreadable(documentPath(row.id), `it names the fact "${row.doc.fact.id}".`)
          .message,
      );
      continue;
    }
    facts.push(row.doc.fact);
    if (row.doc.legacyName?.trim()) {
      const entity = entityFromName(
        row.doc.legacyName,
        row.doc.fact.origin,
        row.doc.fact.at,
      );
      if (!projected.has(entity.id)) projected.set(entity.id, entity);
    }
  }
  /*
   * A projected entity is the one an earlier sheet named, and a document on disk
   * is what a later write made of it: the document stands, and the projection
   * only fills in what no document has yet.
   */
  const onDisk = [...entities.keys()];
  for (const [id, entity] of projected) if (!entities.has(id)) entities.set(id, entity);
  const list = [...entities.values()];
  return {
    state,
    now,
    entities: list,
    entitiesOnDisk: onDisk,
    facts,
    index: buildMemoryIndex(list, facts),
    problems,
    folder: folder !== null,
  };
}

/**
 * The entity and sentence one write states, trimmed and checked.
 *
 * The one answer to "is this something a document can hold", shared by the
 * agent's write and a person's correction: the rules are the document's own
 * (`shared/memory.ts`'s bounds) and a writer that spelled them out again would be
 * a second place they could drift.
 */
function checkedText(
  subject: string,
  sentence: string,
  at: string,
): { subject: string; sentence: string } {
  const trimmed = subject.trim();
  const held = sentence.trim();
  const problem = subjectProblem(trimmed);
  if (problem) throw new MemoryError("fact_invalid", problem, 400);
  if (!held)
    throw new MemoryError(
      "fact_invalid",
      "A fact needs the sentence it holds true.",
      400,
    );
  if (held.length > MEMORY_FACT_MAX)
    throw new MemoryError(
      "fact_invalid",
      `A fact's sentence is at most ${MEMORY_FACT_MAX} characters.`,
      400,
    );
  if (!isInstant(at))
    throw new MemoryError("fact_invalid", `"${at}" is not an instant.`, 400);
  return { subject: trimmed, sentence: held };
}

/** What the agent says while it works, for the write below (ADR 0038). */
export interface FactWrite {
  /** What the fact is about, in the group's own words. */
  subject: string;
  /** What kind of thing the subject is, when the first fact states it. */
  kind?: EntityKind;
  /** How it relates to the value: `is`, `alias`, `ships-with`, … */
  predicate?: string;
  /** Another entity it relates to, by name: the fact is then a relation. */
  object?: string;
  /** What the agent holds true of it, in one sentence. */
  fact: string;
  /** The run that is writing it. */
  run: string;
  /** When it is written, ISO 8601. */
  at: string;
  /** The vector the fact is written with, where the installation embeds. */
  vector?: number[];
}

/** What a write left behind: the fact, its entity, and how it landed. */
export interface Remembered {
  fact: FactDoc;
  entity: EntityDoc;
  /** Set when the write was a duplicate: nothing was written. */
  duplicate?: boolean;
}

/** What one write left the store as, for the chain's cache. */
interface Applied<T> {
  result: T;
  state: string | null;
  entities: EntityDoc[];
  onDisk: readonly string[];
  facts: FactDoc[];
}

/**
 * Write one fact the agent came to hold, closing what it contradicts and
 * refusing a person's.
 *
 * The write is made **against a reading of the store** that the caller hands in
 * — the pass's one reading (ADR 0038) — and the token it carries comes from that
 * reading, so a write landing since is refused rather than overwritten. A
 * refusal is not the end of the write: the store is read once per pass, so the
 * first write of a pass moves the state every later one carries, and a second
 * `remember` — another run of the same pass, or another call of one answer —
 * would lose against its own pass. The refusal is answered by reading the memory
 * again and deciding again: a subject the other call created is then **built
 * upon in its own entity**, not duplicated, and the pass's reading is moved
 * forward for whatever comes next.
 *
 * A **person's** fact is not replaced at all — a person's fact is in force
 * (ADR 0033) — and what the agent concluded is written beside it as a proposal.
 */
export async function rememberFact(
  ctx: Ctx,
  accountId: string,
  write: FactWrite,
  store: MemoryStore,
): Promise<Remembered> {
  return await oneAtATime(
    accountId,
    async () => store,
    async (opening) => {
      let used = opening;
      const settle = (applied: Applied<Remembered>): Remembered => {
        const entities = applied.entities;
        const facts = applied.facts;
        memoryStores.set(accountId, {
          ...used,
          state: applied.state ?? used.state,
          folder: true,
          entities,
          entitiesOnDisk: applied.onDisk,
          facts,
          index: buildMemoryIndex(entities, facts),
        });
        return applied.result;
      };
      try {
        return settle(await writeFact(ctx, accountId, write, used));
      } catch (err) {
        if (!isStateMismatch(err)) throw err;
        const fresh = await listMemory(ctx, accountId, used.now);
        /*
         * A person's document is never written against words this call did not
         * read: the memory moved because a person corrected it, and the agent's
         * proposal is concluded against the correction — the fresh reading
         * carries it, and `writeFact` records the proposal beside it rather than
         * over it.
         */
        memoryStores.set(accountId, fresh);
        used = fresh;
        return settle(await writeFact(ctx, accountId, write, fresh));
      }
    },
  );
}

/**
 * The memory's own writes, one at a time.
 *
 * The store is one document per entity and per fact in the Master's account, and
 * a pass works every group at once (`agent/loop.ts`): two runs of two groups
 * remembering a fact in the same second carried the same account state, and one
 * of them lost the compare-and-set and paid a failed step for it. There is no
 * lock to take — JMAP offers none — and none is needed: one process is the
 * installation's agent (ADR 0032), so chaining this process's writes is the whole
 * of the contention.
 *
 * The chain is the door for **every** write of the memory, the agent's and a
 * person's alike (`rememberFact`, `forgetFact`, `correctFactByPerson`,
 * `dismissProposal`): one compare-and-set token, and a second writer that did not
 * wait reads a state that is already gone. Nothing inside the chain may call back
 * into it.
 */
const memoryWrites = new Map<string, Promise<unknown>>();

/**
 * The store each account's chain left behind: the state the last write of the
 * chain produced, and the documents it read, so the next link of **that chain**
 * does not have to walk the whole memory to learn where the account now stands. A
 * pass clears it as it begins (`forgetMemoryStores`).
 */
const memoryStores = new Map<string, MemoryStore>();

/** Forget what this process's writes left behind, at the start of a pass. */
export function forgetMemoryStores(): void {
  memoryStores.clear();
}

/**
 * One link of the chain per account; the next one runs when this settles.
 *
 * The link hands the work the store it must write against: the one an earlier
 * link produced, or the seed the caller's reading supplies when the chain has
 * none. A **person's** write (`personWrite`) takes its seed every time instead of
 * the cached one: it is decided on the document the person was shown, and the
 * cached state can be older than a run's own write in the same account. A caller
 * never carries the token itself — that was the defect: a person's
 * dismissal and the agent's `remember` in the same window carried the state their
 * own reads saw, so the second one lost the compare-and-set and answered
 * `fact_moved` for a fact nobody had touched.
 */
function oneAtATime<T>(
  accountId: string,
  seed: () => Promise<MemoryStore>,
  work: (store: MemoryStore) => Promise<T>,
  /**
   * Read the store again for this link, whatever the chain holds. A person's
   * write is decided on **the document** it was shown (`movedSheet`), and the
   * account's state has moved since the pass's reading — a run writes its own
   * document beside the memory — so reusing that token refuses a correction
   * nobody touched.
   */
  fresh = false,
): Promise<T> {
  const previous = memoryWrites.get(accountId) ?? Promise.resolve();
  const link = async (): Promise<T> => {
    let held = fresh ? undefined : memoryStores.get(accountId);
    if (!held) {
      held = await seed();
      memoryStores.set(accountId, held);
    }
    return await work(held);
  };
  const next = previous.then(link, link);
  memoryWrites.set(
    accountId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * One link of the chain for a **person's** write: the store is read again.
 *
 * A person's write is decided on the document it was shown, and the state the
 * pass cached may be older than the run writes that moved the account since — so
 * the seed is taken rather than the cache, and a correction nobody raced lands.
 */
function personWrite<T>(
  accountId: string,
  seed: () => Promise<MemoryStore>,
  work: (store: MemoryStore) => Promise<T>,
): Promise<T> {
  return oneAtATime(accountId, seed, work, true);
}

/** A write's own view of the store, as it makes the writes it needs. */
interface Writer {
  token: string;
  entities: EntityDoc[];
  facts: FactDoc[];
  /** The entities whose document is on the account, not only projected. */
  onDisk: Set<string>;
}

async function writeFact(
  ctx: Ctx,
  accountId: string,
  write: FactWrite,
  store: MemoryStore,
): Promise<Applied<Remembered>> {
  const { subject, sentence } = checkedText(write.subject, write.fact, write.at);
  const predicate = normalizePredicate(write.predicate ?? "is");
  const writer: Writer = {
    token: store.state,
    entities: [...store.entities],
    facts: [...store.facts],
    onDisk: new Set(store.entitiesOnDisk),
  };
  /*
   * The first write into a memory the reading found empty may be the one that
   * makes the folder: the folder is made first, then the token is read, or the
   * write would be refused by the folder it just created.
   */
  if (!store.folder) {
    await ensureFolderPath(ctx, accountId, MEMORY_DIR);
    writer.token = await appFolderState(ctx, accountId);
  }
  const index = (): MemoryIndex => buildMemoryIndex(writer.entities, writer.facts);
  /*
   * The entity the fact is about: the one a name or an alias already identifies,
   * or the entity this fact creates (ADR 0038). Its document is written before
   * the fact that points at it, so a fact never names an entity nothing holds.
   */
  const entity = await ensureEntity(
    ctx,
    accountId,
    writer,
    subject,
    write.kind ?? "other",
    { by: "run", run: write.run },
    write.at,
  );
  const objectName = write.object?.trim();
  const object = objectName
    ? await ensureEntity(
        ctx,
        accountId,
        writer,
        objectName,
        "other",
        { by: "run", run: write.run },
        write.at,
      )
    : null;
  const value: FactValue = object ? { entity: object.id } : { text: sentence };
  const open = factsOf(index(), entity.id).filter(
    (fact) => fact.predicate === predicate && isOpen(fact),
  );
  const single = singleValued(predicate, value);
  /*
   * A person's word stands: what the agent concluded is written **beside** it as
   * a proposal (ADR 0033), and the sentence in force is left exactly as it is.
   * This is true of a contradiction as much as of a repeat — a person's fact is
   * not closed by the agent's.
   */
  const inForce = single ? open.find(isInForce) : undefined;
  if (inForce) {
    const proposed: FactDoc = {
      ...inForce,
      proposal: { fact: sentence, run: write.run, at: write.at },
    };
    await put(ctx, accountId, writer, factPath(proposed.id), proposed);
    return applied({ fact: proposed, entity }, writer);
  }
  const duplicate = single
    ? open.find((fact) => sameValue(fact.value, value))
    : undefined;
  if (duplicate) return applied({ fact: duplicate, entity, duplicate: true }, writer);
  /*
   * A store with no ceiling grows until every pass pays for it, and one entity
   * that never settles is a subject the agent keeps re-learning. Both caps are
   * refused loudly, naming what to remove; nothing is pruned or overwritten in
   * silence (owner decision 2026-10-18, ADR 0038).
   */
  if (writer.facts.length >= MEMORY_FACTS_MAX)
    throw new MemoryError(
      "memory_full",
      `The memory holds ${writer.facts.length} facts, its ceiling, so nothing was written. Remove a fact in Administration first.`,
      409,
    );
  const held = factsOf(index(), entity.id).length;
  if (held >= MEMORY_FACTS_PER_ENTITY)
    throw new MemoryError(
      "memory_full",
      `"${entity.name}" holds ${held} facts, its ceiling, so nothing was written. Remove one in Administration first.`,
      409,
    );
  /*
   * The fact it contradicts is **closed**, never overwritten: the older document
   * keeps its sentence and gains the instant it stopped being true, which is what
   * lets a later run answer "since when" (ADR 0038).
   */
  if (single)
    for (const fact of open)
      await put(ctx, accountId, writer, factPath(fact.id), {
        ...fact,
        validTo: write.at,
      });
  const doc: FactDoc = {
    v: MEMORY_VERSION,
    id: randomUUID(),
    entity: entity.id,
    predicate,
    value,
    fact: sentence,
    origin: { by: "run", run: write.run },
    at: write.at,
    validFrom: write.at,
    ...(write.vector?.length ? { vector: write.vector } : {}),
  };
  await put(ctx, accountId, writer, factPath(doc.id), doc);
  return applied({ fact: doc, entity }, writer);
}

/** What a write left, as the store is cached and the caller answered. */
function applied<T>(result: T, writer: Writer): Applied<T> {
  return {
    result,
    state: writer.token,
    entities: writer.entities,
    onDisk: [...writer.onDisk],
    facts: writer.facts,
  };
}

/**
 * The entity a name identifies, or the one this write creates — written before
 * the fact that points at it.
 *
 * A name that is an alias of an entity resolves to it, so a second spelling never
 * makes a second entity; an entity whose document on disk already carries the id
 * is left as it is, because the kind and the origin are the first fact's and a
 * later one does not re-decide them.
 */
async function ensureEntity(
  ctx: Ctx,
  accountId: string,
  writer: Writer,
  name: string,
  kind: EntityKind,
  origin: EntityDoc["origin"],
  at: string,
): Promise<EntityDoc> {
  const known = resolveEntity(buildMemoryIndex(writer.entities, writer.facts), name);
  /*
   * An entity whose document the account holds is left exactly as it is: the kind
   * and the origin are the first fact's, and a later one does not re-decide them.
   * One only **projected** from a sheet of an earlier version is written now — the
   * sheet it was projected from is about to be rewritten as this version, and a
   * fact must not be left naming an entity nothing holds.
   */
  if (known && writer.onDisk.has(known.id)) return known;
  const entity: EntityDoc = {
    ...(known ?? entityFromName(name, origin, at)),
    kind: known ? known.kind : kind,
  };
  await put(ctx, accountId, writer, entityPath(entity.id), entity);
  return entity;
}

/**
 * One document of the memory, against the token this write's chain carries.
 *
 * The document is kept in the writer's own list as it is written, so the next
 * question the same write asks — is this subject held, which fact did it
 * contradict — is answered without a second read of the account.
 */
async function put(
  ctx: Ctx,
  accountId: string,
  writer: Writer,
  path: string,
  doc: EntityDoc | FactDoc,
): Promise<void> {
  await writeAppFileAt(ctx, accountId, path, doc, {
    ifInState: writer.token,
    onState: (state) => {
      writer.token = state;
    },
  });
  if ("kind" in doc) {
    writer.entities = [...writer.entities.filter((one) => one.id !== doc.id), doc];
    writer.onDisk.add(doc.id);
  } else {
    writer.facts = [...writer.facts.filter((one) => one.id !== doc.id), doc];
  }
}

/**
 * Drop the agent's proposal against a person's fact, and nothing else.
 *
 * Dismissing is a person's answer to a proposal (ADR 0033): the document keeps
 * its sentence, its origin, its correction and its interval, and loses only the
 * words the agent concluded. A document that carries no proposal is already what
 * a dismissal leaves, so the answer is the document as it stands rather than a
 * refusal — a person pressing twice is not an error.
 */
export async function dismissProposal(
  ctx: Ctx,
  accountId: string,
  id: string,
  seen: MemoryStore,
): Promise<FactDoc> {
  return await personWrite(
    accountId,
    () => listMemory(ctx, accountId),
    async (held) => {
      const fact = held.facts.find((one) => one.id === id);
      if (!fact)
        throw new MemoryError(
          "fact_not_found",
          `The memory holds no fact called "${id}", so there is no proposal to dismiss. It was removed, or it was never there.`,
          404,
        );
      // The document the person read, against the one the memory holds now.
      if (movedSheet(seen, fact)) throw movedError();
      if (fact.proposal === undefined) return fact;
      const { proposal: _dismissed, ...rest } = fact;
      const state = await conditional((onState) =>
        writeAppFileAt(ctx, accountId, factPath(fact.id), rest, {
          ifInState: held.state,
          onState,
        }),
      );
      if (state)
        memoryStores.set(accountId, {
          ...held,
          state,
          facts: held.facts.map((one) => (one.id === fact.id ? rest : one)),
          index: buildMemoryIndex(
            held.entities,
            held.facts.map((one) => (one.id === fact.id ? rest : one)),
          ),
        });
      return rest;
    },
  );
}

/**
 * Run one conditional write of a document, and answer a lost compare-and-set as
 * this store's own refusal.
 */
async function conditional(
  write: (onState: (state: string) => void) => Promise<unknown>,
): Promise<string | null> {
  let produced: string | null = null;
  try {
    await write((state) => {
      produced = state;
    });
  } catch (err) {
    if (!isStateMismatch(err)) throw err;
    throw movedError();
  }
  return produced;
}

/** The 409 a write answers when the document it was decided on is not the one there. */
function movedError(): MemoryError {
  return new MemoryError(
    "fact_moved",
    "The memory changed after it was read, so nothing was written: read it again and say what you mean to change.",
    409,
  );
}

/**
 * Whether the document a person acted on is not the document the memory holds
 * now.
 *
 * The account's FileNode state cannot answer this: it moves with **any** write,
 * including one to a document the person never looked at. What is compared is the
 * one document, by its content.
 */
function movedSheet(seen: MemoryStore, held: FactDoc | undefined): boolean {
  if (!held) return true;
  const before = seen.facts.find((fact) => fact.id === held.id);
  if (!before) return false;
  return canonical(before) !== canonical(held);
}

/**
 * A value as text, with its object keys in one order.
 *
 * Two copies of one document are built by two code paths — the parser that reads
 * it back, and the cache a write leaves — and `JSON.stringify` says they differ
 * when they only spell the same fields in a different order. A document "moved"
 * means a field changed, so the comparison is on the content.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What a person says a fact is, correcting the document that is there. */
interface PersonCorrection {
  /** The document being corrected, by its id. */
  id: string;
  /** The entity it is about, in the person's own words. */
  subject: string;
  /** What they hold to be true of it, in one sentence. */
  fact: string;
  /** Who corrected it: the account the correction was made as. */
  who: string;
  /** When it was corrected, ISO 8601. */
  at: string;
}

/**
 * Correct a fact as a person, in place — and put it in force.
 *
 * The agent's own write does not touch a fact a person's word is in force on — it
 * is kept as a proposal beside it (`rememberFact`) — so this is where a
 * correction is made, and it is also what **accepts** a proposal: it replaces the
 * sentence, and the object of a relation when there is one, keeping the id, its
 * interval and its links to the entities it names. The proposal it answers is
 * dropped from the document it writes.
 *
 * A correction that renames the subject **moves the fact to that entity**,
 * creating it if the memory held nothing of that name: what a person stated is
 * true of the entity they named, and a panel that let them type a new name is not
 * editing a field nobody can see.
 *
 * What the document came from stays on it: a correction records **this** person
 * beside the origin and instant the document already carried, so a sentence a
 * person overruled still traces to the run that concluded it. The write is
 * decided on **the document the person read** and a correction made against a
 * stale copy is refused (`fact_moved`, 409).
 */
export async function correctFactByPerson(
  ctx: Ctx,
  accountId: string,
  edit: PersonCorrection,
  seen: MemoryStore,
): Promise<FactDoc> {
  return await personWrite(
    accountId,
    () => listMemory(ctx, accountId),
    async (opening) => {
      const held = opening.facts.find((fact) => fact.id === edit.id);
      if (!held)
        throw new MemoryError(
          "fact_not_found",
          `The memory holds no fact called "${edit.id}", so there is nothing to correct. It was removed, or it was never there.`,
          404,
        );
      // The document this correction was written against, not the account's state.
      if (movedSheet(seen, held)) throw movedError();
      if (!edit.who.trim())
        throw new MemoryError("fact_invalid", "A correction says who made it.", 400);
      const { subject, sentence } = checkedText(edit.subject, edit.fact, edit.at);
      const writer: Writer = {
        token: opening.state,
        entities: [...opening.entities],
        facts: [...opening.facts],
        onDisk: new Set(opening.entitiesOnDisk),
      };
      const entity = await ensureEntity(
        ctx,
        accountId,
        writer,
        subject,
        resolveEntity(opening.index, held.entity)?.kind ?? "other",
        { by: "person", who: edit.who },
        edit.at,
      );
      const doc: FactDoc = {
        ...held,
        entity: entity.id,
        value: "text" in held.value ? { text: sentence } : held.value,
        fact: sentence,
        correction: { by: "person", who: edit.who, at: edit.at },
      };
      delete doc.proposal;
      await put(ctx, accountId, writer, factPath(doc.id), doc);
      memoryStores.set(accountId, {
        ...opening,
        state: writer.token,
        entities: writer.entities,
        entitiesOnDisk: [...writer.onDisk],
        facts: writer.facts,
        index: buildMemoryIndex(writer.entities, writer.facts),
      });
      return doc;
    },
  );
}

/**
 * Take a fact out of the memory.
 *
 * A removal is the one write nothing brings back, so the caller is the one that
 * asks (the Administration surface, ADR 0033) and it is conditional on the state
 * its reading saw, like every other write here — a removal decided against a
 * stale list is refused (`fact_moved`, 409) rather than taking a fact that was
 * just corrected. A document that is not there is a refusal rather than a
 * success: the person was shown it, and "nothing to remove" is not what they were
 * told.
 */
export async function forgetFact(
  ctx: Ctx,
  accountId: string,
  id: string,
  seen: MemoryStore,
): Promise<void> {
  return await personWrite(
    accountId,
    () => listMemory(ctx, accountId),
    async (opening) => {
      const { file } = await findAppFileAt(ctx, accountId, factPath(id));
      if (!file?.id)
        throw new MemoryError(
          "fact_not_found",
          `The memory holds no fact called "${id}", so there is nothing to remove. It was removed, or it was never there.`,
          404,
        );
      // The document the person read, against what the memory holds now.
      if (
        movedSheet(
          seen,
          opening.facts.find((fact) => fact.id === id),
        )
      )
        throw movedError();
      const state = await conditional((onState) =>
        destroyAppNode(ctx, accountId, String(file.id), {
          ifInState: opening.state,
          onState,
        }),
      );
      if (state) {
        const facts = opening.facts.filter((fact) => fact.id !== id);
        memoryStores.set(accountId, {
          ...opening,
          state,
          facts,
          index: buildMemoryIndex(opening.entities, facts),
        });
      }
    },
  );
}

/**
 * One entity's facts over an interval, closed ones included — the "since when"
 * read (ADR 0038).
 *
 * The live retrieval ignores a closed fact; a run that asks when something
 * stopped being true is answered here, by entity and interval. The memory is read
 * again rather than trusted from the pass, because the question is about the past
 * as it stands now, and an entity the memory does not hold is refused by name.
 */
export async function readHistory(
  ctx: Ctx,
  accountId: string,
  name: string,
  interval: { from?: string; to?: string } = {},
): Promise<{ entity: EntityDoc; facts: FactView[] }> {
  const store = await listMemory(ctx, accountId);
  const entity = resolveEntity(store.index, name);
  if (!entity)
    throw new MemoryError(
      "entity_not_found",
      `The memory holds nothing about "${name}", so there is no history to read. It holds: ${
        store.entities
          .map((one) => one.name)
          .slice(0, 20)
          .join(", ") || "no entities yet"
      }.`,
      404,
    );
  return { entity, facts: historyOf(store.index, name, interval) };
}

/**
 * What one turn recalls, and which retrieval it used (ADR 0038).
 *
 * The change's words are embedded **only where the installation offers the
 * capability** — a check the provider block carries, like `tools` — and a
 * provider that cannot embed, or one that fails this call, leaves the retrieval
 * exact: what a run records is what it used, never what it hoped to use.
 */
export async function recallFor(
  access: ModelAccess | null,
  store: MemoryStore,
  words: string,
  meter?: UsageMeter,
): Promise<Recall> {
  const similarity =
    access?.model.embeddings && store.index.vectors.length && words.trim()
      ? await embedSimilarity(access, store, words, meter)
      : undefined;
  return recallMemory(store.index, {
    words,
    now: store.now,
    ...(similarity === undefined ? {} : { similarity }),
  });
}

/**
 * The change's words against the vectors the facts were written with.
 *
 * A transient failure of the embedding call is not a failed run: the retrieval
 * degrades to exact and says so on the record, which is what the capability check
 * exists for. No floor is applied here — the selection's is
 * (`RECALL_SIMILARITY_FLOOR`), one place.
 */
async function embedSimilarity(
  access: ModelAccess,
  store: MemoryStore,
  words: string,
  meter?: UsageMeter,
): Promise<Map<string, number> | undefined> {
  const embedded = await embedTexts(access, [words], meter);
  const vector = embedded?.[0];
  if (!vector) return undefined;
  return similarityOf(store.index, vector);
}
