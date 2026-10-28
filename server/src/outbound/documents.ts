/**
 * The outbound documents on disk (ADR 0040).
 *
 * Every write here is a read-modify-write under the account's compare-and-set:
 * the state token is taken **before** the document is read, so a write that
 * lands in between is refused instead of overwritten, and the act is retried
 * once. That is the whole of the concurrency story — two callers of one list
 * touch different rows, and two callers of one row are one refusal apart.
 *
 * Nothing here decides policy: which row may be taken and what settling it means
 * are `rowActions.ts`, and what the queue offers is `queue.ts`.
 */

import {
  type Ctx,
  appFolderState,
  listAppDir,
  readAppJsonAt,
  writeAppFileAt,
} from "../appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import {
  campaignPath,
  doNotCallPath,
  isCampaignDoc,
  isDoNotCallDoc,
  isRowDoc,
  rowFolderPath,
  rowPath,
  type CampaignDoc,
  type DoNotCallDoc,
  type RowDoc,
} from "../shared/outbound.js";
import { OutboundError, requireState } from "./errors.js";

/** The sentence an exhausted retry carries: the write did not land, and that is all it means. */
function writeFailed(what: string): OutboundError {
  return new OutboundError("outbound_write_failed", `${what} could not be written: another write kept landing first. Try again.`, 502);
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

/** One campaign, or null when it is not there or this build cannot read it. */
export async function readCampaign(ctx: Ctx, accountId: string, uid: string): Promise<CampaignDoc | null> {
  return readDoc(ctx, accountId, campaignPath(uid), isCampaignDoc);
}

/** Every campaign of the account, by uid. */
export async function listCampaigns(ctx: Ctx, accountId: string): Promise<CampaignDoc[]> {
  const nodes = await listAppDir(ctx, accountId, "outbound/campaigns");
  const docs: CampaignDoc[] = [];
  for (const node of nodes) {
    const name = typeof node.name === "string" ? node.name : "";
    if (!name.endsWith(".json")) continue;
    const doc = await readCampaign(ctx, accountId, name.slice(0, -5));
    if (doc) docs.push(doc);
  }
  return docs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

/** Every row of a campaign. */
export async function readRows(ctx: Ctx, accountId: string, campaignUid: string): Promise<RowDoc[]> {
  const nodes = await listAppDir(ctx, accountId, rowFolderPath(campaignUid));
  const docs: RowDoc[] = [];
  for (const node of nodes) {
    const name = typeof node.name === "string" ? node.name : "";
    if (!name.endsWith(".json")) continue;
    const doc = await readRow(ctx, accountId, campaignUid, name.slice(0, -5));
    if (doc) docs.push(doc);
  }
  return docs;
}

/** Write a campaign as it stands; a new campaign has one writer by construction. */
export async function writeCampaign(ctx: Ctx, accountId: string, doc: CampaignDoc): Promise<void> {
  await writeAppFileAt(ctx, accountId, campaignPath(doc.uid), doc, {
    ifInState: requireState(await appFolderState(ctx, accountId)),
  });
}

/** Change one campaign under the compare-and-set, or say the write did not land. */
export async function mutateCampaign(
  ctx: Ctx,
  accountId: string,
  uid: string,
  mutate: (doc: CampaignDoc) => CampaignDoc,
): Promise<CampaignDoc> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = requireState(await appFolderState(ctx, accountId));
    const doc = await readCampaign(ctx, accountId, uid);
    if (!doc) throw new OutboundError("outbound_not_found", `No campaign "${uid}" is there.`, 404);
    const next = mutate(doc);
    try {
      await writeAppFileAt(ctx, accountId, campaignPath(uid), next, { ifInState: token });
      return next;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  throw writeFailed(`The campaign "${uid}"`);
}

/**
 * Change one row under the compare-and-set.
 *
 * The read, the rule and the write are one attempt: a row taken by somebody else
 * between them is a state mismatch, and the retry reads the row as they left it.
 */
export async function mutateRow(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
  rowUid: string,
  mutate: (doc: RowDoc) => RowDoc,
): Promise<RowDoc> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = requireState(await appFolderState(ctx, accountId));
    const doc = await readRow(ctx, accountId, campaignUid, rowUid);
    if (!doc) throw new OutboundError("outbound_not_found", `No row "${rowUid}" is in campaign "${campaignUid}".`, 404);
    const next = mutate(doc);
    try {
      await writeAppFileAt(ctx, accountId, rowPath(campaignUid, rowUid), next, { ifInState: token });
      return next;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  throw writeFailed(`The row "${rowUid}"`);
}

/** The installation's do-not-call list, or an empty one when none was written yet. */
export async function readDoNotCall(ctx: Ctx, accountId: string): Promise<DoNotCallDoc> {
  const doc = await readDoc(ctx, accountId, doNotCallPath(), isDoNotCallDoc);
  return doc ?? { version: 1, numbers: [], updatedAt: new Date(0).toISOString() };
}

/** Rewrite the do-not-call list under the compare-and-set. */
export async function writeDoNotCall(ctx: Ctx, accountId: string, doc: DoNotCallDoc): Promise<void> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = requireState(await appFolderState(ctx, accountId));
    try {
      await writeAppFileAt(ctx, accountId, doNotCallPath(), doc, { ifInState: token });
      return;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  throw writeFailed("The do-not-call list");
}
