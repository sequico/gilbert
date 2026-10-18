/**
 * The one place a fact is addressed (ADR 0037).
 *
 * A fact is one document named `<id>.json` under `memory/` in the **Master's
 * own account** — the installation's memory, one for the installation wherever
 * the run that recalls it lives, read by every group's agent because a decision
 * taken in one group is better when it knows what the rest of the installation
 * knows. The shape, its parser and the selection a call carries are
 * `@gilbert/shared/memory`; what lives here is where the sheet is, how the
 * store is read, and the one write the agent makes.
 *
 * **A person's fact is in force.** The write refuses to replace a sheet whose
 * origin is a person — correcting one is the surface's to do (ADR 0037) — and
 * the refusal is a code a caller composes a sentence from. A sheet the agent
 * wrote itself is replaced in place, keeping its id, so the links that point at
 * it keep pointing at it and the memory does not fill with a second spelling of
 * one thing.
 *
 * The **person's** two writes are at the foot of this file and are not that one:
 * a correction (`correctFactByPerson`) replaces whatever is there — the agent's
 * sheet or another person's — and records the person's own name beside the
 * origin the sheet already had, which is what puts the corrected fact in force
 * from that moment while keeping the run it came from on the sheet; a removal
 * (`forgetFact`) takes a sheet away. Both are the surface's to make, and both go
 * through this module so that addressing a fact, reading its sheet and refusing
 * a name it cannot file stay in one place.
 *
 * **A sheet this build's parser would refuse is never written**, so the store
 * and its reader cannot disagree about what a fact is.
 *
 * **One reading answers a whole pass.** The store is read once per pass
 * (`MemoryStore`, `agent/loop.ts`) and that one reading answers both the
 * selection a call carries and the write the agent makes, so a large memory is
 * not walked again for every change; the price is stated where the reading is
 * handed over.
 *
 * JMAP offers no lock, so a write of the store carries the account's FileNode
 * state as `ifInState` (`appFolder.ts`) — a **create** as much as a replace — and
 * the token is read **before** the sheets: a write landing between the two
 * advances the state past the token, so a write carrying it is refused rather
 * than overwriting a change this read never saw, and two writes that both found
 * a subject absent cannot both make a sheet for it.
 */

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
  type FactDoc,
  isInForce,
  MEMORY_FACT_MAX,
  MEMORY_VERSION,
  parseFactDocumentDetailed,
  sameSubject,
  subjectProblem,
} from "../shared/memory.js";

/** Where the installation's memory lives under the Master's app folder. */
export const MEMORY_DIR = "memory";

/** How many fact sheets the installation's memory may hold. */
export const MEMORY_FACTS_MAX = 5_000;

/**
 * A fact's document path, app-folder-relative.
 *
 * A fact's id is a file name and nothing else: a link names one, and an id
 * carrying a path separator would file the sheet in a folder of its own rather
 * than beside its siblings. `.` and `..` are refused by the same test, and by
 * `pathSegments` after it. A name this store cannot file is the caller's own
 * mistake, so it is refused as one (400) rather than as a mail-server fault.
 */
export function factPath(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new MemoryError(
      "fact_id_invalid",
      `"${id}" is not a fact name: a fact is named by one plain file name.`,
      400,
    );
  return `${MEMORY_DIR}/${id}.json`;
}

/**
 * A fact this build cannot use.
 *
 * The code is what a surface composes its own sentence from, as `RunError` is
 * for runs: a sheet that cannot be read, a link the memory holds nothing for,
 * and the one refusal the write is built on — a person's fact, which is in
 * force.
 */
export class MemoryError extends CodedError {
  constructor(code: string, message: string, status = 502) {
    super(code, message, status, "MemoryError");
  }
}

/** A fact together with the compare-and-set token its read saw. */
export interface FactRecord {
  fact: FactDoc;
  /** The FileNode state at read time: pass it as `ifInState` to replace. */
  state: string;
}

