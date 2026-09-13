import { appDocumentJson } from "@gilbert/shared/appDocument";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client, JmapMethodError } from "@/jmap/client";
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
 * A signed-in session whose Files live in a personal account.
 *
 * Both the settings store and the app folder are reached through
 * `ownAccountFor(CAP.filenode)`, so this is the account every test here writes
 * to.
 */
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
  beforeEach(() => {
    stopSettingsSync();
    useSession.setState({
      status: "authenticated",
      session: FAKE_SESSION(),
      accountId: "a1",
    });
    vi.spyOn(client, "hasCapability").mockReturnValue(true);
    // The read the writer makes before it writes — the token it compares
    // against and the document it merges into. These tests are about the queue
    // and the retry, so the folder is simply there and holds no file yet.
    vi.spyOn(appFolder, "ensureFolder").mockResolvedValue("af");
    vi.spyOn(appFolder, "findInFolderWithState").mockResolvedValue({
      file: undefined,
      state: "0",
    });
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

/**
 * The app folder as the save path sees it: one settings document, a FileNode
 * state that moves whenever anything is written, and a `FileNode/set` that
 * refuses a stale `ifInState` with `stateMismatch`.
 *
 * That refusal is Stalwart 0.16's own answer rather than a stand-in for it
 * (live, `scripts/probe-conditional-writes.mjs`), and the server mock enforces
 * the same thing, so a save that loses the race here loses it on a real server
 * too. Only the app folder and the one file in it are modelled: what these
 * tests are about is the save path, not the Files protocol, which the writer's
 * own tests cover (`appFolder.test.ts`).
 */
function fakeAppFolder(initial: Record<string, unknown> | null) {
  interface FakeNode {
    id: string;
    parentId: string;
    name: string;
    nodeType: "file";
    blobId: string;
    type: string;
  }

  const folder = { id: "af", parentId: null, name: "gilbert", nodeType: "directory" };
  const settings = (blobId: string): FakeNode => ({
    id: "n1",
    parentId: "af",
    name: "settings.json",
    nodeType: "file",
    blobId,
    type: "application/json",
  });
  let node: FakeNode | null = initial ? settings("b1") : null;
  const blobs = new Map<string, string>();
  if (node) blobs.set(node.blobId, appDocumentJson(initial));
  const sets: Array<Record<string, unknown>> = [];
  const uploads: string[] = [];
  let state = 1;
  let seq = 0;
  /** Another tab's save, landing just before the next set: a race, in order. */
  let otherTab: Record<string, unknown> | null = null;

  vi.spyOn(client, "chain").mockImplementation(async (calls) => {
    const out = new Map<string, Record<string, unknown>[]>();
    let lastIds: string[] = [];
    for (const [method, args, id] of calls) {
      if (method === "FileNode/query") {
        const filter = (args.filter ?? {}) as { parentId?: string };
        // The top level holds the app folder; the app folder holds the file.
        lastIds = filter.parentId ? (node ? [node.id] : []) : [folder.id];
        out.set(id, [
          {
            accountId: "a1",
            queryState: "1",
            canCalculateChanges: false,
            position: 0,
            ids: lastIds,
            total: lastIds.length,
          },
        ]);
      } else if (method === "FileNode/get") {
        const properties = args.properties as string[] | undefined;
        const ids = args["#ids"] ? lastIds : ((args.ids as string[] | null) ?? []);
        const list: Record<string, unknown>[] = [];
        if (ids.includes(folder.id)) list.push({ ...folder });
        if (node && ids.includes(node.id)) {
          const picked: Record<string, unknown> = { id: node.id };
          for (const key of properties ?? Object.keys(node))
            if (key in node)
              picked[key] = (node as unknown as Record<string, unknown>)[key];
          list.push(picked);
        }
        out.set(id, [{ accountId: "a1", state: `s${state}`, list, notFound: [] }]);
      }
    }
    return out;
  });

  vi.spyOn(client, "fetchBlobText").mockImplementation(
    async (_accountId, blobId) => blobs.get(blobId as string) ?? "",
  );

  vi.spyOn(client, "upload").mockImplementation(async (_accountId, data) => {
    // jsdom's Blob has no `text()`, so a reader reads it.
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(data as Blob);
    });
    uploads.push(text);
    const blobId = `up-${++seq}`;
    blobs.set(blobId, text);
    return {
      accountId: "a1",
      blobId,
      type: "application/json",
      size: text.length,
    } as never;
  });

  vi.spyOn(client, "call").mockImplementation((async (
    method: string,
    args: Record<string, unknown>,
  ) => {
    if (method === "FileNode/get") {
      const ids = (args.ids as string[] | undefined) ?? [];
      return {
        accountId: "a1",
        state: `s${state}`,
        list: node && ids.includes(node.id) ? [{ id: node.id, blobId: node.blobId }] : [],
        notFound: [],
      };
    }
    if (method !== "FileNode/set") return { accountId: "a1" };
    sets.push(args);
    // The other tab's save lands here, between this tab's read and its write.
    if (otherTab) {
      const blobId = `up-${++seq}`;
      blobs.set(blobId, appDocumentJson(otherTab));
      node = settings(blobId);
      otherTab = null;
      state += 1;
    }
    const token = args.ifInState as string | undefined;
    if (token !== undefined && token !== `s${state}`) {
      throw new JmapMethodError("FileNode/set", {
        type: "stateMismatch",
        description: "An ifInState argument was supplied, but it does not match",
      });
    }
    const patch = args.update as Record<string, { blobId?: string }> | undefined;
    if (patch)
      for (const [id, values] of Object.entries(patch)) {
        node = values.blobId ? settings(values.blobId) : settings(node?.blobId ?? id);
      }
    const create = args.create as Record<string, { blobId: string }> | undefined;
    const created: Record<string, unknown> = {};
    if (create)
      for (const [key, spec] of Object.entries(create)) {
        node = settings(spec.blobId);
        created[key] = { id: node.id };
      }
    state += 1;
    return {
      accountId: "a1",
      oldState: `s${state}`,
      newState: `s${state}`,
      created,
      updated: {},
      destroyed: [],
    };
  }) as never);

  return {
    sets,
    uploads,
    state: () => `s${state}`,
    /** The other tab promises this document up before the next set. */
    otherTabSaves: (doc: Record<string, unknown>) => {
      otherTab = doc;
    },
  };
}

