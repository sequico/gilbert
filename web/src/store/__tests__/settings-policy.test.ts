import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isEnforced,
  loadSettingsPolicy,
  policyDefaults,
  policyEnforced,
  refreshSettingsPolicy,
  resetSettingsPolicyForTest,
} from "@/lib/settingsPolicy";
import {
  DEFAULT_SETTINGS,
  SETTINGS_POLICY_UNKNOWN,
  type SettingsWriteRefusal,
  useSettings,
} from "@/store/settings";

/*
 * Settings an installation decides, from #207.
 *
 * A school turning on "warn about outside senders" for three thousand pupils
 * cannot ask three thousand pupils. Two powers, and the difference between them
 * is the whole point: defaults are a starting point the reader may change,
 * enforced settings are not.
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
   * The settings store reaches the session store (it drops what it holds when
   * a session ends), and the session store imports these two for `logout` and
   * the 401 handler. A mock stands in for the whole module, so everything on
   * the way in has to be here.
   */
  flushSettingsPush: vi.fn(),
  stopSettingsSync: vi.fn(),
}));

beforeEach(() => {
  resetSettingsPolicyForTest();
  syncMock.reset();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
});

afterEach(() => {
  resetSettingsPolicyForTest();
  syncMock.reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("what the installation has decided", () => {
  it("keeps to the settings this build actually has", () => {
    /*
     * A policy written against a newer Gilbert, or with a typo in it, must not
     * introduce a key nothing reads: it would be carried around and pushed to
     * the reader's settings file for ever. Same rule an imported settings file
     * already gets.
     */
    resetSettingsPolicyForTest({
      defaults: { conversationMode: false, notARealSetting: true } as never,
      enforced: { alsoNotReal: 1 } as never,
    });
    expect(policyDefaults()).toEqual({ conversationMode: false });
    expect(policyEnforced()).toEqual({});
  });

  it("says which settings belong to the administrator", () => {
    // The setting the issue was actually about: the outside-sender banner.
    resetSettingsPolicyForTest({
      defaults: {},
      enforced: { externalSenderBanner: true } as never,
    });
    expect(isEnforced("externalSenderBanner")).toBe(true);
    expect(isEnforced("conversationMode")).toBe(false);
  });
});

describe("defaults, for an account that has none of its own", () => {
  it("seeds them", () => {
    resetSettingsPolicyForTest({
      defaults: { conversationMode: false } as never,
      enforced: {},
    });
    useSettings.getState().seedFromPolicy();
    expect(useSettings.getState().settings.conversationMode).toBe(false);
  });

  it("leaves everything it does not name alone", () => {
    resetSettingsPolicyForTest({
      defaults: { conversationMode: false } as never,
      enforced: {},
    });
    useSettings.getState().seedFromPolicy();
    expect(useSettings.getState().settings.showAvatars).toBe(
      DEFAULT_SETTINGS.showAvatars,
    );
  });

  it("can still be changed afterwards, being a starting point and not a rule", () => {
    resetSettingsPolicyForTest({
      defaults: { conversationMode: false } as never,
      enforced: {},
    });
    useSettings.getState().seedFromPolicy();
    useSettings.getState().update({ conversationMode: true });
    expect(useSettings.getState().settings.conversationMode).toBe(true);
  });

  it("does nothing at all when the installation has set none", () => {
    const before = useSettings.getState().settings;
    useSettings.getState().seedFromPolicy();
    expect(useSettings.getState().settings).toBe(before);
  });

  it("still applies an enforced setting with no defaults at all", () => {
    // Business logic review finding: `seedFromPolicy` used to return before
    // ever merging `policyEnforced()` when `defaults` was empty — a
    // completely ordinary configuration ("force imagePolicy: ask" needs no
    // default). Every first-run account, and every account on a deployment
    // with no Files capability (which always takes this path, never
    // `hydrate`), was left with the admin-mandated setting never actually
    // applied for the session, even though the settings-page control
    // correctly showed it as locked.
    resetSettingsPolicyForTest({
      defaults: {},
      enforced: { imagePolicy: "ask" } as never,
    });
    useSettings.getState().seedFromPolicy();
    expect(useSettings.getState().settings.imagePolicy).toBe("ask");
  });
});

describe("enforced settings, which the reader may not change", () => {
  beforeEach(() => {
    resetSettingsPolicyForTest({
      defaults: {},
      enforced: { conversationMode: true } as never,
    });
  });

  it("survives an update that tries to change it", () => {
    useSettings.getState().update({ conversationMode: false });
    expect(useSettings.getState().settings.conversationMode).toBe(true);
  });

  it("does not stop the rest of that same update", () => {
    // The one key is refused; the others are the reader's business.
    useSettings.getState().update({ conversationMode: false, showAvatars: false });
    expect(useSettings.getState().settings.conversationMode).toBe(true);
    expect(useSettings.getState().settings.showAvatars).toBe(false);
  });

  it("survives a settings file arriving from another device", () => {
    // An older sign-in wrote past the policy before it existed. Hydrating must
    // not put that back.
    useSettings.getState().hydrate({ conversationMode: false, showAvatars: false });
    expect(useSettings.getState().settings.conversationMode).toBe(true);
    expect(useSettings.getState().settings.showAvatars).toBe(false);
  });

  it("survives a reset", () => {
    // Resetting must not be the way around a policy.
    useSettings.getState().reset();
    expect(useSettings.getState().settings.conversationMode).toBe(true);
  });

  it("survives an imported settings file", () => {
    useSettings.getState().importJson(JSON.stringify({ conversationMode: false }));
    expect(useSettings.getState().settings.conversationMode).toBe(true);
  });
});

/** A fetch that answers with this body, which is all these tests vary. */
const answering = (body: string) => async () => new Response(body);

/** A fetch that refuses: one status, and no body at all. */
const refusing = (status: number) => async () => new Response("", { status });

/** The endpoint's answer, from the policy document it would carry. */
const answered = (policy: unknown) => JSON.stringify({ policy });

/*
 * A policy that did not arrive is not a policy that sets nothing.
 *
 * The endpoint is the signed-in account's own copy of the published document
 * (ADR 0015), so a session that has just signed in can meet a 401 on it and a
 * server having a bad minute a 5xx. Read as an empty policy, that leaves a page
 * load with no enforced map at all: an administrator's setting neither applied
 * nor locked, silently, and nothing on screen saying the policy was never read.
 */
describe("a policy that did not arrive", () => {
  it("is unavailable rather than an empty policy", async () => {
    vi.stubGlobal("fetch", refusing(401));
    await expect(loadSettingsPolicy()).resolves.toEqual({ status: "unavailable" });
  });

  it("is unavailable when the server answers with an error", async () => {
    vi.stubGlobal("fetch", refusing(503));
    await expect(loadSettingsPolicy()).resolves.toEqual({ status: "unavailable" });
  });

  it("is unavailable when the body is not the document", async () => {
    // A proxy's error page arrives with a 200 and is not a policy.
    vi.stubGlobal("fetch", answering("<html>maintenance</html>"));
    await expect(loadSettingsPolicy()).resolves.toEqual({ status: "unavailable" });
  });

  it("is unavailable when the body is JSON and still not the document", async () => {
    // Valid JSON, no policy in it: the answer is not an installation that sets
    // nothing, it is an answer from something that does not know this endpoint.
    vi.stubGlobal("fetch", answering("null"));
    await expect(loadSettingsPolicy()).resolves.toEqual({ status: "unavailable" });
  });

  it("is unavailable when a section is not the shape it must be", async () => {
    const body = answered({ changes: "soon" });
    vi.stubGlobal("fetch", answering(body));
    await expect(loadSettingsPolicy()).resolves.toEqual({ status: "unavailable" });
  });

  it("is unavailable when the request itself fails", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadSettingsPolicy()).resolves.toEqual({ status: "unavailable" });
  });

  it("is asked for again rather than remembered", async () => {
    const body = answered({ enforced: { readingPane: "off" } });
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    fetchMock.mockResolvedValueOnce(new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadSettingsPolicy()).resolves.toEqual({ status: "unavailable" });
    // A failure kept as the answer answers without asking, and the policy stays
    // unknown for the rest of the page.
    await expect(loadSettingsPolicy()).resolves.toMatchObject({ status: "read" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(policyEnforced()).toEqual({ readingPane: "off" });
  });
});

/*
 * The code the door refuses with is one string, and a sentence somewhere else
 * is looked up by it: a rename that touched only this repository's constant
 * would orphan that sentence, so the value is pinned here beside the type that
 * says it is a refusal this store can answer with.
 */
describe("the refusal code", () => {
  it("is the one a catalogue elsewhere is keyed by", () => {
    const code: SettingsWriteRefusal = "policy_unknown";
    expect(SETTINGS_POLICY_UNKNOWN).toBe(code);
  });
});

/*
 * The door, which is where a policy holds whatever route a setting is changed
 * by. With no policy in hand there is nothing to measure a patch against, so
 * the patch is refused whole and the caller is told which code to report.
 */
describe("the door, with no policy in hand", () => {
  /** Nothing could be read, so every write is measured against nothing. */
  const unreadable = async () => {
    vi.stubGlobal("fetch", refusing(500));
    await loadSettingsPolicy();
  };

  it("refuses the write and says which code", async () => {
    await unreadable();
    const before = useSettings.getState().settings.conversationMode;
    expect(useSettings.getState().update({ conversationMode: !before })).toBe(
      SETTINGS_POLICY_UNKNOWN,
    );
    expect(useSettings.getState().settings.conversationMode).toBe(before);
  });

  it("refuses the whole patch, not only what a policy might name", async () => {
    await unreadable();
    useSettings.getState().update({ showAvatars: false, density: "compact" });
    const settings = useSettings.getState().settings;
    expect(settings.showAvatars).toBe(DEFAULT_SETTINGS.showAvatars);
    expect(settings.density).toBe(DEFAULT_SETTINGS.density);
  });

  it("queues nothing for the account", async () => {
    await unreadable();
    useSettings.getState().update({ conversationMode: false });
    expect(syncMock.latest()).toBeNull();
  });

  it("opens again once a later read brings the policy", async () => {
    await unreadable();
    // The door is shut while the policy is unknown ...
    expect(useSettings.getState().update({ conversationMode: false })).toBe(
      SETTINGS_POLICY_UNKNOWN,
    );
    const body = answered({ enforced: { readingPane: "off" } });
    vi.stubGlobal("fetch", answering(body));
    await refreshSettingsPolicy();
    // ... and open again once one arrives, which is what makes it a refusal
    // rather than a wall.
    expect(useSettings.getState().update({ readingPane: "right" })).toBeNull();
    // The policy that arrived is in force, so the patch is measured against it.
    expect(useSettings.getState().settings.readingPane).toBe("off");
  });

  it("does not report a change as applied when the write was refused", async () => {
    // A read that answered, then a re-read that did not: the changes in hand
    // are still whatever the last answer brought, and none of them is applied
    // while the policy is unknown -- the toast names what moved.
    const body = answered({
      changes: [{ version: "A", settings: { showPreview: false } }],
    });
    vi.stubGlobal("fetch", answering(body));
    await loadSettingsPolicy();
    vi.stubGlobal("fetch", refusing(500));
    await refreshSettingsPolicy();
    expect(useSettings.getState().applyPolicyChanges()).toEqual([]);
    const settings = useSettings.getState().settings;
    expect(settings.appliedPolicyChanges).toEqual([]);
    expect(settings.showPreview).toBe(DEFAULT_SETTINGS.showPreview);
  });
});

/*
 * The ordinary case, and the one that must keep working: an installation that
 * answered with a policy of nothing is an answer, so the account starts on
 * Gilbert's own defaults and the reader may move them.
 */
describe("an installation that sets nothing", () => {
  it("is an answer, and an account on it keeps the product defaults", async () => {
    // What the endpoint answers for an account with no published policy: the
    // document, with nothing in any of its three sections.
    const body = answered({ defaults: {}, enforced: {}, changes: [] });
    vi.stubGlobal("fetch", answering(body));
    await expect(loadSettingsPolicy()).resolves.toEqual({
      status: "read",
      policy: { defaults: {}, enforced: {}, changes: [] },
    });
    useSettings.getState().seedFromPolicy();
    expect(useSettings.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(useSettings.getState().update({ conversationMode: false })).toBeNull();
    expect(useSettings.getState().settings.conversationMode).toBe(false);
  });
});

/*
 * The enforcement door opens only when the policy has been fetched, and the
 * fetch is in flight while the first frames of an authed session are on
 * screen. A change made in that window passes `update` with nothing to
 * enforce, and sits in the push queue as-is: the first flush -- which only
 * happens after the load has settled -- used to write the pre-policy value
 * to the account's settings file.
 */
describe("refreshSettingsPolicy", () => {
  it("re-fetches instead of serving the page-lifetime cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              policy: { enforced: { readingPane: "off" } },
            }),
            { status: 200 },
          ),
      ),
    );
    await loadSettingsPolicy();
    expect(policyEnforced()).toEqual({ readingPane: "off" });
    // The policy changed while the page was open (an admin published); the
    // next load must see it, not the cached one.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              policy: { enforced: { readingPane: "right" } },
            }),
            { status: 200 },
          ),
      ),
    );
    await refreshSettingsPolicy();
    expect(policyEnforced()).toEqual({ readingPane: "right" });
  });
});

