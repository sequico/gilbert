/**
 * Settings that follow the account rather than the browser.
 *
 * A setting kept only in localStorage does not travel between devices — most
 * painfully the default identity, where the fallback is whichever address sorts
 * first, so a forgotten setting sends mail from an address the recipient may
 * not know (issue #54).
 *
 * The store is a `settings.json` in the account's own JMAP Files, beside the
 * signature images that are already kept there. That keeps Gilbert itself
 * stateless: no volume, no database, nothing to back up separately, and the
 * settings are covered by whatever backs up the mail store.
 *
 * localStorage stays as a cache: it is what paints the first frame, and the
 * file overwrites it once it lands. A browser with no cache (a private window)
 * therefore shows defaults for one frame before the account's real settings
 * arrive.
 */
import { APP_DOCUMENT_TYPE } from "@gilbert/shared/appFolder";
import { isRecord } from "@gilbert/shared/json";
import { SETTINGS_FILE } from "@gilbert/shared/settingsDocument";
import { CAP, client } from "@/jmap/client";
import {
  ensureFolder,
  findInFolderWithState,
  isStateMismatch,
  writeAppJson,
} from "@/lib/appFolder";
import { t } from "@/lib/i18n";
import { useSession } from "@/store/session";
import { toast } from "@/ui/toast";

/* How long a change sits before it is written up. */
const DEBOUNCE_MS = 3000;
/** How long a failed write waits before trying again. */
const RETRY_DEBOUNCE_MS = 15_000;
/**
 * How many times one save re-reads the file and re-applies its change.
 *
 * The server's own appends answer a lost compare-and-set the same way — read
 * again rather than write the stale copy harder (`AUDIT_CAS_ATTEMPTS`,
 * `server/src/agent/store.ts`) — and the number is small because a save that
 * loses this many races in a row is a save against an account somebody or
 * something is writing continuously, which the caller's own retry
 * (`flushSettingsPush`) is the better answer for.
 */
const CAS_ATTEMPTS = 3;

let timer: number | null = null;
let pending: Record<string, unknown> | null = null;
/**
 * Which change `pending` holds, bumped every time one is queued.
 *
 * A failed write retries the change it captured, and the retry must not write
 * an older snapshot back over a newer one: this is what lets it tell whether a
 * newer change has been queued since, and drop the stale retry when one has.
 */
let queuedSeq = 0;
let inFlight: Promise<void> | null = null;
/** Nothing is pushed before the first load has settled, or we would race it. */
let armed = false;
let loadedFor: string | null = null;
let listenersBound = false;
/** One toast per failing streak, not one per retry. */
let warnedOfFailure = false;

export function settingsSyncAvailable(): boolean {
  return (
    client.hasCapability(CAP.filenode) &&
    Boolean(useSession.getState().ownAccountFor(CAP.filenode))
  );
}

/**
 * What one read of the settings file found.
 *
 * Three answers, and the middle one is the whole point: `absent` is the
 * server's own word that there is no `settings.json` yet, which is an account
 * to seed; `unreadable` is everything else that was not a document — a listing
 * that failed, a blob that did not download, bytes that are not JSON. Those are
 * *not* an empty account, and a writer that treated them as one would replace
 * settings nobody could read with whatever this device happens to hold.
 */
export type SettingsRead =
  | { kind: "absent"; state: string }
  | { kind: "ok"; doc: Record<string, unknown>; state: string }
  | { kind: "unreadable"; state: string };

/**
 * Read the account's settings file.
 *
 * A file that is there and could not be read is answered `unreadable`, never
 * `absent`: the cached settings are still perfectly good, and the account's own
 * copy is not this device's to replace. Neither answer costs anyone their
 * session.
 */
export async function loadRemoteSettings(): Promise<SettingsRead> {
  if (!settingsSyncAvailable()) return { kind: "absent", state: "" };
  const accountId = useSession.getState().ownAccountFor(CAP.filenode)!;
  let folderId: string;
  try {
    folderId = await ensureFolder(accountId);
  } catch {
    // Not even the folder could be reached, so nothing was read and nothing is
    // known about the file: seeding here would queue a write over a copy that
    // may well be there.
    return { kind: "unreadable", state: "" };
  }
  return readSettingsFile(accountId, folderId);
}