/**
 * The save path with the real writer in it.
 *
 * Every test above spies on `writeAppJson`, which is right for what they are
 * about — the queue, the debounce, the retry after a failure — and leaves the
 * one behaviour `settings.json` is at risk from unexercised: what the write
 * itself does when a second tab saves to the same fixed name between this tab's
 * read and its write. These run the writer as it stands, through the queue and
 * the flush, against a FileNode store that refuses a stale `ifInState`.
 */
describe("the save path itself", () => {
  beforeEach(() => {
    stopSettingsSync();
    useSession.setState({
      status: "authenticated",
      session: FAKE_SESSION(),
      accountId: "a1",
    });
    vi.spyOn(client, "hasCapability").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stopSettingsSync();
    useSession.setState({ status: "loading", session: null, accountId: null });
  });

  it("writes the queued settings into the account's file, against the state it read", async () => {
    const server = fakeAppFolder({ theme: "light", locale: "it-IT" });
    armSettingsSync();
    queueSettingsPush({ theme: "dark", locale: "en-US" });
    await flushSettingsPush();
    // One write, and it carried a token: this is the path a real save takes,
    // not the mocked writer the tests above stop at.
    expect(server.sets).toHaveLength(1);
    expect(server.sets[0]?.ifInState).toBe("s1");
    expect(JSON.parse(server.uploads[0] ?? "")).toEqual({
      theme: "dark",
      locale: "en-US",
    });
  });

  it("re-reads, re-applies and lands when another tab wins the compare-and-set", async () => {
    const server = fakeAppFolder({ theme: "light" });
    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => 1);
    armSettingsSync();
    queueSettingsPush({ theme: "dark", locale: "en-US" });
    // The other tab saves between this tab's read and its write, which is the
    // race a fixed file name saves to: the first write is refused, and the blob
    // it uploaded is left unreferenced. Its document carries a key this tab has
    // never heard of, as a newer client's would.
    server.otherTabSaves({ theme: "light", locale: "it-IT", weekStart: 0 });
    await flushSettingsPush();

    // Two attempts, each carrying the token of the read it was built from: the
    // second landed, because its read was the current one.
    expect(server.sets).toHaveLength(2);
    expect(server.sets[0]?.ifInState).toBe("s1");
    expect(server.sets[1]?.ifInState).toBe("s2");
    // The save landed as it was meant to, and the file was read on the way: the
    // key this tab does not know is still in the document afterwards.
    expect(JSON.parse(server.uploads[1] ?? "")).toEqual({
      theme: "dark",
      locale: "en-US",
      weekStart: 0,
    });
    // A lost compare-and-set is a slower save, not a failure to report.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("makes the account's first save conditional too, so two tabs do not both create it", async () => {
    const server = fakeAppFolder(null);
    armSettingsSync();
    queueSettingsPush({ theme: "dark" });
    // The other tab creates the file between this tab's read — which found no
    // file at all — and its create.
    server.otherTabSaves({ locale: "it-IT" });
    await flushSettingsPush();

    expect(server.sets).toHaveLength(2);
    expect(server.sets[0]?.ifInState).toBe("s1");
    expect(server.sets[1]?.ifInState).toBe("s2");
    // The retry lands on the file the other tab made — an update, not a second
    // create — so the account holds one `settings.json` with both saves in it.
    expect(server.sets[0]?.create).toBeDefined();
    expect(server.sets[1]?.update).toBeDefined();
    expect(server.uploads).toHaveLength(2);
    expect(JSON.parse(server.uploads[1] ?? "")).toEqual({
      locale: "it-IT",
      theme: "dark",
    });
  });
});