/**
 * The installation's memory as one reading of it saw it (ADR 0037).
 *
 * `state` is the account's FileNode state at the moment of the read — the token
 * **every** write of the store carries, so a write that lost the race is refused
 * rather than overwriting a change its read never saw — and `facts` are the
 * sheets themselves, in the order the folder listed them.
 *
 * The store is read **once per pass**, and that one reading answers both the
 * selection a call carries and the one write the agent makes
 * (`agent/loop.ts`), so a store of many thousands of facts is not walked again
 * for every change in the pass, nor again for every write. What that costs is
 * written down where it is paid: a fact written during a pass is visible to the
 * **next** pass and not to the pass that wrote it, and a second write of the same
 * pass carries the same token, so it loses the compare-and-set and says so on its
 * step rather than overwriting what the first one wrote.
 */
export interface MemoryStore {
  state: string;
  facts: FactDoc[];
  /**
   * Whether the memory folder existed when this read happened. A first write
   * into a folder this read did not find has to make it, which moves the state
   * the read answered; the writer then takes a fresh one.
   */
  folder: boolean;
  /**
   * Sheets this build cannot read, each with its path and the reason. They are
   * **reported, never skipped and never fatal**: one bad sheet must not stop
   * every group's pass, so the readable facts are answered beside the problem.
   */
  problems: string[];
}

function unreadable(path: string, why: string): MemoryError {
  return new MemoryError(
    "fact_unreadable",
    `The fact at ${path} is not readable: ${why} It has been left exactly as it is.`,
  );
}

/**
 * One fact's sheet by id, or null when there is none.
 *
 * A document that is there with bytes that do not come back is unreadable, not
 * absent, and a sheet the parser refuses is a defect the caller reports: the
 * alternative is a fact the agent reasons from and nobody explains.
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
 * The whole memory, as one reading of it (ADR 0037): the sheets, and the token
 * a write of the store carries.
 *
 * The selection is made from `facts` (`recallFacts`), and the write asks that
 * same list the questions the selection asks — is this subject already held,
 * which ids do these subjects name — so one read of the store answers both. A
 * sheet that cannot be read is **reported**, never skipped: it is one fact the
 * installation can no longer see, and a listing that hid it would answer "this
 * is what I know" about a store it could not read.
 *
 * The walk is `listAppSheets`, as the runs' is: the store is read once per pass
 * and a pass every ten seconds, so a sheet whose stamp has not moved is not
 * downloaded again, and what a pass reads is the sheets that changed since the
 * last one. **Growth is not bounded here**, and that is what this reader is
 * honest about: one document per fact and nothing prunes them, and every write
 * spends a blob JMAP offers no way to reclaim (`appFolder.ts`), so a memory that
 * grows costs the account's upload quota for good rather than costing a pass. The
 * ceiling a call carries bounds what is *recalled* (`shared/memory.ts`), not how
 * many sheets the store holds; pruning is a person's decision, taken from
 * Administration, and nothing does it on its own.
 *
 * The folder the sheets live in is **made before the token is read**, and not
 * left to the write that follows. Making it is a write, and one left to the
 * writer would move the account's state on after this reading had taken its
 * token: every write of an installation whose memory is new would be refused by
 * its own folder, for ever, one pass behind itself. The make is idempotent and
 * happens once — the folder is Gilbert's own, inside its own app folder — and a
 * caller of `recallFacts` never sees it.
 */
export async function listFacts(ctx: Ctx, accountId: string): Promise<MemoryStore> {
  // The folder is made by the first write, never by a read: a pass is a read,
  // and a read that creates a folder moves the account state under every writer.
  const folder = await findFolderPath(ctx, accountId, MEMORY_DIR);
  const state = await appFolderState(ctx, accountId);
  const facts: FactDoc[] = [];
  const problems: string[] = [];
  for (const row of await listAppSheets(ctx, accountId, MEMORY_DIR, parseFact)) {
    if (row.problem) problems.push(row.problem);
    else if (row.doc) facts.push(row.doc);
  }
  return { state, facts, problems, folder: folder !== null };
}

/**
 * One fact's sheet, from its bytes, or the refusal this build answers with.
 *
 * The one place a sheet's bytes become a fact — the same refusal the single read
 * below carries, so the two readers of the store say the same thing about the
 * same document.
 */