/**
 * The settings document as it stands, with the FileNode state that read saw.
 *
 * The two have to come from one read. A token taken at one moment and a
 * document read at another is the race the writer exists to avoid: it would
 * compare the write against a state the document was never seen in, so a change
 * somebody else made in between would pass as the writer's own and be
 * overwritten.
 *
 * The state comes back either way, so the save that creates the file is as
 * conditional as the one that replaces it: an account with no `settings.json`
 * yet is exactly where two tabs first saving at once would otherwise make two
 * of them.
 */
async function readSettingsFile(
  accountId: string,
  folderId: string,
): Promise<SettingsRead> {
  let found: Awaited<ReturnType<typeof findInFolderWithState>>;
  try {
    found = await findInFolderWithState(accountId, folderId, SETTINGS_FILE);
  } catch {
    // The listing failed: nothing is known about the file, and "absent" would
    // be a guess that ends with a second copy of a document nobody saw.
    return { kind: "unreadable", state: "" };
  }
  if (!found.file?.blobId) return { kind: "absent", state: found.state };
  try {
    const text = await client.fetchBlobText(
      accountId,
      found.file.blobId,
      APP_DOCUMENT_TYPE,
    );
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return { kind: "unreadable", state: found.state };
    return { kind: "ok", doc: parsed, state: found.state };
  } catch {
    return { kind: "unreadable", state: found.state };
  }
}

/**
 * Has this account's settings file already been read on this page load?
 *
 * The subtree that does the reading is keyed on the language version and so
 * is deliberately remounted whenever somebody picks a language. The account
 * is claimed only once the read has actually settled (`armSettingsSync`), so
 * a remount that cancels a read still in flight is answered "not yet" and
 * reads again -- claiming at the start would let a cancelled read consume the
 * claim, after which the remount would skip the read entirely and never arm
 * sync for that session.
 *
 * Cleared by `stopSettingsSync`, so signing out and back in reads again.
 */
export function settingsAlreadyLoadedFor(accountId: string | null | undefined): boolean {
  if (!accountId) return true;
  return loadedFor === accountId;
}

/** Allow pushes. Called once the first load has settled, either way. */
export function armSettingsSync(): void {
  armed = true;
  // The read that just settled is what this page load will trust; claim the
  // account for it so a later remount does not read again.
  const accountId = useSession.getState().accountId;
  if (accountId && !loadedFor) loadedFor = accountId;
  bindFlushListeners();
  // A change made while the read was in flight has been waiting for this.
  if (pending) void flushSettingsPush();
}

/** Stop syncing and drop anything queued (logout). */
export function stopSettingsSync(): void {
  armed = false;
  loadedFor = null;
  pending = null;
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

/**
 * Queue the synced settings for writing. Called on every change — including
 * each frame of a splitter drag — so it coalesces: the newest value wins and
 * one request goes out once the changes stop.
 */
export function queueSettingsPush(synced: Record<string, unknown>): void {
  if (!settingsSyncAvailable()) return;
  /*
   * Held, not dropped, before the first load has settled.
   *
   * Returning here would silently throw the change away: a language picked in
   * the second or so before the settings file comes back is never written, so
   * it survives until the next reload and no further. That is the other half of
   * "sometimes it takes several clicks" -- the click that sticks is one made
   * after the read has finished.
   *
   * Keeping it is safe because `hydrate` refuses to overwrite a key that is
   * still queued, so the newer local change wins over the older file rather
   * than racing it. `armSettingsSync` writes whatever is waiting.
   */
  pending = synced;
  queuedSeq += 1;
  if (!armed) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void flushSettingsPush();
  }, DEBOUNCE_MS);
}

/**
 * The keys of a change that has been made but not yet written up.
 *
 * `hydrate` needs these: a settings file read from the server is older than an
 * unflushed local change by definition, so applying it wholesale hands the
 * user back the value they just replaced. Switching language shows it — it
 * remounts the tree, the remount re-reads the file, and the file still says the
 * older language — but the race is general and a slow read would lose any click
 * made inside the debounce window.
 */
export function pendingSettingsKeys(): ReadonlySet<string> {
  return new Set(pending ? Object.keys(pending) : []);
}

/**
 * Write anything queued now, rather than waiting out the debounce.
 *
 * A failure here must not be swallowed: the change stays applied in memory for
 * the rest of the session, nothing puts it back on the write queue, so the
 * account's `settings.json` quietly keeps the old value and the next
 * `hydrate()` (another device, the next sign-in) reverts a change the person
 * believed had stuck. A failure puts the change back on the queue and retries
 * shortly, unless a newer change has been queued since -- which is the newer
 * truth and would only be reverted by writing the older one -- and tells the
 * person once per failing streak.
 */
