import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useSession } from "@/store/session";
import {
  acceptRemote,
  DEFAULT_SETTINGS,
  DEVICE_KEYS,
  mergeRemote,
  type Settings,
  syncedPart,
} from "@/store/settings";
import { toast } from "@/ui/toast";
import * as appFolder from "../appFolder";
import { APP_FOLDER, isAppFolder } from "../appFolder";
import {
  armSettingsSync,
  flushSettingsPush,
  queueSettingsPush,
  settingsAlreadyLoadedFor,
  stopSettingsSync,
} from "../settingsSync";

/**
 * Settings used to live only in localStorage, so nothing followed the user
 * between devices — issue #54, whose sharpest case is the default identity:
 * with none set, the address that sorts first wins, so mail goes out from an
 * address the recipient may not recognise.
 *
 * The split is written as a list of exceptions, which means the interesting
 * test is not "does this key sync" but "does a key added later sync without
 * anyone remembering to add it".
 */

describe("which settings follow the account", () => {
  it("syncs everything that is not explicitly device-local", () => {
    const synced = syncedPart(DEFAULT_SETTINGS);
    const expected = (Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>).filter(
      (k) => !DEVICE_KEYS.has(k),
    );
    expect(Object.keys(synced).sort()).toEqual(expected.sort());
  });

  it("keeps this screen's and this browser's settings out of the file", () => {
    const synced = syncedPart(DEFAULT_SETTINGS);
    // A pane width picked on a monitor is wrong on a laptop, and the
    // notification toggles track a per-browser permission grant.
    for (const key of [
      "listPaneWidth",
      "listPaneHeight",
      "density",
      "fontSize",
      "sidebarCollapsed",
      "desktopNotifications",
      "notificationSound",
    ]) {
      expect(synced, key).not.toHaveProperty(key);
    }
  });

  it("syncs the default identity, which is what #54 was actually about", () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      defaultIdentityByAccount: { a1: "i7" },
    };
    expect(syncedPart(settings).defaultIdentityByAccount).toEqual({ a1: "i7" });
  });

  it("syncs theme and reading pane", () => {
    const synced = syncedPart({
      ...DEFAULT_SETTINGS,
      theme: "dark",
      readingPane: "bottom",
    });
    expect(synced.theme).toBe("dark");
    expect(synced.readingPane).toBe("bottom");
  });
});

describe("applying a settings file", () => {
  /*
   * A file carrying the old `theme` and no palette is read through the old
   * enum, so these gain the two fields it resolves to. That is the migration,
   * not a leak: see the palette tests for the rule itself.
   */
  const MIGRATED_DARK = { theme: "dark", palette: "default", mode: "dark" };

  it("takes known, non-device keys", () => {
    const applied = acceptRemote({ theme: "dark", weekStart: 0, locale: "de-DE" });
    expect(applied).toEqual({ ...MIGRATED_DARK, weekStart: 0, locale: "de-DE" });
  });

  it("ignores keys it has never heard of", () => {
    // A newer Gilbert's settings, or a hand-edited file.
    expect(acceptRemote({ theme: "dark", somethingNewer: 42 })).toEqual(MIGRATED_DARK);
  });

  it("refuses device keys even when the file carries them", () => {
    // An earlier build wrote the whole settings object up; that file must not
    // now drag one machine's pane width onto every other one.
    expect(
      acceptRemote({ theme: "dark", listPaneWidth: 900, fontSize: "large" }),
    ).toEqual(MIGRATED_DARK);
  });

  it("does not invent keys from an empty file", () => {
    expect(acceptRemote({})).toEqual({});
  });

  it("keeps a false or zero value, which is not the same as absent", () => {
    const applied = acceptRemote({ conversationMode: false, markReadDelay: 0 });
    expect(applied).toEqual({ conversationMode: false, markReadDelay: 0 });
  });
});

describe("the client's own folder", () => {
  it("is a top-level directory under the app folder's name, and nothing else", () => {
    expect(APP_FOLDER).toBe("gilbert");
    expect(isAppFolder({ name: APP_FOLDER, parentId: null, nodeType: "directory" })).toBe(
      true,
    );
  });

  it("is not a folder of that name someone made inside another one", () => {
    expect(isAppFolder({ name: APP_FOLDER, parentId: "n1", nodeType: "directory" })).toBe(
      false,
    );
  });

  it("is not a file that happens to be called that", () => {
    expect(isAppFolder({ name: APP_FOLDER, parentId: null, nodeType: "file" })).toBe(
      false,
    );
  });

  it("is not some other top-level folder", () => {
    expect(isAppFolder({ name: "Work", parentId: null, nodeType: "directory" })).toBe(
      false,
    );
  });
});

/**
 * Picking a language used to come undone.
 *
 * The subtree that reads the account's settings file is keyed on the language
 * version, so choosing a language throws it away and builds it again. The
 * remount re-read the file — which still held the old language, because the
 * write is debounced by three seconds — and applied it, putting the old
 * language back. Reported as "sometimes it takes several clicks": the click
 * that appeared to work was the one made after the previous write had landed.
 */
