/**
 * The outbound documents on disk (ADR 0040).
 *
 * Every write is a read-modify-write under the account's compare-and-set: the
 * state token is taken **before** the document is read, so a write that lands in
 * between is refused instead of overwritten, and the act is retried. That is the
 * whole concurrency story — a campaign's list is one document every caller of it
 * writes, and two callers landing together are one retry apart.
 *
 * Nothing here decides policy: which row may be taken and what settling it means
 * are `rowActions.ts`, and what the queue offers is `queue.ts`.
 */

import {
  appFolderState,
  type Ctx,
  listAppSheets,
  readAppJsonAt,
  readAppJsonForWrite,
  writeAppFileAt,
} from "../appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import {
  type CampaignDoc,
  type CardCallsDoc,
  type CardIndexDoc,
  campaignFolderPath,
  campaignPath,
  cardCallsPath,
  cardIndexPath,
  type DoNotCallDoc,
  doNotCallPath,
  isCampaignDoc,
  isCardCallsDoc,
  isCardIndexDoc,
  isDoNotCallDoc,
  isRowsDoc,
  type RowCall,
  type RowDoc,
  type RowsDoc,
  rowsPath,
  windowCalls,
} from "../shared/outbound.js";
import { campaignMissing, OutboundError, requireState, rowMissing } from "./errors.js";

/**
 * How many attempts a campaign's list gets.
 *
 * One document holds a whole list, so two callers settling two rows of it collide
 * where two callers of two row files never did. A call takes minutes and a write
 * milliseconds, so a second or two of retries is enough for the callers a group
 * actually has on the phone at once.
 */
const ROWS_ATTEMPTS = 5;

/** The sentence an exhausted retry carries: the write did not land, and that is all it means. */
function writeFailed(what: string): OutboundError {
  return new OutboundError(
    "outbound_write_failed",
    `${what} could not be written: another write kept landing first. Try again.`,
    502,
  );
}

/**
 * A document that is there and cannot be read.
 *
 * Reading it as absent would overwrite it on the next act, and what it held — a
 * list, a promise not to call — would be gone without anybody deciding that. The
 * act refuses instead, and says which document it was.
 */
function unreadable(what: string): OutboundError {
  return new OutboundError(
    "outbound_unreadable",
    `${what} is there and cannot be read: nothing was changed.`,
    409,
  );
}

/**
 * Write one document under the compare-and-set, retried once.
 *
 * The token is taken before the write and never before a read: this is the
 * create-or-replace case, where there is no document whose version the caller's
 * decision depended on. `mutateAt` below is the other invariant and deliberately
 * not folded into this one — there the token must come *before* the read, or a
 * change that lands in between would be overwritten rather than refused.
 */
async function writeWithRetry(
  ctx: Ctx,
  accountId: string,
  path: string,
  doc: unknown,
  what: string,
): Promise<void> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = requireState(await appFolderState(ctx, accountId));
    try {
      await writeAppFileAt(ctx, accountId, path, doc, { ifInState: token });
      return;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  throw writeFailed(what);
}

async function readDoc<T>(
  ctx: Ctx,
  accountId: string,
  path: string,
  isDoc: (value: unknown) => value is T,
): Promise<T | null> {
  const doc = await readAppJsonAt(ctx, accountId, path);
  return isDoc(doc) ? doc : null;
}

/**
 * Change one document under the compare-and-set.
 *
 * The read, the rule and the write are one attempt: a change somebody else made
 * in between is a state mismatch, and the retry reads the document as they left
 * it.
 *
 * `start` is what a document that is not there yet is: a refusal for a campaign,
 * which only exists once somebody wrote it, and the empty list for a document
 * whose absence is its empty state. A document that **is** there and cannot be
 * read is neither: it is refused, because the next write would replace what
 * nobody could read.
 */
async function mutateAt<T>(
  ctx: Ctx,
  accountId: string,
  path: string,
  isDoc: (value: unknown) => value is T,
  start: () => T,
  mutate: (doc: T) => T,
  what: string,
  attempts: number = WRITE_ATTEMPTS,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const token = requireState(await appFolderState(ctx, accountId));
    const held = await readAppJsonForWrite(ctx, accountId, path);
    if (held.kind === "unreadable") throw unreadable(what);
    let doc: T;
    if (held.kind === "absent") doc = start();
    else if (isDoc(held.doc)) doc = held.doc;
    else throw unreadable(what);
    const next = mutate(doc);
    try {
      await writeAppFileAt(ctx, accountId, path, next, { ifInState: token });
      return next;
    } catch (err) {
      if (retryStateMismatch(err, attempt, attempts)) break;
    }
  }
  throw writeFailed(what);
}