function parseFact(id: string, text: string): FactDoc {
  const parsed = parseFactDocumentDetailed(text);
  if ("problem" in parsed) throw unreadable(factPath(id), parsed.problem);
  if (parsed.fact.id !== id)
    throw unreadable(factPath(id), `it names the fact "${parsed.fact.id}".`);
  return parsed.fact;
}

/**
 * The subject and sentence one write states, trimmed and checked.
 *
 * The one answer to "is this something a sheet can hold", shared by the agent's
 * write and a person's correction: the rules are the document's own
 * (`shared/memory.ts`'s bounds) and a writer that spelled them out again would
 * be a second place they could drift.
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

/** What the agent says while it works, for the one write below (ADR 0037). */
export interface FactWrite {
  /** What the fact is about, in the group's own words. */
  subject: string;
  /** What the agent holds true of it, in one sentence. */
  fact: string;
  /** The run that is writing it. */
  run: string;
  /** When it is written, ISO 8601. */
  at: string;
  /**
   * The group the fact is about: the account of the run that writes it.
   *
   * It is what the standing set is filtered by — a fact marked `standing` is
   * carried by every call of this group and of no other — while every fact is
   * recalled by its subject for any group (ADR 0037).
   */
  group: string;
  /** The **subjects** of the facts it is linked to, resolved to their ids. */
  links?: readonly string[];
  /** Whether every call of the group should carry it. */
  standing?: boolean;
}

/**
 * Write one fact the agent came to hold, replacing its own sheet about the same
 * subject and refusing a person's.
 *
 * The write is made **against a reading of the store** that the caller hands in
 * — the pass's one reading (ADR 0037) — and both the sheet it replaces and the
 * token it carries come from that reading, so a write landing since is refused
 * rather than overwritten. A refusal is not the end of the write: the store is
 * read once per pass, so the first write of a pass moves the state every later
 * one carries, and a second `memory.remember` — another run of the same pass, or
 * another call of one answer — would lose against its own pass. The refusal is
 * answered by reading the memory again and deciding again: a subject the other
 * call created is then **updated in its sheet**, not duplicated, and the pass's
 * reading is moved forward for whatever comes next. The sheet records the
 * **group it is about** (`FactWrite.group`, the run's own account): that is what
 * its `standing` mark is filtered by, so a fact a group keeps about itself is
 * carried by that group's calls and not by another's. A **person's** sheet is
 * not replaced at all — a person's fact is in force (ADR 0037) — and the
 * refusal says so in a code.
 */
export async function rememberFact(
  ctx: Ctx,
  accountId: string,
  write: FactWrite,
  store: MemoryStore,
): Promise<FactDoc> {
  try {
    return await writeFact(ctx, accountId, write, store);
  } catch (err) {
    if (!isStateMismatch(err)) throw err;
    const fresh = await listFacts(ctx, accountId);
    /*
     * A person's sheet is never written against words this call did not read:
     * the memory moved because a person corrected it, and the agent's proposal
     * has to be concluded against the correction. Everything else — a subject
     * another call of this pass created, or a sheet of the agent's own that
     * moved on — is decided again against the fresh reading.
     */
    const sameNow = fresh.facts.find((fact) => sameSubject(fact.subject, write.subject));
    if (sameNow && isInForce(sameNow)) throw err;
    return await writeFact(ctx, accountId, write, fresh);
  }
}

