import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { ContactCard } from "@/jmap/types";
import { keepRecent, RANGES_KEPT, useCalendar } from "@/store/calendar";
import { useContacts } from "@/store/contacts";

/**
 * What a change costs, once the caches are bounded.
 *
 * A pushed card change, and every edit made here, reloaded the whole address
 * book — up to fifty pages of five hundred cards with all their properties — to
 * pick up one card. `ContactCard/changes` names what happened since the state
 * the cards were read at, and only those cards are fetched.
 *
 * A calendar window used to stay loaded for ever: every week or month the
 * reader had visited was queried again whenever any event changed, and walked
 * by every render. The four most recently shown are kept; a window dropped is
 * loaded again when the reader goes back to it.
 *
 * The fallback is the other half of both: a server that cannot say what changed
 * gets the full load, which is what happened before.
 */

const A = "a1";

describe("what changed, rather than everything again", () => {
  beforeEach(() => {
    useContacts.setState({
      accountId: A,
      cards: { c1: { id: "c1", uid: "u1" } as unknown as ContactCard },
      cardState: "s1",
      loaded: true,
      loading: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useContacts.setState({ accountId: null, cards: {}, cardState: null, loaded: false });
  });

  it("fetches only the cards the server named, and holds the state it read at", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    vi.spyOn(client, "call").mockImplementation((async (
      method: string,
      args: Record<string, unknown>,
    ) => {
      calls.push([method, args]);
      if (method === "ContactCard/changes")
        return {
          created: ["c2"],
          updated: ["c1"],
          destroyed: [],
          newState: "s2",
          hasMoreChanges: false,
        };
      if (method === "ContactCard/get")
        return { list: [{ id: "c2", uid: "u2" }], state: "s2", notFound: [] };
      return { list: [], state: "s", notFound: [] };
    }) as never);

    await useContacts.getState().syncCards();

    expect(calls.map(([m]) => m)).toEqual(["ContactCard/changes", "ContactCard/get"]);
    // Asked from the state the cards were read at, not from scratch.
    expect(calls[0]![1].sinceState).toBe("s1");
    // Only the ids the server named -- the one created and the one updated --
    // and not the rest of the address book.
    expect([...(calls[1]![1].ids as string[])].sort()).toEqual(["c1", "c2"]);
    const s = useContacts.getState();
    expect(Object.keys(s.cards).sort()).toEqual(["c1", "c2"]);
    expect(s.cardState).toBe("s2");
  });

  it("removes a card the server says is gone", async () => {
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "ContactCard/changes")
        return {
          created: [],
          updated: [],
          destroyed: ["c1"],
          newState: "s2",
          hasMoreChanges: false,
        };
      return { list: [], state: "s", notFound: [] };
    }) as never);
    await useContacts.getState().syncCards();
    expect(useContacts.getState().cards.c1).toBeUndefined();
  });

  /*
   * A server that cannot compute changes is a normal answer rather than a
   * fault: the fallback is what this did before.
   */
  it("falls back to the full load when the server cannot say", async () => {
    const { JmapMethodError } = await import("@/jmap/client");
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "ContactCard/changes")
        throw new JmapMethodError("ContactCard/changes", {
          type: "cannotCalculateChanges",
        });
      return { list: [], state: "s", notFound: [] };
    }) as never);
    const loadAll = vi
      .spyOn(useContacts.getState(), "loadAll")
      .mockImplementation(async () => {});
    await useContacts.getState().syncCards();
    expect(loadAll).toHaveBeenCalled();
    expect(useContacts.getState().cardState).toBeNull();
  });
});

describe("the calendar holds a few windows", () => {
  it("keeps the most recent, and moves one shown again to the end", () => {
    let ranges: Record<string, string[]> = {};
    for (let i = 0; i < RANGES_KEPT + 2; i++)
      ranges = keepRecent(ranges, `k${i}`, [`e${i}`]);
    expect(Object.keys(ranges)).toEqual(["k2", "k3", "k4", "k5"]);
    // Going back to an old one keeps it and makes it the most recent.
    ranges = keepRecent(ranges, "k2", ["e2"]);
    expect(Object.keys(ranges)).toEqual(["k3", "k4", "k5", "k2"]);
  });

  it("replaces the ids of a window it already holds", () => {
    const ranges = keepRecent({ k1: ["old"] }, "k1", ["new"]);
    expect(ranges.k1).toEqual(["new"]);
    expect(Object.keys(ranges)).toEqual(["k1"]);
  });

  /*
   * The windows are `instancesIn`'s input, so an unbounded cache is work on
   * every render as well as memory.
   */
  it("bounds what the store keeps when a window is loaded", async () => {
    useCalendar.setState({ accountId: A, events: {}, ranges: {}, sharedRanges: {} });
    vi.spyOn(client, "chain").mockImplementation(
      (async () =>
        new Map([
          ["q", [{ ids: ["e1"], state: "s", canCalculateChanges: false }]],
          ["g", [{ list: [], state: "s", notFound: [] }]],
        ])) as never,
    );
    vi.spyOn(client, "call").mockImplementation((async () => ({
      list: [],
      state: "s",
      notFound: [],
    })) as never);

    for (let i = 0; i < RANGES_KEPT + 2; i++) {
      await useCalendar
        .getState()
        .loadRange(
          new Date(1_700_000_000_000 + i * 86_400_000),
          new Date(1_700_086_400_000 + i * 86_400_000),
        );
    }
    expect(Object.keys(useCalendar.getState().ranges).length).toBe(RANGES_KEPT);
  });
});
