import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSettingsPolicyForTest } from "@/lib/settingsPolicy";
import { clearAllData, clearSignedInData, setDeviceTrusted } from "@/lib/storage";
import { useSession } from "@/store/session";
import {
  DEFAULT_SETTINGS,
  DEVICE_KEYS,
  type Settings,
  settingsInHandFor,
  syncedPart,
  useSettings,
} from "@/store/settings";

/*
 * Which account's settings are in hand, and what happens at the boundary
 * between two of them.
 *
 * Signing out and back in in the same tab must not leave the first reader's
 * settings in the store: their pinned signers, trusted image senders, internal
 * domains and interface language paint the second reader's first frame, and an
 * `update` in that window queues the whole stale snapshot for the new account's
 * settings file. Clearing the stored copy on the way out and stopping sync
 * touches neither of those: the copy React holds is the third thing, and the
 * one this file pins.
 *
 * Around it, three smaller claims: a reset writes the derived legacy theme it
 * promises, an import is read through the same pre-palette migration the
 * account's own file gets, and folder colours follow the account -- which is
 * what the code does and what its comment now says.
 */

/** What the settings push would write: the last full snapshot queued. */
const syncMock = vi.hoisted(() => {
  let last: Record<string, unknown> | null = null;
  return {
    push: vi.fn((synced: Record<string, unknown>) => {
      last = synced;
    }),
    pendingKeys: () => new Set(Object.keys(last ?? {})),
    latest: () => last,
    reset: () => {
      last = null;
    },
  };
});

vi.mock("@/lib/settingsSync", () => ({
  queueSettingsPush: syncMock.push,
  pendingSettingsKeys: syncMock.pendingKeys,
  /*
   * The settings store reaches the session store now -- it drops what it holds
   * when a session ends -- and that imports these two for `logout` and the 401
   * handler. A mock stands in for the whole module, so everything on the way in
   * gets a stand-in as well.
   */
  flushSettingsPush: vi.fn(),
  stopSettingsSync: vi.fn(),
}));

const signIn = (id: string) =>
  useSession.setState({ status: "authenticated", accountId: id });
const signOut = () =>
  useSession.setState({ status: "anonymous", session: null, accountId: null });

/**
 * A localStorage the store can actually use. jsdom's is absent here and
 * `saveJson` swallows that, so a test that needs a cache to exist -- or a
 * sign-out that clears one -- would otherwise pass for the wrong reason.
 */
function withStorage(fn: () => void): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  setDeviceTrusted(true);
  try {
    fn();
  } finally {
    setDeviceTrusted(false);
    Reflect.deleteProperty(globalThis, "localStorage");
  }
}

beforeEach(() => {
  resetSettingsPolicyForTest();
  syncMock.reset();
  useSession.setState({ status: "loading", session: null, accountId: null });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
});

afterEach(() => {
  resetSettingsPolicyForTest();
  syncMock.reset();
  setDeviceTrusted(false);
  useSession.setState({ status: "loading", session: null, accountId: null });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
});

