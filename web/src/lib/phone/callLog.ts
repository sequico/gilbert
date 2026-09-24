/**
 * The account's own phone history (ADR 0023).
 *
 * The calls the phone took and placed, newest first, held in the account's own
 * app folder as `calls.json` — the same pattern the settings and the SIP
 * account follow — so the list follows the person between devices and survives
 * a sign-out. Only this tier reads or writes it, so the shape lives here rather
 * than in the shared tree the server also reads.
 */
import type { Id } from "@/jmap/types";
import { readAppJson, writeAppJson } from "@/lib/appFolder";

/** The document holding an account's phone history in its app folder. */
export const CALL_LOG_FILE = "calls.json";
export const CALL_LOG_VERSION = 1;
/** Older calls fall off the end; the list is a convenience, not an archive. */
export const CALL_LOG_LIMIT = 100;

/** One call, as the phone saw it. */
export interface CallLogEntry {
  /** Epoch ms when the call began: the INVITE sent, or the first ring. */
  at: number;
  direction: "in" | "out";
  /** The other party, as dialled or as it arrived. */
  remote: string;
  /** Seconds connected; 0 when it never was. */
  seconds: number;
  outcome: "answered" | "missed" | "declined" | "failed";
}

interface CallLogDocument {
  version: number;
  calls: CallLogEntry[];
}

const CALL_OUTCOMES = new Set(["answered", "missed", "declined", "failed"]);

function isCallLogEntry(value: unknown): value is CallLogEntry {
  const e = value as CallLogEntry;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof e.at === "number" &&
    Number.isFinite(e.at) &&
    (e.direction === "in" || e.direction === "out") &&
    typeof e.remote === "string" &&
    typeof e.seconds === "number" &&
    Number.isFinite(e.seconds) &&
    CALL_OUTCOMES.has(e.outcome)
  );
}

/** Read a call-log document into its list; absent, malformed or shapeless is empty. */
export function parseCallLog(raw: unknown): CallLogEntry[] {
  if (typeof raw !== "object" || raw === null) return [];
  const calls = (raw as CallLogDocument).calls;
  if (!Array.isArray(calls)) return [];
  return calls.filter(isCallLogEntry).slice(0, CALL_LOG_LIMIT);
}

/** The document after one call is prepended: newest first, bounded. */
export function withCallEntry(
  current: CallLogEntry[],
  entry: CallLogEntry,
): CallLogDocument {
  return {
    version: CALL_LOG_VERSION,
    calls: [entry, ...current].slice(0, CALL_LOG_LIMIT),
  };
}

/** The account's calls, newest first; absent or unreadable is empty. */
export async function readCallLog(accountId: Id): Promise<CallLogEntry[]> {
  return parseCallLog(await readAppJson(accountId, CALL_LOG_FILE));
}

/** Record one call, and answer the list it left behind. */
export async function appendCall(
  accountId: Id,
  entry: CallLogEntry,
): Promise<CallLogEntry[]> {
  const current = await readCallLog(accountId);
  const document = withCallEntry(current, entry);
  await writeAppJson(accountId, CALL_LOG_FILE, document);
  return document.calls;
}
