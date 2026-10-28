/**
 * The outbound documents on disk (ADR 0040).
 *
 * Every write is a read-modify-write under the account's compare-and-set: the
 * state token is taken **before** the document is read, so a write that lands in
 * between is refused instead of overwritten, and the act is retried once. That is
 * the whole concurrency story — two callers of one list touch different rows, and
 * two callers of one row are one refusal apart.
 *
 * Nothing here decides policy: which row may be taken and what settling it means
 * are `rowActions.ts`, and what the queue offers is `queue.ts`.
 */

import {
  appFolderState,
  type Ctx,
  listAppSheets,
  readAppJsonAt,
  writeAppFileAt,
} from "../appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import {
  type CampaignDoc,
  campaignFolderPath,
  campaignPath,
  type DoNotCallDoc,
  doNotCallPath,
  isCampaignDoc,
  isDoNotCallDoc,
  isRowDoc,
  type RowDoc,
  rowFolderPath,
  rowPath,
} from "../shared/outbound.js";
import { OutboundError, requireState } from "./errors.js";

/** The sentence an exhausted retry carries: the write did not land, and that is all it means. */
function writeFailed(what: string): OutboundError {
  return new OutboundError(
    "outbound_write_failed",
    `${what} could not be written: another write kept landing first. Try again.`,
    502,
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
 */
async function mutateAt<T>(
  ctx: Ctx,
  accountId: string,
  path: string,
  isDoc: (value: unknown) => value is T,
  missing: () => OutboundError,
  mutate: (doc: T) => T,
  what: string,
): Promise<T> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = requireState(await appFolderState(ctx, accountId));
    const doc = await readDoc(ctx, accountId, path, isDoc);
    if (!doc) throw missing();
    const next = mutate(doc);
    try {
      await writeAppFileAt(ctx, accountId, path, next, { ifInState: token });
      return next;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
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
  return readDoc(ctx, accountId, rowPath(campaignUid, rowUid), isRowDoc);
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

/** Every row of a campaign, and what could not be read. */
export async function readRows(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
): Promise<ReadAll<RowDoc>> {
  return readAll(ctx, accountId, rowFolderPath(campaignUid), isRowDoc);
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
    () => new OutboundError("outbound_not_found", `No campaign "${uid}" is there.`, 404),
    mutate,
    `The campaign "${uid}"`,
  );
}

/** Change one row under the compare-and-set. */
export async function mutateRow(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
  rowUid: string,
  mutate: (doc: RowDoc) => RowDoc,
): Promise<RowDoc> {
  return mutateAt(
    ctx,
    accountId,
    rowPath(campaignUid, rowUid),
    isRowDoc,
    () =>
      new OutboundError(
        "outbound_not_found",
        `No row "${rowUid}" is in campaign "${campaignUid}".`,
        404,
      ),
    mutate,
    `The row "${rowUid}"`,
  );
}

/** The installation's do-not-call list, or an empty one when none was written yet. */
export async function readDoNotCall(ctx: Ctx, accountId: string): Promise<DoNotCallDoc> {
  const doc = await readDoc(ctx, accountId, doNotCallPath(), isDoNotCallDoc);
  return doc ?? { version: 1, numbers: [], updatedAt: new Date(0).toISOString() };
}

/** Rewrite the do-not-call list. */
export async function writeDoNotCall(
  ctx: Ctx,
  accountId: string,
  doc: DoNotCallDoc,
): Promise<void> {
  await writeWithRetry(ctx, accountId, doNotCallPath(), doc, "The do-not-call list");
}
