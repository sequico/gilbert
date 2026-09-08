/**
 * What to do when an error no closer boundary caught unmounts the whole tree.
 *
 * A blank page is the shape of two very different failures, and both end the
 * same way — with a reload being the only repair. The first is a tab running
 * a build the server no longer serves: a lazy chunk 404s and the import
 * fails. The second happens at the same build: a chunk fetch that died with
 * the connection while the tab sat idle, or a view whose in-memory state went
 * stale over hours. `reloadIfServerRebuilt` only reloads when the version
 * moved, which is right for the first and useless for the second — so a crash
 * that reaches the root boundary is answered with an automatic reload,
 * bounded so a genuine bug cannot loop the page.
 *
 * The reload is safe for the session: it lives in the sealed cookie and the
 * server's session file, not in the tab. What the reload would erase is the
 * evidence, so the crash is written down first, where a reload cannot reach
 * it — `localStorage` survives, and support can read it back.
 *
 * The bounds on automatic reloads are remembered per tab (`sessionStorage`,
 * which survives a reload in the same tab and is private to it), so a bug
 * that crashes again after a reload cannot cycle the page for ever: no
 * reload while the page is less than a minute old (a boot crash would
 * otherwise reload itself), none within two minutes of the previous attempt,
 * and at most two attempts per ten minutes. A crash that survives two
 * attempts is left for a human, with the record intact.
 */

const CRASH_KEY = "gilbert:last-crash";
const RELOAD_MARKS_KEY = "gilbert:auto-reload-marks";

/**
 * How old the page must be before a crash may trigger a reload.
 *
 * A bug that takes the app down within its first seconds will do it again
 * after every reload, so an automatic reload there is a loop with a page
 * reload as its heartbeat. Below this age the crash is only recorded.
 */
const MIN_ALIVE_MS = 60_000;

/**
 * How long after an automatic reload another may happen.
 *
 * The first reload is the repair attempt — a fresh bundle, fresh
 * connections, fresh state. If the same crash survives it, a second reload
 * a moment later is not another attempt, it is a loop; whatever is broken
 * will still be broken, and the record from the first crash says what it
 * was.
 */
const COOLDOWN_MS = 120_000;

/**
 * How long the attempt marks are remembered, and therefore how many attempts
 * may happen before the page is left alone. A crash that has survived two
 * reloads within ten minutes is a real bug, not a stale tab; a crash ten
 * minutes after the last attempt is a new incident and earns a new attempt.
 */
const REARM_MS = 600_000;

/** Automatic reloads allowed within one `REARM_MS` window. */
const MAX_AUTO_RELOADS = 2;

export interface CrashRecord {
  /** When the crash happened, as an ISO string. */
  at: string;
  /** The address that was showing when it happened. */
  url: string;
  name: string;
  message: string;
  stack?: string;
  componentStack?: string;
}

function readRaw(storage: Storage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(storage: Storage | null, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    /* best-effort, as above */
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Some privacy modes throw on access; the record is best-effort.
    return null;
  }
}

function sessionStorageOf(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function pageAliveMs(): number {
  return Date.now() - performance.timeOrigin;
}

/** Write the crash down where the reload cannot erase it. */
export function recordCrash(err: unknown, componentStack?: string): CrashRecord {
  const e = err instanceof Error ? err : new Error(String(err));
  const record: CrashRecord = {
    at: new Date().toISOString(),
    url: window.location.href,
    name: e.name,
    message: e.message,
    ...(e.stack ? { stack: e.stack } : {}),
    ...(componentStack ? { componentStack } : {}),
  };
  writeRaw(storage(), CRASH_KEY, JSON.stringify(record));
  console.error(
    "[gilbert] an uncaught error stopped the app; the crash is recorded and an automatic reload may be attempted",
    record,
  );
  return record;
}

/** The last recorded crash, for support to read back after a reload. */
export function readCrashRecord(): CrashRecord | null {
  const raw = readRaw(storage(), CRASH_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CrashRecord;
  } catch {
    return null;
  }
}

/*
 * The reload marks live in sessionStorage: they must survive a reload in the
 * same tab (that is the whole point) and they must not leak across tabs (one
 * tab's repair attempt is not another's). The memory mirror is only a
 * fallback for environments where storage exists but refuses to answer — a
 * privacy mode that throws on access cannot remember across reloads, but can
 * still stop the same page from reloading in a loop. Where storage answers,
 * it is authoritative and the mirror follows it.
 */
const SESSION = sessionStorageOf();
let memoryMarks: number[] = [];

function readMarks(): number[] {
  if (SESSION) {
    try {
      const raw = SESSION.getItem(RELOAD_MARKS_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          const marks = parsed.filter((x): x is number => typeof x === "number");
          memoryMarks = marks;
          return marks;
        }
      } else {
        // A readable empty store is authoritative: this tab has no attempts.
        memoryMarks = [];
        return [];
      }
    } catch {
      // Storage exists but refuses to answer; fall back to the mirror.
    }
  }
  return memoryMarks;
}

function writeMarks(marks: number[]): void {
  memoryMarks = marks;
  writeRaw(SESSION, RELOAD_MARKS_KEY, JSON.stringify(marks));
}

function withinWindow(marks: number[], now: number, ms: number): number[] {
  return marks.filter((m) => now - m < ms);
}

/** Whether an automatic reload is safe to attempt right now. */
export function shouldAutoReload(): boolean {
  if (pageAliveMs() < MIN_ALIVE_MS) return false;
  const now = Date.now();
  const marks = withinWindow(readMarks(), now, REARM_MS);
  if (marks.length >= MAX_AUTO_RELOADS) return false;
  if (withinWindow(marks, now, COOLDOWN_MS).length > 0) return false;
  return true;
}

/** Remember that an automatic reload was attempted, before the page goes. */
export function markAutoReload(): void {
  const now = Date.now();
  writeMarks([...withinWindow(readMarks(), now, REARM_MS), now]);
}

/**
 * The whole recovery, in the order that survives the reload:
 * record first, then ask whether a reload is safe, then reload.
 */
export function recoverFromCrash(err: unknown, componentStack?: string): void {
  recordCrash(err, componentStack);
  if (!shouldAutoReload()) return;
  markAutoReload();
  window.location.reload();
}