describe("a change made but not yet written up", () => {
  it("is not read back over by the file it has not reached yet", () => {
    const current: Settings = { ...DEFAULT_SETTINGS, uiLanguage: "ja" };
    const file = { uiLanguage: "en", theme: "dark" };
    const merged = mergeRemote(current, file, new Set(["uiLanguage"]));
    expect(merged.uiLanguage).toBe("ja");
    // Only the queued key is held back; the rest of the file still applies.
    expect(merged.theme).toBe("dark");
  });

  it("applies the whole file when nothing is queued", () => {
    const current: Settings = { ...DEFAULT_SETTINGS, uiLanguage: "ja" };
    const merged = mergeRemote(current, { uiLanguage: "en" });
    expect(merged.uiLanguage).toBe("en");
  });

  it("claims the account only once the load has settled", () => {
    stopSettingsSync();
    useSession.setState({ accountId: "a1" });
    // A mount starts the read...
    expect(settingsAlreadyLoadedFor("a1")).toBe(false);
    /*
     * ...and a remount while it is still in flight (picking a language
     * unmounts the reading subtree and cancels the first read) must not be
     * told "already loaded": a claim consumed by a cancelled read made the
     * remount skip the read and never arm sync for the session.
     */
    expect(settingsAlreadyLoadedFor("a1")).toBe(false);
    // Only the read that actually settles claims the account.
    armSettingsSync();
    expect(settingsAlreadyLoadedFor("a1")).toBe(true);
    // Signing out drops the claim, so signing back in reads the file rather
    // than trusting whatever the previous session left behind.
    stopSettingsSync();
    expect(settingsAlreadyLoadedFor("a1")).toBe(false);
    stopSettingsSync();
    useSession.setState({ accountId: null });
  });

  it("treats a missing account as already loaded, so nothing is fetched", () => {
    expect(settingsAlreadyLoadedFor(null)).toBe(true);
    expect(settingsAlreadyLoadedFor(undefined)).toBe(true);
  });
});

/**
 * Business logic review finding: a write that failed here used to be
 * swallowed outright by `flushSettingsPush`'s own `.catch(() => undefined)`,
 * with nothing that ever put the change back on the queue. The account's
 * `settings.json` was left holding the old value, and the next `hydrate()`
 * (another device, the next sign-in) silently reverted a change the person
 * believed had stuck, with no error anywhere.
 */
describe("a settings write that fails", () => {
  const FAKE_SESSION = () =>
    ({
      capabilities: { [CAP.core]: {}, [CAP.filenode]: {} },
      accounts: {
        a1: {
          name: "me@example.com",
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: { [CAP.filenode]: {} },
        },
      },
      primaryAccounts: { [CAP.filenode]: "a1" },
      state: "s1",
    }) as unknown as JmapSession;

  beforeEach(() => {
    stopSettingsSync();
    useSession.setState({ status: "authenticated", session: FAKE_SESSION(), accountId: "a1" });
    vi.spyOn(client, "hasCapability").mockReturnValue(true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    stopSettingsSync();
    useSession.setState({ status: "loading", session: null, accountId: null });
  });

  it("re-queues the change, reports it, and retries until it lands", async () => {
    let attempt = 0;
    vi.spyOn(appFolder, "writeAppJson").mockImplementation((async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("upstream unavailable");
      return { id: "n1", blobId: "b1" };
    }) as never);
    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => 1);

    armSettingsSync();
    queueSettingsPush({ theme: "dark" });
    await vi.advanceTimersByTimeAsync(3_000); // DEBOUNCE_MS: the first, failing attempt
    expect(attempt).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000); // RETRY_DEBOUNCE_MS: the retry
    expect(attempt).toBe(2);

    // No second toast for a retry that then succeeds, and no further retry is
    // scheduled once the write has actually landed.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempt).toBe(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("merges a newer change into the retried write rather than losing either", async () => {
    let attempt = 0;
    const written: unknown[] = [];
    vi.spyOn(appFolder, "writeAppJson").mockImplementation((async (
      _accountId: string,
      _name: string,
      value: unknown,
    ) => {
      attempt += 1;
      written.push(value);
      if (attempt === 1) throw new Error("upstream unavailable");
      return { id: "n1", blobId: "b1" };
    }) as never);
    vi.spyOn(toast, "error").mockImplementation(() => 1);

    armSettingsSync();
    queueSettingsPush({ theme: "dark" });
    await flushSettingsPush(); // fails immediately, bypassing the debounce
    expect(attempt).toBe(1);

    // A second, newer change arrives before the retry has fired.
    queueSettingsPush({ theme: "dark", locale: "it-IT" });
    await vi.advanceTimersByTimeAsync(3_000); // the newer change's own debounce
    expect(attempt).toBe(2);
    expect(written).toHaveLength(2);
    // The retry sent the newer value, not the stale one it first tried and
    // failed to write — the newer change is not lost behind a failed one.
    expect(written[1]).toEqual({ theme: "dark", locale: "it-IT" });
  });
});
