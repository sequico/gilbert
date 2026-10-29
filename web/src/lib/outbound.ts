/**
 * Outbound calling, client half (ADR 0040).
 *
 * A campaign is the group's, so every call names the group it acts in and the
 * server resolves it against the caller's own membership. Nothing here decides
 * anything: the queue order, the counts and every refusal are the server's, and
 * this file only carries them.
 */

import type {
  CampaignDoc,
  CampaignOutcome,
  CampaignWindow,
  RowDoc,
} from "@gilbert/shared/outbound";
import { apiFetch } from "@/jmap/client";

/** What Today holds: the rows to work and the counts beside them. */
export interface TodayBoard {
  queue: RowDoc[];
  /** Open rows due now and not another caller's, dated or not. */
  due: number;
  /** Open rows whose next call is still ahead. */
  upcoming: number;
  /** Open rows another caller holds right now. */
  heldByOthers: number;
  /** Documents that are there and cannot be read. */
  problems: string[];
}

/** What a paste gave and what it lost, as the import route counts it. */
export interface ImportReport {
  added: number;
  /** Rows whose number a card of the group already carried. */
  matched: number;
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

/** A campaign past its window with work still to do. */
export interface CampaignFinding {
  uid: string;
  purpose: string;
  open: number;
}

/** The group's campaigns, and what needs a decision. */
export async function listCampaigns(group: string): Promise<{
  campaigns: CampaignDoc[];
  findings: CampaignFinding[];
}> {
  const res = await apiFetch<{
    campaigns: CampaignDoc[];
    findings: CampaignFinding[];
  }>(`/api/outbound/campaigns?${groupQuery(group)}`);
  return {
    campaigns: res.campaigns ?? [],
    findings: res.findings ?? [],
  };
}

/** Close a campaign, carrying its open rows into a successor when asked. */
export async function closeCampaign(
  group: string,
  campaignUid: string,
  carry: boolean,
): Promise<{ carried: number }> {
  const res = await apiFetch<{ carried: number }>(
    `/api/outbound/campaigns/${encodeURIComponent(campaignUid)}/close`,
    { method: "POST", body: JSON.stringify({ group, carry }) },
  );
  return { carried: res.carried ?? 0 };
}

/** A knowledge page a campaign may take its script from. */
export interface ScriptPage {
  nodeId: string;
  /** The tier-relative folder path: the page as a reader names it. */
  folder: string;
  /** The revision in force, which a new campaign pins. */
  revision: string;
}

/** The group's pages, with the revision each one is at. */
export async function fetchScriptPages(group: string): Promise<ScriptPage[]> {
  const res = await apiFetch<{ pages: ScriptPage[] }>(
    `/api/outbound/script-pages?${groupQuery(group)}`,
  );
  return res.pages ?? [];
}

/** The words of the revision a campaign pinned, or null when the page is gone. */
export async function fetchScript(
  group: string,
  campaignUid: string,
): Promise<string | null> {
  const res = await apiFetch<{ text: string | null }>(
    `/api/outbound/campaigns/${encodeURIComponent(campaignUid)}/script?${groupQuery(group)}`,
  );
  return res.text;
}

/**
 * Write a campaign for a purpose, with the outcomes its callers will choose, the
 * window it runs in when it has one, and — when the group has a page for it — the
 * script it reads aloud.
 */
export async function createCampaign(
  group: string,
  purpose: string,
  outcomes: CampaignOutcome[],
  script: { nodeId: string; revision: string } | null = null,
  window: CampaignWindow | null = null,
): Promise<CampaignDoc> {
  const res = await apiFetch<{ campaign: CampaignDoc }>("/api/outbound/campaigns", {
    method: "POST",
    body: JSON.stringify({ group, purpose, outcomes, script, window }),
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
    matched: res.matched ?? 0,
    duplicate: res.duplicate ?? 0,
    blocked: res.blocked ?? 0,
    refused: res.refused ?? [],
  };
}

/** One call as a card's log keeps it. */
export interface CardCall {
  at: string;
  by: string;
  /** The campaign's own outcome id. */
  outcome: string;
  note: string | null;
}

/** What was said to one card, whoever dialled it. */
export async function fetchCardCalls(
  group: string,
  cardUid: string,
): Promise<{ calls: CardCall[]; trimmed: number }> {
  const res = await apiFetch<{ calls: CardCall[]; trimmed: number }>(
    `/api/outbound/card-calls?${groupQuery(group)}&card=${encodeURIComponent(cardUid)}`,
  );
  return { calls: res.calls ?? [], trimmed: res.trimmed ?? 0 };
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

/** The queue this caller works today, narrowed to one campaign when asked. */
export async function fetchToday(group: string, campaign = ""): Promise<TodayBoard> {
  const narrow = campaign ? `&campaign=${encodeURIComponent(campaign)}` : "";
  const res = await apiFetch<TodayBoard>(
    `/api/outbound/today?${groupQuery(group)}${narrow}`,
  );
  return {
    queue: res.queue ?? [],
    due: res.due ?? 0,
    upcoming: res.upcoming ?? 0,
    heldByOthers: res.heldByOthers ?? 0,
    problems: res.problems ?? [],
  };
}

/** Every row of a campaign, settled ones included. */
export async function fetchRows(group: string, campaignUid: string): Promise<RowDoc[]> {
  const res = await apiFetch<{ rows: RowDoc[] }>(
    `/api/outbound/campaigns/${encodeURIComponent(campaignUid)}/rows?${groupQuery(group)}`,
  );
  return res.rows ?? [];
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
