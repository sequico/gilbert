/**
 * The outbound documents (ADR 0040), as both tiers name them.
 *
 * A campaign is the root document and its rows are documents of their own, so
 * two callers of one list never write the same file. Everything here is a claim
 * about a stored document an installation already holds: a field moves with every
 * reader and writer of it in one change, or it does not move.
 *
 * What a row does **not** hold is what makes this area an operation rather than a
 * CRM: there is no stage, no value and no owner of an account — the row dies with
 * its campaign, and identity lives in the group's own contact cards.
 */

import { isInstant, isRecord } from "./json.js";

/** The folder every outbound document lives in, inside the account's app folder. */
export const OUTBOUND_FOLDER = "outbound";

/** Campaign roots, one file each. */
export const CAMPAIGN_FOLDER = "campaigns";

/** A campaign's rows, one file each, in a folder of their own. */
export const ROW_FOLDER = "rows";

/** The group's do-not-call list: one document, beside the campaigns that honour it. */
export const DO_NOT_CALL_FILE = "do-not-call.json";

/** The numbers the group's cards carry, as one readable index (ADR 0040). */
export const CARD_INDEX_FILE = "card-index.json";

/** How many calls a row keeps before the oldest become a count. */
export const MAX_CALLS_KEPT = 20;

/** `outbound/campaigns/<uid>.json`, app-folder-relative. */
export function campaignPath(uid: string): string {
  return `${OUTBOUND_FOLDER}/${CAMPAIGN_FOLDER}/${uid}.json`;
}

/** The folder holding every campaign of one account. */
export function campaignFolderPath(): string {
  return `${OUTBOUND_FOLDER}/${CAMPAIGN_FOLDER}`;
}

/** `outbound/rows/<campaignUid>/<rowUid>.json`, app-folder-relative. */
export function rowPath(campaignUid: string, rowUid: string): string {
  return `${OUTBOUND_FOLDER}/${ROW_FOLDER}/${campaignUid}/${rowUid}.json`;
}

/** The folder holding one campaign's rows. */
export function rowFolderPath(campaignUid: string): string {
  return `${OUTBOUND_FOLDER}/${ROW_FOLDER}/${campaignUid}`;
}

/** The group's do-not-call list, app-folder-relative. */
export function doNotCallPath(): string {
  return `${OUTBOUND_FOLDER}/${DO_NOT_CALL_FILE}`;
}

/** The card index, app-folder-relative. */
export function cardIndexPath(): string {
  return `${OUTBOUND_FOLDER}/${CARD_INDEX_FILE}`;
}

/** A campaign runs for a window and then is closed; closing is a state. */
export type CampaignState = "running" | "closed";

export function isCampaignState(value: unknown): value is CampaignState {
  return value === "running" || value === "closed";
}

/** One outcome the campaign admits, named by the people who will dial it. */
export interface CampaignOutcome {
  /** Stable id the row stores; a label may be rewritten, the id may not. */
  id: string;
  label: string;
}

/**
 * The script a campaign reads, pinned to one revision.
 *
 * Two callers saying different things because somebody edited the page on
 * Wednesday is worse than a script that is a week old.
 */
export interface CampaignScriptRef {
  /** The knowledge base FileNode the page lives in. */
  nodeId: string;
  /** The revision the campaign started with. */
  revision: string;
}

/** The window a campaign runs in; both ends may be open. */
export interface CampaignWindow {
  from: string | null;
  to: string | null;
}

export interface CampaignDoc {
  version: 1;
  uid: string;
  /** One sentence: why this list is being called. */
  purpose: string;
  script: CampaignScriptRef | null;
  outcomes: CampaignOutcome[];
  window: CampaignWindow;
  state: CampaignState;
  createdAt: string;
  createdBy: string;
}

/** A row's own state: open until its call settles it. */
export type RowState = "open" | "done" | "dropped";

export function isRowState(value: unknown): value is RowState {
  return value === "open" || value === "done" || value === "dropped";
}

/**
 * Whether a claim is still believed at `now`.
 *
 * The one definition, because two surfaces ask it: the queue decides what to
 * offer and an act decides what it may touch, and two answers to "is this row
 * taken" is how a row ends up in two places at once.
 */
export function claimIsLive(claim: RowClaim | null, now: Date): claim is RowClaim {
  return claim !== null && Date.parse(claim.until) > now.getTime();
}

/** Whether somebody other than `caller` holds this row right now. */
export function heldByOther(row: RowDoc, caller: string, now: Date): boolean {
  return claimIsLive(row.claim, now) && row.claim.by !== caller;
}

/** Who is calling a row now, and until when the claim is believed. */
export interface RowClaim {
  by: string;
  at: string;
  until: string;
}

/** One call a row has taken, as the person who placed it left it. */
export interface RowCall {
  at: string;
  by: string;
  /** The campaign's outcome id. */
  outcome: string;
  note: string | null;
  /** The card spoken to, when the call named somebody. */
  cardUid: string | null;
}

/**
 * What the file said about the row, kept until a card exists for it.
 *
 * A card is created at the first call and never by an import, so an imported row
 * carries only what its line carried.
 */
export interface RowLabel {
  company: string | null;
  name: string | null;
}

export interface RowDoc {
  version: 1;
  uid: string;
  campaignUid: string;
  /** E.164, the only form a stored number has. */
  e164: string;
  extension: string | null;
  label: RowLabel;
  /** The words the line carried around the number, as they arrived. */
  context: string | null;
  /** The card this row calls, once one exists. */
  cardUid: string | null;
  state: RowState;
  claim: RowClaim | null;
  /** When this row is due again; null means "as soon as there is time". */
  nextCallAt: string | null;
  /** The calls kept, newest last. */
  calls: RowCall[];
  /** How many calls were trimmed out of `calls`. */
  trimmed: number;
  createdAt: string;
}

