/**
 * What the outbound surfaces do, as acts (ADR 0040).
 *
 * Each act is one document changed: a campaign written, a list read into rows, a
 * row taken, a row settled. The rules live beside this module — `rowActions.ts`
 * for what taking and settling mean, `importList.ts` for what a pasted line gave —
 * and this file only wires them to the account and to the refusal a caller reads.
 */

import type { Ctx } from "../appFolder.js";
import { claimIsLive } from "../shared/outbound.js";
import type {
  CampaignDoc,
  CampaignOutcome,
  CampaignScriptRef,
  CampaignWindow,
  RowDoc,
} from "../shared/outbound.js";
import { createCardFor } from "./cards.js";
import {
  appendCardCall,
  mutateCampaign,
  mutateRow,
  mutateRows,
  readCampaign,
  readRow,
  readRows,
  writeCampaign,
} from "./documents.js";
import { OutboundError, campaignMissing, rowMissing } from "./errors.js";
import { type ImportPlan, planImport } from "./importList.js";
import { type SettleInput, type SettleResult, settleRow, takeRow } from "./rowActions.js";

export interface NewCampaign {
  uid: string;
  purpose: string;
  outcomes: readonly CampaignOutcome[];
  script?: CampaignScriptRef | null;
  window?: CampaignWindow | null;
  createdBy: string;
  now: Date;
}

/** Write the campaign a caller just described. */
export async function createCampaign(
  ctx: Ctx,
  accountId: string,
  input: NewCampaign,
): Promise<CampaignDoc> {
  const doc: CampaignDoc = {
    version: 1,
    uid: input.uid,
    purpose: input.purpose,
    script: input.script ?? null,
    outcomes: [...input.outcomes],
    window: input.window ?? { from: null, to: null },
    state: "running",
    createdAt: input.now.toISOString(),
    createdBy: input.createdBy,
  };
  await writeCampaign(ctx, accountId, doc);
  return doc;
}

/** The campaign a write acts on, refusing one that is closed. */
export async function openCampaign(
  ctx: Ctx,
  accountId: string,
  uid: string,
): Promise<CampaignDoc> {
  const campaign = await readCampaign(ctx, accountId, uid);
  if (!campaign) throw campaignMissing(uid);
  if (campaign.state !== "running") {
    throw new OutboundError(
      "campaign_closed",
      `The campaign "${uid}" is closed: its list is no longer worked.`,
      409,
    );
  }
  return campaign;
}

export interface ImportedList extends ImportPlan {
  campaignUid: string;
}

/**
 * Read a pasted list into the campaign, writing what the plan decided.
 *
 * What the group already knows — the numbers it promised never to call, the cards
 * its numbers belong to and the rows this campaign already holds — arrives from
 * the caller rather than being read here, because the rule that decides what a
 * line becomes is the only thing this act adds: one plan, one write of the list.
 */
export async function importList(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
  text: string,
  known: { doNotCall: readonly string[]; cards: Readonly<Record<string, string>> },
  now: Date,
  newUid: () => string,
): Promise<ImportedList> {
  await openCampaign(ctx, accountId, campaignUid);
  // The numbers this campaign already holds are what "already in the list" means:
  // the same sheet pasted twice adds nothing and says so.
  const existing = (await readRows(ctx, accountId, campaignUid)).docs.map(
    (row) => row.e164,
  );
  const plan = planImport({ campaignUid, text, ...known, existing, now, newUid });
  if (plan.rows.length > 0) {
    await mutateRows(ctx, accountId, campaignUid, (rows) => [...rows, ...plan.rows]);
  }
  return { ...plan, campaignUid };
}

/** Why an act on a row was refused, as the rules beside this module state it. */
type RowRefusal = Extract<SettleResult, { ok: false }>["reason"];

/**
 * The refusal a caller reads when an act on a row is not allowed.
 *
 * Taking and settling fail for the same reasons, so the sentence for each reason
 * is written once and the act says only which act it was.
 */
function rowRefusal(reason: RowRefusal, outcome = ""): OutboundError {
  switch (reason) {
    case "held_by_other":
      return new OutboundError(
        "row_held",
        "Another caller is on this row: it comes back when their claim lapses.",
        409,
      );
    case "settled":
      return new OutboundError("row_settled", "This row is already settled.", 409);
    case "unknown_outcome":
      return new OutboundError(
        "unknown_outcome",
        `"${outcome}" is not an outcome of this campaign.`,
        400,
      );
  }
}