async function writeFact(
  ctx: Ctx,
  accountId: string,
  write: FactWrite,
  store: MemoryStore,
): Promise<FactDoc> {
  const { subject, sentence } = checkedText(write.subject, write.fact, write.at);
  /*
   * The first write into a memory the reading found empty may be the one that
   * makes the folder: the folder is made first, then the token is read, or the
   * write would be refused by the folder it just created.
   */
  let token = store.state;
  if (!store.folder) {
    await ensureFolderPath(ctx, accountId, MEMORY_DIR);
    token = await appFolderState(ctx, accountId);
  }
  const same = store.facts.find((fact) => sameSubject(fact.subject, subject));
  if (same && isInForce(same)) {
    /*
     * A person's word stands: what the agent concluded is written **beside** it
     * as a proposal (ADR 0037), and the sentence in force is left exactly as it
     * is. A person reads the proposal in Administration and either accepts it —
     * which is `correctFactByPerson` with those words, and that write clears the
     * proposal — or dismisses it, which leaves the sheet as it was.
     */
    const proposed: FactDoc = {
      ...same,
      proposal: { fact: sentence, run: write.run, at: write.at },
    };
    await writeAppFileAt(ctx, accountId, factPath(proposed.id), proposed, {
      ifInState: token,
    });
    return proposed;
  }
  /*
   * A store with no ceiling grows until every pass pays for it (owner decision
   * 2026-10-18, audit finding 5). A new subject is refused once the store is at
   * its limit; a person removes facts from Administration, and nothing is
   * pruned or overwritten in silence.
   */
  if (!same && store.facts.length >= MEMORY_FACTS_MAX)
    throw new MemoryError(
      "memory_full",
      `The memory holds ${store.facts.length} facts, its ceiling, so nothing was written. Remove a fact in Administration first.`,
      409,
    );
  const doc: FactDoc = {
    v: MEMORY_VERSION,
    id: same?.id ?? randomUUID(),
    subject,
    fact: sentence,
    origin: { by: "run", run: write.run },
    at: write.at,
    /*
     * A rewrite that does not restate a mark or a link keeps the one the sheet
     * carries: both are optional, and a later sentence about the same subject
     * must not silently stop being carried by every call of the group, or lose
     * the facts it was tied to.
     */
    links:
      write.links === undefined ? (same?.links ?? []) : linkIds(store.facts, write.links),
    standing: write.standing ?? same?.standing ?? false,
    group: write.group,
  };
  await writeAppFileAt(ctx, accountId, factPath(doc.id), doc, { ifInState: token });
  return doc;
}

/**
 * Drop the agent's proposal against a person's fact, and nothing else.
 *
 * Dismissing is a person's answer to a proposal (ADR 0037): the sheet keeps its
 * sentence, its origin, its correction and its links, and loses only the words
 * the agent concluded. A sheet that carries no proposal is already what a
 * dismissal leaves, so the answer is the sheet as it stands rather than a
 * refusal — a person pressing twice is not an error.
 */
export async function dismissProposal(
  ctx: Ctx,
  accountId: string,
  id: string,
  store: MemoryStore,
): Promise<FactDoc> {
  const held = store.facts.find((fact) => fact.id === id);
  if (!held)
    throw new MemoryError(
      "fact_not_found",
      `The memory holds no fact called "${id}", so there is no proposal to dismiss. It was removed, or it was never there.`,
      404,
    );
  if (held.proposal === undefined) return held;
  const { proposal: _dismissed, ...rest } = held;
  await conditional(() =>
    writeAppFileAt(ctx, accountId, factPath(held.id), rest, { ifInState: store.state }),
  );
  return rest;
}

/**
 * The ids the links of one write name, or a refusal.
 *
 * A link is written by its **subject** because that is what the agent knows —
 * a sheet's id is not part of what a call is shown — and a subject the memory
 * holds nothing for is refused rather than dropped: a link silently missing
 * from the graph is a fact the next selection will not find, and nobody would
 * see why.
 */
function linkIds(held: readonly FactDoc[], subjects: readonly string[]): string[] {
  const ids: string[] = [];
  for (const subject of subjects) {
    const found = held.find((fact) => sameSubject(fact.subject, subject));
    if (!found)
      throw new MemoryError(
        "link_unknown",
        `The memory holds no fact about "${subject}", so nothing links to it.`,
        400,
      );
    if (!ids.includes(found.id)) ids.push(found.id);
  }
  return ids;
}

/**
 * Run one conditional write of a sheet, and answer a lost compare-and-set as
 * this store's own refusal.
 *
 * `ifInState` is the account's FileNode state the reading carried, so
 * `stateMismatch` means the memory moved after the list a person decided
 * against was read: nothing was written, and the answer is the store's own code
 * at 409 rather than the raw upstream refusal, which names neither the surface
 * nor the document.
 */
