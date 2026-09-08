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
 * that reaches the root boundary is answered with one unconditional reload,
 * guarded so a genuine bug cannot loop.
 *
 * The reload is safe for the session: it lives in the sealed cookie and the
 * server's session file, not in the tab. What the reload would erase is the
 * evidence, so the crash is written down first, where a reload cannot reach
 * it — `localStorage` survives, and support can read it back.
 */

const CRASH_KEY = "gilbert:last-crash";
const RELOAD_KEY = "gilbert:auto-reload-at";

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
 * was. The page is left for a human, the way it was before this existed.
 */
const RELOAD_COOLDOWN_MS = 120_000;

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

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Some privacy modes throw on access; a crash record is best-effort.
    return null;
  }
}

function pageAliveMs(): number {
  return Date.now() - performance.timeOrigin;
}

function readRaw(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    /* best-effort, as above */
  }
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
  writeRaw(CRASH_KEY, JSON.stringify(record));
  console.error(
    "[gilbert] an uncaught error stopped the app; the crash is recorded and a reload will be attempted once",
    record,
  );
  return record;
}

/** The last recorded crash, for support to read back after a reload. */
export function readCrashRecord(): CrashRecord | null {
  const raw = readRaw(CRASH_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CrashRecord;
  } catch {
    return null;
  }
}

function lastAutoReloadAt(): number | null {
  const raw = readRaw(RELOAD_KEY);
  if (!raw) return null;
  const at = Number(raw);
  return Number.isFinite(at) ? at : null;
}

/** Whether an automatic reload is safe to attempt right now. */
export function shouldAutoReload(): boolean {
  if (pageAliveMs() < MIN_ALIVE_MS) return false;
  const last = lastAutoReloadAt();
  if (last !== null && Date.now() - last < RELOAD_COOLDOWN_MS) return false;
  return true;
}

/** Remember that an automatic reload was attempted, before the page goes. */
export function markAutoReload(): void {
  writeRaw(RELOAD_KEY, String(Date.now()));
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
