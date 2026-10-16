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
  ensureFolderPath,
  fileChildren,
  readAppFileAt,
  writeAppFileAt,
} from "../appFolder.js";
import { CodedError, errorMessage } from "../shared/errors.js";
import {
  type FactDoc,
  MEMORY_FACT_MAX,
  MEMORY_SUBJECT_MAX,
  MEMORY_VERSION,
  parseFactDocumentDetailed,
  sameSubject,
} from "../shared/memory.js";
import { isInstant } from "../shared/run.js";

/** Where the installation's memory lives under the Master's app folder. */
export const MEMORY_DIR = "memory";

/**
 * A fact's document path, app-folder-relative.
 *
 * A fact's id is a file name and nothing else: a link names one, and an id
 * carrying a path separator would file the sheet in a folder of its own rather
 * than beside its siblings. `.` and `..` are refused by the same test, and by
 * `pathSegments` after it.
 */
export function factPath(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new MemoryError(
      "fact_id_invalid",
      `"${id}" is not a fact name: a fact is named by one plain file name.`,
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
 * The folder the sheets live in is **made before the token is read**, and not
 * left to the write that follows. Making it is a write, and one left to the
 * writer would move the account's state on after this reading had taken its
 * token: every write of an installation whose memory is new would be refused by
 * its own folder, for ever, one pass behind itself. The make is idempotent and
 * happens once — the folder is Gilbert's own, inside its own app folder — and a
 * caller of `recallFacts` never sees it.
 */
export async function listFacts(ctx: Ctx, accountId: string): Promise<MemoryStore> {
  const folderId = await ensureFolderPath(ctx, accountId, MEMORY_DIR);
  const state = await appFolderState(ctx, accountId);
  const facts: FactDoc[] = [];
  for (const node of await fileChildren(ctx, accountId, folderId)) {
    if (node.nodeType !== "file" || typeof node.name !== "string") continue;
    if (!node.name.endsWith(".json")) continue;
    const fact = await readFactDoc(ctx, accountId, node.name.slice(0, -".json".length));
    if (fact) facts.push(fact);
  }
  return { state, facts };
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
 * rather than overwritten: two turns that reached the same conclusion cannot
 * replace each other in silence, and the one that loses says so on its step. The
 * token is carried by a **create as well**, not only by a replace: two calls of
 * one answer both find a subject absent and both ask for its sheet, and the
 * second — same reading, same token — is refused rather than the memory holding
 * two spellings of one thing. A **person's** sheet is not replaced at all — a
 * person's fact is in force (ADR 0037) — and the refusal says so in a code.
 */
export async function rememberFact(
  ctx: Ctx,
  accountId: string,
  write: FactWrite,
  store: MemoryStore,
): Promise<FactDoc> {
  const subject = write.subject.trim();
  const sentence = write.fact.trim();
  if (!subject || !sentence)
    throw new MemoryError(
      "fact_invalid",
      "A fact needs the subject it is about and the sentence it holds true.",
      400,
    );
  if (subject.length > MEMORY_SUBJECT_MAX || sentence.length > MEMORY_FACT_MAX)
    throw new MemoryError(
      "fact_invalid",
      `A fact's subject is at most ${MEMORY_SUBJECT_MAX} characters and its sentence at most ${MEMORY_FACT_MAX}.`,
      400,
    );
  if (!isInstant(write.at))
    throw new MemoryError("fact_invalid", `"${write.at}" is not an instant.`, 400);

  const same = store.facts.find((fact) => sameSubject(fact.subject, subject));
  if (same?.origin.by === "person")
    throw new MemoryError(
      "fact_in_force",
      `A person holds the fact about "${same.subject}", and it is in force: this write leaves it exactly as it is, and what the agent concludes against it is proposed rather than written over.`,
      409,
    );
  const doc: FactDoc = {
    v: MEMORY_VERSION,
    id: same?.id ?? randomUUID(),
    subject,
    fact: sentence,
    origin: { by: "run", run: write.run },
    at: write.at,
    links: linkIds(store.facts, write.links ?? []),
    standing: write.standing === true,
  };
  await writeAppFileAt(ctx, accountId, factPath(doc.id), doc, {
    ifInState: store.state,
  });
  return doc;
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