/** What a folder of documents gave: the ones this build reads, and what it could not. */
export interface ReadAll<T> {
  docs: T[];
  /** One sentence per document that is there and cannot be read. */
  problems: string[];
}

async function readAll<T>(
  ctx: Ctx,
  accountId: string,
  dir: string,
  isDoc: (value: unknown) => value is T,
): Promise<ReadAll<T>> {
  const sheets = await listAppSheets<unknown>(
    ctx,
    accountId,
    dir,
    (_id, text) => JSON.parse(text) as unknown,
  );
  const docs: T[] = [];
  const problems: string[] = [];
  for (const sheet of sheets) {
    // Two different failures, told apart: the folder could not give the bytes, or
    // it gave bytes this build cannot read. Either way the document is named
    // rather than quietly leaving the list.
    if (sheet.problem !== null) {
      problems.push(`${sheet.id}: ${sheet.problem}`);
      continue;
    }
    if (!isDoc(sheet.doc)) {
      problems.push(`${sheet.id}: this build cannot read it`);
      continue;
    }
    docs.push(sheet.doc);
  }
  return { docs, problems };
}

/** One campaign, or null when it is not there or this build cannot read it. */
export async function readCampaign(
  ctx: Ctx,
  accountId: string,
  uid: string,
): Promise<CampaignDoc | null> {
  return readDoc(ctx, accountId, campaignPath(uid), isCampaignDoc);
}

/** One row of a campaign, or null when it is not there. */
export async function readRow(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
  rowUid: string,
): Promise<RowDoc | null> {
  const held = await readAppJsonForWrite(ctx, accountId, rowsPath(campaignUid));
  if (held.kind === "absent") return null;
  if (held.kind === "unreadable" || !isRowsDoc(held.doc))
    throw unreadable(`The list of campaign "${campaignUid}"`);
  return held.doc.rows.find((row) => row.uid === rowUid) ?? null;
}

/** Every campaign of the account, oldest first, and what could not be read. */
export async function listCampaigns(
  ctx: Ctx,
  accountId: string,
): Promise<ReadAll<CampaignDoc>> {
  const { docs, problems } = await readAll(
    ctx,
    accountId,
    campaignFolderPath(),
    isCampaignDoc,
  );
  return { docs: docs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), problems };
}

/**
 * A campaign's list, and what could not be read of it.
 *
 * A list nobody has filled has no document, and that is an empty list rather than
 * a broken one. One that is there and cannot be read is named, because a list that
 * silently reads as empty is a campaign whose numbers disappeared.
 */
export async function readRows(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
): Promise<ReadAll<RowDoc>> {
  const path = rowsPath(campaignUid);
  const held = await readAppJsonForWrite(ctx, accountId, path);
  if (held.kind === "absent") return { docs: [], problems: [] };
  if (held.kind === "unreadable" || !isRowsDoc(held.doc))
    return { docs: [], problems: [`${path}: this build cannot read it`] };
  // A row carrying another campaign's uid would be worked in a list it does not
  // belong to, and its own campaign would never offer it.
  if (held.doc.rows.some((row) => row.campaignUid !== campaignUid))
    return { docs: [], problems: [`${path}: it holds a row of another campaign`] };
  return { docs: held.doc.rows, problems: [] };
}

/** Write a campaign as it stands. */
export async function writeCampaign(
  ctx: Ctx,
  accountId: string,
  doc: CampaignDoc,
): Promise<void> {
  await writeWithRetry(
    ctx,
    accountId,
    campaignPath(doc.uid),
    doc,
    `The campaign "${doc.uid}"`,
  );
}

/** Change one campaign under the compare-and-set. */
export async function mutateCampaign(
  ctx: Ctx,
  accountId: string,
  uid: string,
  mutate: (doc: CampaignDoc) => CampaignDoc,
): Promise<CampaignDoc> {
  return mutateAt(
    ctx,
    accountId,
    campaignPath(uid),
    isCampaignDoc,
    () => {
      throw campaignMissing(uid);
    },
    mutate,
    `The campaign "${uid}"`,
  );
}