describe("a change made before the policy fetch landed", () => {
  it("is corrected and re-queued once the policy arrives", async () => {
    // No policy known yet: the door is open.
    resetSettingsPolicyForTest();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
    useSettings.getState().update({ conversationMode: false });
    expect(useSettings.getState().settings.conversationMode).toBe(false);
    expect(syncMock.pendingKeys().has("conversationMode")).toBe(true);
    // The fetch lands with that setting enforced.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              policy: { enforced: { conversationMode: true } },
            }),
            { status: 200 },
          ),
      ),
    );
    try {
      await loadSettingsPolicy();
    } finally {
      vi.unstubAllGlobals();
    }
    // The queued snapshot was replaced with the corrected one, so the flush
    // cannot land a value the policy forbids.
    expect(useSettings.getState().settings.conversationMode).toBe(true);
    expect(syncMock.latest()?.conversationMode).toBe(true);
    expect(syncMock.pendingKeys().has("conversationMode")).toBe(true);
  });

  it("leaves the queue alone when nothing was queued pre-policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              policy: { enforced: { conversationMode: true } },
            }),
            { status: 200 },
          ),
      ),
    );
    try {
      await loadSettingsPolicy();
    } finally {
      vi.unstubAllGlobals();
    }
    // No phantom write: an untouched account is not pushed to because the
    // policy merely arrived.
    expect(syncMock.latest()).toBeNull();
    expect(isEnforced("conversationMode")).toBe(true);
  });
});

