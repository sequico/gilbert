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
 * JMAP offers no lock, so a replace carries the account's FileNode state as
 * `ifInState` (`appFolder.ts`), and the token is read **before** the sheet: a
 * write landing between the two advances the state past the token, so a
 * replace carrying it is refused rather than overwriting a change this read
 * never saw.
 */

import { randomUUID } from "node:crypto";
import {
  appFolderState,
  type Ctx,
  listAppDir,
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
 * The whole memory, each fact with the token a replace of it needs.
 *
 * The selection is made from this list (`recallFacts`), and the write asks it
 * the same question the selection does — is this subject already held — so one
 * read answers both. A sheet that cannot be read is **reported**, never
 * skipped: it is one fact the installation can no longer see, and a listing
 * that hid it would answer "this is what I know" about a store it could not
 * read.
 */
export async function listFacts(ctx: Ctx, accountId: string): Promise<FactRecord[]> {
  const state = await appFolderState(ctx, accountId);
  const records: FactRecord[] = [];
  for (const node of await listAppDir(ctx, accountId, MEMORY_DIR)) {
    if (node.nodeType !== "file" || typeof node.name !== "string") continue;
    if (!node.name.endsWith(".json")) continue;
    const fact = await readFactDoc(ctx, accountId, node.name.slice(0, -".json".length));
    if (fact) records.push({ fact, state });
  }
  return records;
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
 * The write is conditional on the token the listing read when it is replacing a
 * sheet the agent wrote, so two turns that reached the same conclusion cannot
 * overwrite each other in silence: the second is refused and the caller's own
 * retry, if any, re-reads. A **person's** sheet is not replaced at all — a
 * person's fact is in force (ADR 0037) — and the refusal says so in a code.
 */
export async function rememberFact(
  ctx: Ctx,
  accountId: string,
  write: FactWrite,
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

  const held = await listFacts(ctx, accountId);
  const same = held.find(({ fact }) => sameSubject(fact.subject, subject));
  if (same?.fact.origin.by === "person")
    throw new MemoryError(
      "fact_in_force",
      `A person holds the fact about "${same.fact.subject}", and it is in force: this write leaves it exactly as it is, and what the agent concludes against it is proposed rather than written over.`,
      409,
    );
  const doc: FactDoc = {
    v: MEMORY_VERSION,
    id: same?.fact.id ?? randomUUID(),
    subject,
    fact: sentence,
    origin: { by: "run", run: write.run },
    at: write.at,
    links: linkIds(held, write.links ?? []),
    standing: write.standing === true,
  };
  await writeAppFileAt(
    ctx,
    accountId,
    factPath(doc.id),
    doc,
    same ? { ifInState: same.state } : {},
  );
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
function linkIds(held: readonly FactRecord[], subjects: readonly string[]): string[] {
  const ids: string[] = [];
  for (const subject of subjects) {
    const found = held.find(({ fact }) => sameSubject(fact.subject, subject));
    if (!found)
      throw new MemoryError(
        "link_unknown",
        `The memory holds no fact about "${subject}", so nothing links to it.`,
        400,
      );
    if (!ids.includes(found.fact.id)) ids.push(found.fact.id);
  }
  return ids;
}