/**
 * Change a campaign's list under the compare-and-set.
 *
 * The whole list is one document, so an act that touches one row rewrites the
 * list — and the retry is the price: the caller who lost a race re-reads the list
 * as the winner left it and applies its own rule to that.
 */
export async function mutateRows(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
  mutate: (rows: RowDoc[]) => RowDoc[],
): Promise<RowDoc[]> {
  const next = await mutateAt<RowsDoc>(
    ctx,
    accountId,
    rowsPath(campaignUid),
    isRowsDoc,
    () => ({ version: 1, rows: [] }),
    (doc) => ({ ...doc, rows: mutate(doc.rows) }),
    `The list of campaign "${campaignUid}"`,
    ROWS_ATTEMPTS,
  );
  return next.rows;
}

/** Change one row of a campaign under the compare-and-set. */
export async function mutateRow(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
  rowUid: string,
  mutate: (row: RowDoc) => RowDoc,
): Promise<RowDoc> {
  let changed: RowDoc | undefined;
  await mutateAt<RowsDoc>(
    ctx,
    accountId,
    rowsPath(campaignUid),
    isRowsDoc,
    () => ({ version: 1, rows: [] }),
    (doc) => {
      const index = doc.rows.findIndex((row) => row.uid === rowUid);
      if (index < 0) throw rowMissing(campaignUid, rowUid);
      changed = mutate(doc.rows[index]);
      const rows = doc.rows.slice();
      rows[index] = changed;
      return { ...doc, rows };
    },
    `The list of campaign "${campaignUid}"`,
    ROWS_ATTEMPTS,
  );
  if (!changed) throw rowMissing(campaignUid, rowUid);
  return changed;
}

/** The card index as it stands, or null when none was built yet. */
export async function readCardIndexDoc(
  ctx: Ctx,
  accountId: string,
): Promise<CardIndexDoc | null> {
  return readDoc(ctx, accountId, cardIndexPath(), isCardIndexDoc);
}

/** Write the card index as it was just built. */
export async function writeCardIndex(
  ctx: Ctx,
  accountId: string,
  doc: CardIndexDoc,
): Promise<void> {
  await writeWithRetry(ctx, accountId, cardIndexPath(), doc, "The card index");
}

/** The calls a card carries, or an empty window when none was written yet. */
export async function readCardCalls(
  ctx: Ctx,
  accountId: string,
  cardUid: string,
): Promise<CardCallsDoc> {
  const doc = await readDoc(ctx, accountId, cardCallsPath(cardUid), isCardCallsDoc);
  return (
    doc ?? {
      version: 1,
      cardUid,
      calls: [],
      trimmed: 0,
      updatedAt: new Date(0).toISOString(),
    }
  );
}

/** Add one call to a card's log, keeping the window the row keeps. */
export async function appendCardCall(
  ctx: Ctx,
  accountId: string,
  cardUid: string,
  call: RowCall,
): Promise<CardCallsDoc> {
  return mutateAt(
    ctx,
    accountId,
    cardCallsPath(cardUid),
    isCardCallsDoc,
    () => ({
      version: 1 as const,
      cardUid,
      calls: [],
      trimmed: 0,
      updatedAt: new Date(0).toISOString(),
    }),
    (doc) => {
      const { calls, dropped } = windowCalls(doc.calls, call);
      return {
        ...doc,
        calls,
        trimmed: doc.trimmed + dropped,
        updatedAt: new Date().toISOString(),
      };
    },
    `The calls of card "${cardUid}"`,
  );
}

/** A list nobody has written yet: the state the group starts from. */
function emptyDoNotCall(): DoNotCallDoc {
  return { version: 1, numbers: [], updatedAt: new Date(0).toISOString() };
}

/** The group's do-not-call list, or an empty one when none was written yet. */
export async function readDoNotCall(ctx: Ctx, accountId: string): Promise<DoNotCallDoc> {
  const doc = await readDoc(ctx, accountId, doNotCallPath(), isDoNotCallDoc);
  return doc ?? emptyDoNotCall();
}

/** Change the group's do-not-call list under the compare-and-set. */
export async function mutateDoNotCall(
  ctx: Ctx,
  accountId: string,
  mutate: (doc: DoNotCallDoc) => DoNotCallDoc,
): Promise<DoNotCallDoc> {
  return mutateAt(
    ctx,
    accountId,
    doNotCallPath(),
    isDoNotCallDoc,
    emptyDoNotCall,
    mutate,
    "The do-not-call list",
  );
}