describe("reset, where the installation has chosen defaults", () => {
  it("goes back to the installation's answer rather than to gilbert's", () => {
    resetSettingsPolicyForTest({
      defaults: { conversationMode: false } as never,
      enforced: {},
    });
    useSettings.getState().update({ conversationMode: true });
    useSettings.getState().reset();
    expect(useSettings.getState().settings.conversationMode).toBe(false);
  });
});

/*
 * The third power: applied once each, to everybody, and changeable afterwards.
 *
 * The difference from `enforced` is entirely in the remembering. Both reach an
 * account that already exists; only this one lets the reader have the last
 * word, and only because the version is stored.
 */
describe("changes an installation wants applied once", () => {
  const change = (version: string, settings: Record<string, unknown>) =>
    ({ version, settings }) as never;

  it("applies one the account has not had", () => {
    resetSettingsPolicyForTest({
      changes: [change("20260902", { conversationMode: false })],
    });
    const applied = useSettings.getState().applyPolicyChanges();
    expect(applied.map((c) => c.version)).toEqual(["20260902"]);
    expect(useSettings.getState().settings.conversationMode).toBe(false);
  });

  it("remembers it, so the next sign-in does not do it again", () => {
    resetSettingsPolicyForTest({
      changes: [change("20260902", { conversationMode: false })],
    });
    useSettings.getState().applyPolicyChanges();
    // The reader decides otherwise, which is the whole difference from enforcing.
    useSettings.getState().update({ conversationMode: true });
    expect(useSettings.getState().applyPolicyChanges()).toEqual([]);
    expect(useSettings.getState().settings.conversationMode).toBe(true);
  });

  it("reaches an account that had already chosen otherwise", () => {
    /*
     * Confirmed as intended on #207: the point is to reach everybody who is
     * already here, so somebody who turned it off last week does get it turned
     * back on -- once.
     */
    useSettings.getState().update({ conversationMode: false });
    resetSettingsPolicyForTest({
      changes: [change("20260902", { conversationMode: true })],
    });
    useSettings.getState().applyPolicyChanges();
    expect(useSettings.getState().settings.conversationMode).toBe(true);
  });

  it("applies only the ones that are new, keeping what it has seen", () => {
    resetSettingsPolicyForTest({ changes: [change("A", { conversationMode: false })] });
    useSettings.getState().applyPolicyChanges();
    resetSettingsPolicyForTest({
      changes: [
        change("A", { conversationMode: false }),
        change("B", { showAvatars: false }),
      ],
    });
    const applied = useSettings.getState().applyPolicyChanges();
    expect(applied.map((c) => c.version)).toEqual(["B"]);
    expect(useSettings.getState().settings.appliedPolicyChanges).toEqual(["A", "B"]);
  });

  it("does not skip a change dated earlier than one already applied", () => {
    // Ids, not a high-water mark. An admin backfilling a change must not find
    // it silently ignored because a later one went first.
    resetSettingsPolicyForTest({
      changes: [change("20260902", { conversationMode: false })],
    });
    useSettings.getState().applyPolicyChanges();
    resetSettingsPolicyForTest({
      changes: [
        change("20260101", { showAvatars: false }),
        change("20260902", { conversationMode: false }),
      ],
    });
    expect(
      useSettings
        .getState()
        .applyPolicyChanges()
        .map((c) => c.version),
    ).toEqual(["20260101"]);
    expect(useSettings.getState().settings.showAvatars).toBe(false);
  });

  it("goes out as one write however many changes are pending", () => {
    resetSettingsPolicyForTest({
      changes: [
        change("A", { conversationMode: false }),
        change("B", { showAvatars: false }),
      ],
    });
    const applied = useSettings.getState().applyPolicyChanges();
    expect(applied).toHaveLength(2);
    expect(useSettings.getState().settings.conversationMode).toBe(false);
    expect(useSettings.getState().settings.showAvatars).toBe(false);
  });

  it("does nothing, and says so, when there are none", () => {
    expect(useSettings.getState().applyPolicyChanges()).toEqual([]);
  });

  it("cannot undo an enforced setting, which outranks it", () => {
    resetSettingsPolicyForTest({
      enforced: { conversationMode: true } as never,
      changes: [change("A", { conversationMode: false })],
    });
    useSettings.getState().applyPolicyChanges();
    expect(useSettings.getState().settings.conversationMode).toBe(true);
  });

  it("drops a change whose settings this build does not have, rather than recording it", () => {
    // Recording it as applied would mean it never runs on the Gilbert that
    // does have the setting.
    resetSettingsPolicyForTest({ changes: [change("A", { notARealSetting: true })] });
    expect(useSettings.getState().applyPolicyChanges()).toEqual([]);
    expect(useSettings.getState().settings.appliedPolicyChanges).toEqual([]);
  });
});
