import { afterEach, describe, expect, it, vi } from "vitest";
import { withBase } from "@/lib/basePath";
import { setCatalog } from "@/lib/i18n";
import { SW_CACHE_NAME } from "@/lib/swCache";
import { FACTS_KEY, publishWorkerFacts, type WorkerFacts } from "@/lib/swFacts";
import { catalog as de } from "@/locales/de";

/**
 * The briefing is the only thing standing between a notification action and a
 * button labelled in a language the reader does not use — the worker is plain
 * JavaScript outside the bundle and cannot reach a catalogue.
 *
 * It is also the only place the archive mailbox is named, and getting that
 * wrong does not fail visibly: a message would be filed somewhere, just not
 * where Archive means.
 */

function fakeCaches() {
  const store = new Map<string, string>();
  const cache = {
    put: vi.fn(
      async (key: string, res: Response) => void store.set(key, await res.text()),
    ),
    match: vi.fn(async (key: string) =>
      store.has(key) ? new Response(store.get(key)) : undefined,
    ),
    delete: vi.fn(async () => true),
  };
  // Only the worker's own cache: a briefing put anywhere else is one the
  // worker will never read.
  const other = { put: vi.fn(), match: vi.fn(), delete: vi.fn() };
  vi.stubGlobal("caches", {
    open: vi.fn(async (name: string) => (name === SW_CACHE_NAME ? cache : other)),
  });
  return { store, cache };
}

const written = (store: Map<string, string>) =>
  JSON.parse(store.get(withBase(FACTS_KEY))!) as WorkerFacts;

afterEach(() => {
  vi.unstubAllGlobals();
  setCatalog("en", { strings: {}, plurals: {} });
});

describe("the worker's briefing", () => {
  it("names the account, the archive mailbox and the inbox", async () => {
    const { store } = fakeCaches();
    await publishWorkerFacts("a1", "mb-archive", [], "", "mb-inbox");
    const facts = written(store);
    expect(facts.accountId).toBe("a1");
    expect(facts.archiveId).toBe("mb-archive");
    expect(facts.inboxId).toBe("mb-inbox");
  });

  it("carries the chats the worker may be woken for, and the reader's address", async () => {
    // The worker reads a chat's folder and watermark straight from here, and
    // uses the address to avoid announcing the reader's own message.
    const { store } = fakeCaches();
    await publishWorkerFacts(
      "a1",
      "mb-archive",
      [
        {
          accountId: "g1",
          name: "Team",
          folderId: "ch",
          watermark: "2026-01-01T00:00:00Z",
        },
      ],
      "me@example.org",
    );
    const facts = written(store);
    expect(facts.ownAddress).toBe("me@example.org");
    expect(facts.chats).toEqual([
      {
        accountId: "g1",
        name: "Team",
        folderId: "ch",
        watermark: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("carries the worker's text in the language the tab is in", async () => {
    // The worker has no catalogue. Everything it will say has to be said here
    // first, or a German reader gets English buttons on their lock screen.
    setCatalog("de", de);
    const { store } = fakeCaches();
    await publishWorkerFacts("a1", "mb-archive");
    const facts = written(store);
    expect(facts.strings.archive).toBe("Archivieren");
    expect(facts.strings.markRead).toBe("Als gelesen markieren");
    expect(facts.strings.newMail).toBe("Neue E-Mail");
    expect(facts.strings.noSubject).toBe("(kein Betreff)");
    expect(facts.strings.failed).not.toBe("");
  });

  it("says so when there is no archive folder, rather than inventing one", async () => {
    // The worker draws no Archive button on a null. An account without an
    // archive is not a reason to file mail somewhere else.
    const { store } = fakeCaches();
    await publishWorkerFacts("a1", null);
    expect(written(store).archiveId).toBeNull();
  });

  it("writes nothing before there is an account", async () => {
    const { cache } = fakeCaches();
    await publishWorkerFacts(null, null);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("does not throw where the browser has no cache storage", async () => {
    vi.stubGlobal("caches", undefined);
    await expect(publishWorkerFacts("a1", "mb-archive")).resolves.toBeUndefined();
  });

  it("carries every string the worker looks up", async () => {
    // The worker reads these by name and shows `undefined` for a missing one,
    // which is the kind of thing that only appears on somebody's lock screen.
    const { store } = fakeCaches();
    await publishWorkerFacts("a1", "mb-archive");
    const facts = written(store);
    for (const k of [
      "newMail",
      "newMessage",
      "noSubject",
      "archive",
      "markRead",
      "failed",
    ] as const) {
      expect(facts.strings[k], `missing ${k}`).toBeTruthy();
    }
  });
});