export async function flushSettingsPush(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (!pending || !armed) return;
  const body = pending;
  const bodySeq = queuedSeq;
  pending = null;
  let failure: unknown;
  // Serialise: two overlapping writes could land in either order. The failure
  // is caught inside this chain so it can never break that ordering for the
  // next flush, and captured separately so this call can act on it below.
  inFlight = (inFlight ?? Promise.resolve()).then(() =>
    writeSettings(body).catch((err: unknown) => {
      failure = err;
    }),
  );
  await inFlight;
  if (!failure) {
    warnedOfFailure = false;
    return;
  }
  /*
   * Retry only while this change is still the newest one. A change queued since
   * is the newer truth -- its own debounce writes it, or it has already landed
   * as another flush -- and re-queuing the older body would write it back over
   * newer state: the same silent revert the writer's compare-and-set guards
   * against between tabs, reached here through a retry instead.
   */
  if (armed && queuedSeq === bodySeq) {
    pending = body;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void flushSettingsPush();
    }, RETRY_DEBOUNCE_MS);
  }
  if (!warnedOfFailure) {
    warnedOfFailure = true;
    toast.error(
      t("Your settings could not be saved: {error}", {
        error: (failure as Error).message ?? String(failure),
      }),
    );
  }
}

/**
 * Write the queued settings into the account's file, against the state the
 * document was read in.
 *
 * `settings.json` is one fixed name that every tab of every device of this
 * account saves whole, so two saves can overlap and the later one can be the
 * older one. The write therefore carries the FileNode state of the read it was
 * built from, and the mail server refuses it when anything in the account has
 * changed since — a lost compare-and-set rather than a last-write-wins that
 * silently reverts whichever tab saved first.
 *
 * Losing it is not a failure, it is a slower save: the file is read again, the
 * pending change is applied on top of what is there now, and it is written
 * against the token that read produced. The queued body is the whole synced
 * document, so the retry is not a merge of two tabs' edits — it is this save
 * landing on the document as the account holds it, with every key this client
 * does not carry left where the file has it.
 */
async function writeSettings(body: Record<string, unknown>): Promise<void> {
  if (!settingsSyncAvailable()) return;
  const accountId = useSession.getState().ownAccountFor(CAP.filenode)!;
  /*
   * The folder first, then the read, then the write. Creating the app folder is
   * itself a FileNode write, so a token read before `ensureFolder` would be
   * stale before the write that meant to compare against it — and a first save
   * into an account that keeps no app folder yet is exactly when that happens.
   * `writeAppJson` finds the folder already there when it runs.
   */
  const folderId = await ensureFolder(accountId);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const read = await readSettingsFile(accountId, folderId);
    /*
     * A file that is there and could not be read is not an empty one. Writing
     * here would land this device's copy on top of it — the whole queued
     * document, so every key the account holds is replaced by whatever this
     * client happens to carry. The change stays queued and the failure is the
     * caller's to report.
     */
    if (read.kind === "unreadable")
      throw new Error("the settings file could not be read");
    /*
     * The queued settings over the document as it reads now. The queued body is
     * the whole synced document — `queueSettingsPush` is handed
     * `syncedPart(settings)` — so this save lands as it was meant to for every
     * key this client owns, and a key it has never heard of, written by a newer
     * client into the same file, is left where it is rather than dropped on the
     * way past.
     */
    const next = { ...(read.kind === "ok" ? read.doc : {}), ...body };
    try {
      await writeAppJson(accountId, SETTINGS_FILE, next, {
        ifInState: read.state,
        type: APP_DOCUMENT_TYPE,
      });
      return;
    } catch (err) {
      // Somebody wrote the file between the read and this write. Round again:
      // the next read is the one whose token is current. Any other refusal — a
      // server that will not take the write at all — is the caller's to report.
      if (!isStateMismatch(err)) throw err;
    }
  }
  throw new Error("the settings file kept changing under the writer");
}

/**
 * A debounce that outlives the page helps no one, so a tab going away writes
 * first. `visibilitychange` is the one that fires reliably on mobile; `pagehide`
 * covers the desktop close.
 */
function bindFlushListeners(): void {
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;
  const flush = () => {
    if (pending) void flushSettingsPush();
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