describe("a sign-out and the sign-in that follows it", () => {
  it("leaves nothing of the previous reader for the next account", () => {
    withStorage(() => {
      signIn("a1");
      useSettings.getState().hydrate({
        knownSigners: {
          "sender@example.com": {
            fingerprint: "ab",
            name: "Sender",
            firstSeen: "2026-01-01",
          },
        },
        trustedImageSenders: ["sender@example.com"],
        internalDomains: ["inside.example"],
        uiLanguage: "de",
        folderColors: { m1: "#123456" },
      });
      expect(settingsInHandFor("a1")).toBe(true);

      /* What `logout` does, in its own order: the stored copy goes, then the
         session flips. The flip is what has to clear the reader's copy in
         React. */
      clearSignedInData();
      signOut();

      const after = useSettings.getState().settings;
      expect(after.knownSigners).toEqual({});
      expect(after.trustedImageSenders).toEqual([]);
      expect(after.internalDomains).toEqual([]);
      expect(after.folderColors).toEqual({});
      expect(after.uiLanguage).toBe(DEFAULT_SETTINGS.uiLanguage);
      expect(settingsInHandFor("a1")).toBe(false);

      /* The second sign-in in the same tab: the tree waits for the new
         account's file rather than painting the previous reader's settings. */
      signIn("a2");
      expect(settingsInHandFor("a2")).toBe(false);
      expect(useSettings.getState().settings.uiLanguage).toBe(
        DEFAULT_SETTINGS.uiLanguage,
      );

      /* And nothing of theirs can reach a2 while its own file is on the way:
         what `update` queues is the defaults the store was left with. */
      useSettings.getState().update({ accent: "teal" });
      expect(syncMock.latest()?.knownSigners).toEqual({});
      expect(syncMock.latest()?.internalDomains).toEqual([]);
      expect(syncMock.latest()?.uiLanguage).toBe(DEFAULT_SETTINGS.uiLanguage);
    });
  });

  it("drops a cache left by an earlier trusted session when this sign-in is not trusted", () => {
    withStorage(() => {
      /* An earlier trusted session on this machine left its settings in the
         cache and this page load read them, which is what the store holds when
         `applySession` decides that a sign-in without `remember` means this is
         not a device we may keep anything on. */
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          uiLanguage: "de",
          internalDomains: ["inside.example"],
        },
      });
      setDeviceTrusted(false);
      clearAllData();
      signIn("a2");

      const after = useSettings.getState().settings;
      expect(after.uiLanguage).toBe(DEFAULT_SETTINGS.uiLanguage);
      expect(after.internalDomains).toEqual([]);
      expect(settingsInHandFor("a2")).toBe(false);
    });
  });
});

describe("reset", () => {
  it("writes the legacy theme a policy's palette and mode imply", () => {
    resetSettingsPolicyForTest({
      defaults: { palette: "gruvbox", mode: "light" },
    });
    useSettings.getState().reset();
    const s = useSettings.getState().settings;
    expect(s.palette).toBe("gruvbox");
    expect(s.mode).toBe("light");
    /* Straight to `saveJson` this stayed "gilbert", and a device on an older
       build then painted gilbert's dark palette over a choice of light
       Gruvbox. */
    expect(s.theme).toBe("light");
  });
});

describe("importing a settings file", () => {
  it("reads a pre-palette export through the migration instead of importing nothing", () => {
    expect(useSettings.getState().importJson(JSON.stringify({ theme: "light" }))).toBe(
      true,
    );
    const s = useSettings.getState().settings;
    /* Without the migration this changed nothing: `update` derives `theme` from
       `palette` and `mode`, so the imported "light" was written back over by
       the palette the file did not carry. */
    expect(s.palette).toBe("default");
    expect(s.mode).toBe("light");
    expect(s.theme).toBe("light");
  });

  it("still trusts the rest of what it is given", () => {
    expect(
      useSettings
        .getState()
        .importJson(JSON.stringify({ accent: "purple", notARealSetting: 7 })),
    ).toBe(true);
    const s = useSettings.getState().settings as unknown as Record<string, unknown>;
    expect(s.accent).toBe("purple");
    // The migration only adds palette and mode; dropping unknown keys is
    // `acceptRemote`'s job, for files read back off the server.
    expect(s.notARealSetting).toBe(7);
  });
});

describe("folder colours", () => {
  it("follow the account, which is what the code has always done", () => {
    /*
     * The interface comment said they were local to this browser, but nothing
     * ever added them to DEVICE_KEYS, so they ride in the account's settings
     * file: `syncedPart` keeps every key that is not a device key, and picking
     * a colour in the folder menu goes through `update`, which pushes. That is
     * the answer worth keeping -- JMAP has nowhere on a Mailbox to keep a
     * colour, the ids are the reader's own mailboxes, and a colour chosen on
     * the desktop belongs on the laptop -- so the comment was corrected to the
     * code rather than the reverse, which would silently unsync everybody's.
     */
    expect(DEVICE_KEYS.has("folderColors")).toBe(false);
    const colors = { m1: "#123456" };
    const settings: Settings = { ...DEFAULT_SETTINGS, folderColors: colors };
    expect(syncedPart(settings).folderColors).toEqual(colors);
  });
});
