/**
 * Outbound calling, client half (ADR 0040).
 *
 * A campaign is the group's, so every call names the group it acts in and the
 * server resolves it against the caller's own membership. Nothing here decides
 * anything: the queue order, the counts and every refusal are the server's, and
 * this file only carries them.
 */

import type { CampaignDoc, CampaignOutcome, RowDoc } from "@gilbert/shared/outbound";
import { apiFetch } from "@/jmap/client";

/** What Today holds: the rows to work, the counts, and each campaign's words. */
export interface TodayBoard {
  queue: RowDoc[];
  /** Open rows due now and not another caller's. */
  due: number;
  /** Open rows whose next call is still ahead. */
  upcoming: number;
  /** Open rows another caller holds right now. */
  heldByOthers: number;
  /** The purpose and outcome vocabulary of each running campaign, by uid. */
  campaigns: Record<string, { purpose: string; outcomes: CampaignOutcome[] }>;
  /** Documents that are there and cannot be read. */
  problems: string[];
}

/** What a paste gave and what it lost, as the import route counts it. */
export interface ImportReport {
  added: number;
  duplicate: number;
  blocked: number;
  refused: { line: string; reason: string }[];
}

/** A settlement: the campaign's outcome, a note, and when the row is due again. */
export interface Settlement {
  outcome: string;
  note?: string | null;
  /** An ISO instant keeps the row open until then; no date settles it. */
  nextCallAt?: string | null;
}

const groupQuery = (group: string) => `group=${encodeURIComponent(group)}`;

/** The group's campaigns, with what could not be read. */
export async function listCampaigns(
  group: string,
): Promise<{ campaigns: CampaignDoc[]; problems: string[] }> {
  const res = await apiFetch<{ campaigns: CampaignDoc[]; problems: string[] }>(
    `/api/outbound/campaigns?${groupQuery(group)}`,
  );
  return { campaigns: res.campaigns ?? [], problems: res.problems ?? [] };
}

/** Write a campaign for a purpose, with the outcomes its callers will choose. */
export async function createCampaign(
  group: string,
  purpose: string,
  outcomes: CampaignOutcome[],
): Promise<CampaignDoc> {
  const res = await apiFetch<{ campaign: CampaignDoc }>("/api/outbound/campaigns", {
    method: "POST",
    body: JSON.stringify({ group, purpose, outcomes }),
  });
  return res.campaign;
}

/** Read a pasted list into the campaign. */
export async function importRows(
  group: string,
  campaignUid: string,
  text: string,
): Promise<ImportReport> {
  const res = await apiFetch<ImportReport>(
    `/api/outbound/campaigns/${encodeURIComponent(campaignUid)}/rows`,
    { method: "POST", body: JSON.stringify({ group, text }) },
  );
  return {
    added: res.added ?? 0,
    duplicate: res.duplicate ?? 0,
    blocked: res.blocked ?? 0,
    refused: res.refused ?? [],
  };
}

/** The group's do-not-call list, canonical E.164 numbers. */
export async function fetchDoNotCall(group: string): Promise<string[]> {
  const res = await apiFetch<{ numbers: string[] }>(
    `/api/outbound/do-not-call?${groupQuery(group)}`,
  );
  return res.numbers ?? [];
}

/** Put a number on the group's do-not-call list, or take it off. */
export async function setDoNotCall(
  group: string,
  number: string,
  blocked: boolean,
): Promise<string[]> {
  const res = await apiFetch<{ numbers: string[] }>("/api/outbound/do-not-call", {
    method: "POST",
    body: JSON.stringify({ group, number, blocked }),
  });
  return res.numbers ?? [];
}

/** The queue this caller works today. */
export async function fetchToday(group: string): Promise<TodayBoard> {
  const res = await apiFetch<TodayBoard>(`/api/outbound/today?${groupQuery(group)}`);
  return {
    queue: res.queue ?? [],
    due: res.due ?? 0,
    upcoming: res.upcoming ?? 0,
    heldByOthers: res.heldByOthers ?? 0,
    campaigns: res.campaigns ?? {},
    problems: res.problems ?? [],
  };
}

/** Take a row: the caller holds it until the claim lapses. */
export async function takeRow(
  group: string,
  campaignUid: string,
  rowUid: string,
): Promise<RowDoc> {
  const res = await apiFetch<{ row: RowDoc }>(
    `/api/outbound/campaigns/${encodeURIComponent(campaignUid)}/rows/${encodeURIComponent(rowUid)}/take`,
    { method: "POST", body: JSON.stringify({ group }) },
  );
  return res.row;
}

/** Settle a row with the call it just took. */
export async function settleRow(
  group: string,
  campaignUid: string,
  rowUid: string,
  settlement: Settlement,
): Promise<RowDoc> {
  const res = await apiFetch<{ row: RowDoc }>(
    `/api/outbound/campaigns/${encodeURIComponent(campaignUid)}/rows/${encodeURIComponent(rowUid)}/settle`,
    { method: "POST", body: JSON.stringify({ group, ...settlement }) },
  );
  return res.row;
}
