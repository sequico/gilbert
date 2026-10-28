/**
 * What the outbound surfaces do, as acts (ADR 0040).
 *
 * Each act is one document changed: a campaign written, a list read into rows, a
 * row taken, a row settled. The rules live beside this module — `rowActions.ts`
 * for what taking and settling mean, `importList.ts` for what a pasted line gave —
 * and this file only wires them to the account and to the refusal a caller reads.
 */

import type { Ctx } from "../appFolder.js";
import type {
  CampaignDoc,
  CampaignOutcome,
  CampaignScriptRef,
  CampaignWindow,
  RowDoc,
} from "../shared/outbound.js";
import { mutateRow, readCampaign, writeCampaign, writeRow } from "./documents.js";
import { OutboundError } from "./errors.js";
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
  if (!campaign)
    throw new OutboundError("outbound_not_found", `No campaign "${uid}" is there.`, 404);
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
 * The do-not-call numbers arrive from the caller because they live in the Master's
 * account and this act is acting as a group: one read of the list, one plan, one
 * write per row it kept.
 */
export async function importList(
  ctx: Ctx,
  accountId: string,
  campaignUid: string,
  text: string,
  doNotCall: readonly string[],
  now: Date,
  newUid: () => string,
): Promise<ImportedList> {
  await openCampaign(ctx, accountId, campaignUid);
  const plan = planImport({ campaignUid, text, doNotCall, now, newUid });
  for (const row of plan.rows) await writeRow(ctx, accountId, row);
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
  return mutateRow(ctx, accountId, campaignUid, rowUid, (doc) => {
    const settled = settleRow(doc, input, outcomes);
    if (settled.ok) return settled.row;
    throw rowRefusal(settled.reason, input.outcome);
  });
}