async function conditional(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (!isStateMismatch(err)) throw err;
    throw new MemoryError(
      "fact_moved",
      "The memory changed after it was read, so nothing was written: read it again and say what you mean to change.",
      409,
    );
  }
}

/** What a person says a fact is, correcting the sheet that is there. */
export interface PersonCorrection {
  /** The sheet being corrected, by its id. */
  id: string;
  /** What the fact is about, in the person's own words. */
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
 * The agent's own write does not touch a fact whose word is a person's — it is
 * kept as a proposal beside it (`rememberFact` above) — so this is where a
 * correction is made, and it is also what **accepts** a proposal: it replaces
 * whatever is there — the agent's sheet or another person's — keeping the id, so
 * every link that pointed at it still does, and the proposal it answers is
 * dropped from the sheet it writes. What the sheet
 * came from stays on it: a correction records **this** person beside the origin
 * and instant the sheet already carried, so a sentence a person overruled still
 * traces to the run that concluded it and that run's date, while the correction
 * says who overruled it and when. From that moment the fact is in force, and the
 * agent's next conclusion about the subject is a proposal rather than a
 * correction.
 *
 * The write is made against the **store's reading**, exactly as the agent's own
 * is: the token that reading carries is the compare-and-set, so a correction
 * made against a stale list is refused rather than landing over a fact the
 * writer never saw — and refused in this store's own code, `fact_moved` at 409,
 * because a person's write has no step to report the raw upstream refusal on.
 * The graph is left as it was — links, the standing mark and the group it is
 * about — because those are the agent's bookkeeping and a person correcting what
 * is held true is not re-deciding where it hangs from; a subject that names a
 * subject already held is refused rather than making the memory hold two
 * spellings of one thing.
 */
export async function correctFactByPerson(
  ctx: Ctx,
  accountId: string,
  edit: PersonCorrection,
  store: MemoryStore,
): Promise<FactDoc> {
  const held = store.facts.find((fact) => fact.id === edit.id);
  if (!held)
    throw new MemoryError(
      "fact_not_found",
      `The memory holds no fact called "${edit.id}", so there is nothing to correct. It was removed, or it was never there.`,
      404,
    );
  if (!edit.who.trim())
    throw new MemoryError("fact_invalid", "A correction says who made it.", 400);
  const { subject, sentence } = checkedText(edit.subject, edit.fact, edit.at);
  const clash = store.facts.find(
    (fact) => fact.id !== held.id && sameSubject(fact.subject, subject),
  );
  if (clash)
    throw new MemoryError(
      "fact_invalid",
      `The memory already holds a fact about "${clash.subject}", and one subject is one sheet: remove that one first, or correct this one without renaming it.`,
      409,
    );
  const doc: FactDoc = {
    v: MEMORY_VERSION,
    id: held.id,
    subject,
    fact: sentence,
    origin: held.origin,
    at: held.at,
    correction: { by: "person", who: edit.who, at: edit.at },
    links: held.links,
    standing: held.standing,
    group: held.group,
  };
  await conditional(() =>
    writeAppFileAt(ctx, accountId, factPath(doc.id), doc, { ifInState: store.state }),
  );
  return doc;
}

/**
 * Take a fact out of the memory.
 *
 * A removal is the one write nothing brings back: a fact the agent learned and
 * that everybody's next call carries is gone with the sheet, so the caller is the
 * one that asks (the Administration surface, ADR 0037) and it is conditional on
 * the state its reading saw, like every other write here — a removal decided
 * against a stale list is refused (`fact_moved`, 409) rather than taking a fact
 * that was just corrected. A sheet that is not there is a refusal rather than a
 * success: the person was shown it, and "nothing to remove" is not what they
 * were told.
 */
export async function forgetFact(
  ctx: Ctx,
  accountId: string,
  id: string,
  ifInState: string,
): Promise<void> {
  const { file } = await findAppFileAt(ctx, accountId, factPath(id));
  if (!file?.id)
    throw new MemoryError(
      "fact_not_found",
      `The memory holds no fact called "${id}", so there is nothing to remove. It was removed, or it was never there.`,
      404,
    );
  await conditional(() => destroyAppNode(ctx, accountId, String(file.id), { ifInState }));
}