/**
 * Close a campaign, carrying its still-open rows into a successor when asked.
 *
 * Closing is a state, not a deletion: the rows stay with the campaign that made
 * them, and the card keeps the calls. Carrying is for the other resolution the
 * record allows — the work that is still to do moves to a new campaign with the
 * same purpose and vocabulary, because a row's path is its campaign's and a row
 * cannot be moved.
 */
export async function closeCampaign(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
  {
    carry,
    createdBy,
    now,
    newUid,
  }: { carry: boolean; createdBy: string; now: Date; newUid: () => string },
): Promise<{ campaign: CampaignDoc; successor: CampaignDoc | null; carried: number }> {
  const campaign = await openCampaign(ctx, accountId, campaignUid);
  const open = (await readRows(ctx, accountId, campaignUid)).docs.filter(
    (row) => row.state === "open",
  );

  let successor: CampaignDoc | null = null;
  let carried = 0;
  if (carry && open.length > 0) {
    const written = await createCampaign(ctx, accountId, {
      uid: newUid(),
      purpose: campaign.purpose,
      outcomes: campaign.outcomes,
      script: campaign.script,
      window: null,
      createdBy,
      now,
    });
    successor = written;
    // The rows still open are the successor's own from its first moment: its path
    // is its campaign's, so carrying one is writing it there, with a fresh window.
    const carriedRows: RowDoc[] = open.map((row) => ({
      ...row,
      uid: newUid(),
      campaignUid: written.uid,
      claim: null,
      calls: [],
      trimmed: 0,
      createdAt: now.toISOString(),
    }));
    await mutateRows(ctx, accountId, written.uid, () => carriedRows);
    carried = carriedRows.length;
  }

  const closed = await mutateCampaign(ctx, accountId, campaignUid, (doc) => ({
    ...doc,
    state: "closed",
  }));
  return { campaign: closed, successor, carried };
}

/** Take a row for the caller holding it. */
export async function take(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
  rowUid: string,
  by: string,
  now: Date,
): Promise<RowDoc> {
  await openCampaign(ctx, accountId, campaignUid);
  /*
   * One row of a list at a time (ADR 0040). The claim is what keeps a list from
   * being called twice at once, and two rows in one caller's hands is the same
   * list worked from two screens. The pane already refuses the second take; this
   * is the rule where every other way in meets it.
   */
  const held = (await readRows(ctx, accountId, campaignUid)).docs.find(
    (row) =>
      row.uid !== rowUid &&
      row.claim !== null &&
      row.claim.by === by &&
      claimIsLive(row.claim, now),
  );
  if (held) {
    throw new OutboundError(
      "row_in_hand",
      `You are already calling ${held.e164}: settle that row before taking another.`,
      409,
    );
  }
  return mutateRow(ctx, accountId, campaignUid, rowUid, (doc) => {
    const taken = takeRow(doc, { by, now });
    if (taken.ok) return taken.row;
    throw rowRefusal(taken.reason);
  });
}

/** Settle a row with the call it just took. */
export async function settle(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
  rowUid: string,
  input: SettleInput,
): Promise<RowDoc> {
  const campaign = await openCampaign(ctx, accountId, campaignUid);
  const outcomes = campaign.outcomes.map((outcome) => outcome.id);
  const before = await readRow(ctx, accountId, campaignUid, rowUid);
  if (!before) throw rowMissing(campaignUid, rowUid);

  /*
   * The rules are asked of the row as it stands before anything is created: a
   * settle that will be refused must not leave a card behind. The same rules run
   * again inside the write, where they decide under the compare-and-set — this is
   * the same pure function, not a second copy of them.
   */
  const refusable = settleRow(before, { ...input, cardUid: null }, outcomes);
  if (!refusable.ok) throw rowRefusal(refusable.reason, input.outcome);

  // The first call to a number is what makes it somebody the group knows.
  const cardUid =
    input.cardUid ??
    before.cardUid ??
    (await createCardFor(ctx, accountId, { number: before.e164, note: before.context }));

  const settled = await mutateRow(ctx, accountId, campaignUid, rowUid, (doc) => {
    const result = settleRow(doc, { ...input, cardUid }, outcomes);
    if (result.ok) return result.row;
    throw rowRefusal(result.reason, input.outcome);
  });

  // The call also belongs to the card, which outlives the campaign that made it.
  const call = settled.calls.at(-1);
  if (call) await appendCardCall(ctx, accountId, cardUid, call);
  return settled;
}