/** The group's do-not-call numbers, canonical and unique. */
export interface DoNotCallDoc {
  version: 1;
  numbers: string[];
  updatedAt: string;
}

/**
 * The group's cards, by the number each one carries.
 *
 * A paste of a hundred lines must not ask the mail server for every card to find
 * out which number it already knows, so the group keeps this index beside its
 * campaigns. It is never a second truth: `cardState` is the card store's own state
 * at the moment it was built, and a state that has moved makes it stale, so the
 * next read rebuilds it from the cards themselves.
 */
export interface CardIndexDoc {
  version: 1;
  /** The account's `ContactCard` state when the index was built. */
  cardState: string;
  /** Canonical number → the card that carries it. */
  cards: Record<string, string>;
  builtAt: string;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isNullableInstant(value: unknown): value is string | null {
  return value === null || isInstant(value);
}

function isOutcome(value: unknown): value is CampaignOutcome {
  return (
    isRecord(value) &&
    isString(value.id) &&
    value.id !== "" &&
    isString(value.label) &&
    value.label !== ""
  );
}

function isScriptRef(value: unknown): value is CampaignScriptRef {
  return (
    isRecord(value) &&
    isString(value.nodeId) &&
    value.nodeId !== "" &&
    isString(value.revision)
  );
}

function isWindow(value: unknown): value is CampaignWindow {
  return isRecord(value) && isNullableString(value.from) && isNullableString(value.to);
}

function isClaim(value: unknown): value is RowClaim {
  return (
    isRecord(value) && isString(value.by) && isInstant(value.at) && isInstant(value.until)
  );
}

function isCall(value: unknown): value is RowCall {
  return (
    isRecord(value) &&
    isInstant(value.at) &&
    isString(value.by) &&
    isString(value.outcome) &&
    isNullableString(value.note) &&
    isNullableString(value.cardUid)
  );
}

function isLabel(value: unknown): value is RowLabel {
  return (
    isRecord(value) && isNullableString(value.company) && isNullableString(value.name)
  );
}

/**
 * Whether a string is a canonical number: `+`, a country code and digits.
 *
 * The one statement of the shape, read by the writer that produces a number
 * (`outbound/phone.ts`) and by the validator that reads a stored one, so a row
 * that is stored is a row every reader accepts.
 */
export function isE164(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{6,14}$/.test(value);
}

/** Whether a campaign document is one this build can read. */
export function isCampaignDoc(value: unknown): value is CampaignDoc {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isString(value.uid) || value.uid === "") return false;
  if (!isString(value.purpose)) return false;
  if (!(value.script === null || isScriptRef(value.script))) return false;
  if (!Array.isArray(value.outcomes) || !value.outcomes.every(isOutcome)) return false;
  // Outcomes are the vocabulary a row's calls are written against, so an empty
  // list is a campaign that cannot record anything, and a repeated id is a
  // vocabulary with two meanings for one word.
  if (value.outcomes.length === 0) return false;
  if (
    new Set(value.outcomes.map((outcome) => (outcome as CampaignOutcome).id)).size !==
    value.outcomes.length
  ) {
    return false;
  }
  if (!isWindow(value.window)) return false;
  if (!isCampaignState(value.state)) return false;
  return isInstant(value.createdAt) && isString(value.createdBy);
}

/** Whether a row document is one this build can read. */
export function isRowDoc(value: unknown): value is RowDoc {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isString(value.uid) || value.uid === "") return false;
  if (!isString(value.campaignUid) || value.campaignUid === "") return false;
  if (!isE164(value.e164)) return false;
  if (!isNullableString(value.extension)) return false;
  if (!isLabel(value.label)) return false;
  if (!isNullableString(value.context)) return false;
  if (!isNullableString(value.cardUid)) return false;
  if (!isRowState(value.state)) return false;
  if (!(value.claim === null || isClaim(value.claim))) return false;
  if (!isNullableInstant(value.nextCallAt)) return false;
  if (!Array.isArray(value.calls) || !value.calls.every(isCall)) return false;
  if (value.calls.length > MAX_CALLS_KEPT) return false;
  if (
    typeof value.trimmed !== "number" ||
    !Number.isInteger(value.trimmed) ||
    value.trimmed < 0
  )
    return false;
  return isInstant(value.createdAt);
}

/** Whether the card index is one this build can read. */
export function isCardIndexDoc(value: unknown): value is CardIndexDoc {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isString(value.cardState)) return false;
  if (!isRecord(value.cards)) return false;
  if (
    !Object.entries(value.cards).every(([number, uid]) => isString(uid) && isE164(number))
  )
    return false;
  return isInstant(value.builtAt);
}

/** Whether the group's do-not-call document is one this build can read. */
export function isDoNotCallDoc(value: unknown): value is DoNotCallDoc {
  if (!isRecord(value) || value.version !== 1) return false;
  if (
    !Array.isArray(value.numbers) ||
    !value.numbers.every((number) => isString(number) && number.startsWith("+"))
  ) {
    return false;
  }
  return isInstant(value.updatedAt);
}

/**
 * Add a call to a row, keeping the window and the count of what left it.
 *
 * The row is written whole on every call, so the window is what keeps opening a
 * card from becoming a large read; the count is what keeps "how often have we
 * called" answerable after the detail has gone.
 */
export function withCall(row: RowDoc, call: RowCall): RowDoc {
  const calls = [...row.calls, call];
  const overflow = Math.max(0, calls.length - MAX_CALLS_KEPT);
  return {
    ...row,
    calls: overflow ? calls.slice(overflow) : calls,
    trimmed: row.trimmed + overflow,
  };
}
