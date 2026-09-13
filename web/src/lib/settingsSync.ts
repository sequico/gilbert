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
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { FileNode, Id, SetResponse } from "@/jmap/types";
import { ensureFolder, findInFolder, nodeBlobId } from "@/lib/appFolder";
import { fileCreate } from "@/lib/filenode";
import { t } from "@/lib/i18n";
import { useSession } from "@/store/session";
import { toast } from "@/ui/toast";

const FILE = "settings.json";
const TYPE = "application/json";

/** How long a change sits before it is written up. */
const DEBOUNCE_MS = 3000;
/** How long a failed write waits before trying again. */
const RETRY_DEBOUNCE_MS = 15_000;

let timer: number | null = null;
let pending: Record<string, unknown> | null = null;
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
 * Read the account's settings file. Returns null when there is nothing to read
 * — no file yet, no Files, an older server — which leaves the local cache in
 * charge rather than wiping it.
 */
export async function loadRemoteSettings(): Promise<Record<string, unknown> | null> {
  if (!settingsSyncAvailable()) return null;
  const accountId = useSession.getState().ownAccountFor(CAP.filenode)!;
  try {
    const folderId = await ensureFolder(accountId);
    const node = await findInFolder(accountId, folderId, FILE);
    if (!node?.blobId) return null;
    const text = await client.fetchBlobText(accountId, node.blobId, TYPE);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // A settings file we cannot read must not cost anyone their session; the
    // cached settings are still perfectly good.
    return null;
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
 * A write that fails here used to be swallowed outright: the change stayed
 * applied in memory for the rest of the session, with nothing that ever put
 * it back on the write queue — so the account's `settings.json` quietly kept
 * the old value, and the next `hydrate()` (another device, the next sign-in)
 * silently reverted a change the person believed had stuck. A failure now
 * re-queues the change, merged under anything newer that arrived while it was
 * in flight, retries shortly, and tells the person once per failing streak.
 */
export async function flushSettingsPush(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (!pending || !armed) return;
  const body = pending;
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
  // The newer value always wins over the one that just failed to write.
  const arrivedSince = pending;
  pending = Object.assign({}, body, arrivedSince ?? {});
  if (armed) {
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

async function writeSettings(body: Record<string, unknown>): Promise<void> {
  if (!settingsSyncAvailable()) return;
  const accountId = useSession.getState().ownAccountFor(CAP.filenode)!;
  const json = JSON.stringify(body, null, 2);
  // Byte length, not character count: a template or a signature with any
  // non-ASCII in it would otherwise be reported shorter than it is.
  const blob = new Blob([json], { type: TYPE });
  const up = await client.upload(accountId, blob, { type: TYPE });
  const folderId = await ensureFolder(accountId);
  const existing = await findInFolder(accountId, folderId, FILE);
  if (existing) {
    const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
      accountId,
      update: { [existing.id]: { blobId: up.blobId, type: TYPE, size: blob.size } },
    });
    const err = res.notUpdated?.[existing.id];
    if (err) throw new Error(setErrorMessage(err));
    return;
  }
  const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
    accountId,
    create: { s: fileCreate(folderId, FILE, up.blobId, TYPE) },
  });
  const err = res.notCreated?.s;
  if (err) throw new Error(setErrorMessage(err));
  // Some servers hand back no blobId on create; ask, so the next read finds it.
  await nodeBlobId(
    accountId,
    (res.created?.s as Partial<FileNode> | undefined)?.id as Id | undefined,
  );
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
