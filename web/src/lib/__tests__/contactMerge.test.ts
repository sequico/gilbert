import { describe, expect, it } from "vitest";
import type { ContactCard } from "@/jmap/types";
import { contactMergeConflicts, mergeContactCards } from "../contactMerge";

/*
 * Merging two contacts: the fields a card holds one of are the reader's choice
 * where the two disagree, and every list — the addresses, the phones, the
 * members — is combined. These are cases over the planner alone, no server and
 * no store, which is what makes the awkward ones cheap to state.
 */

const card = (over: Partial<ContactCard> = {}): ContactCard =>
  ({
    id: "c",
    "@type": "Card",
    version: "1.0",
    uid: "u",
    kind: "individual",
    addressBookIds: { b: true },
    ...over,
  }) as ContactCard;

const email = (address: string) => ({ "@type": "EmailAddress" as const, address });

describe("contactMergeConflicts", () => {
  it("lists a one-slot field the two disagree on, both values side by side", () => {
    const a = card({ name: { "@type": "Name", full: "Ada Lovelace" } });
    const b = card({ name: { "@type": "Name", full: "Ada Byron" } });
    expect(contactMergeConflicts(a, b)).toEqual([
      { id: "name", label: "Name", a: "Ada Lovelace", b: "Ada Byron" },
    ]);
  });

  it("says nothing about a list, however different", () => {
    const a = card({ emails: { x: email("a@example.org") } });
    const b = card({ emails: { y: email("b@example.org") } });
    expect(contactMergeConflicts(a, b)).toEqual([]);
  });

  it("is not a conflict when only one of them holds the value", () => {
    const a = card();
    const b = card({ name: { "@type": "Name", full: "Ada Lovelace" } });
    expect(contactMergeConflicts(a, b)).toEqual([]);
  });

  it("reports the kind, the birthday and the photo as conflicts too", () => {
    const a = card({
      kind: "org",
      anniversaries: {
        d: {
          "@type": "Anniversary",
          kind: "birth",
          date: { year: 1990, month: 1, day: 2 },
        },
      },
      media: {
        p: { "@type": "Media", kind: "photo", uri: "data:image/jpeg;base64,AAAA" },
      },
    });
    const b = card({
      kind: "individual",
      anniversaries: {
        d: {
          "@type": "Anniversary",
          kind: "birth",
          date: { year: 2000, month: 3, day: 4 },
        },
      },
      media: {
        p: { "@type": "Media", kind: "photo", uri: "data:image/jpeg;base64,BBBB" },
      },
    });
    expect(contactMergeConflicts(a, b).map((c) => c.id)).toEqual([
      "kind",
      "birthday",
      "photo",
    ]);
  });
});

describe("mergeContactCards", () => {
  it("combines the lists of both and dedupes by value", () => {
    const a = card({ emails: { x: email("a@example.org") } });
    const b = card({
      emails: { y: email("b@example.org"), z: email("a@example.org") },
      phones: { p: { "@type": "Phone", number: "+39000000" } },
    });
    const merged = mergeContactCards(a, b);
    const addresses = Object.values(merged.emails as Record<string, { address: string }>)
      .map((e) => e.address)
      .sort();
    expect(addresses).toEqual(["a@example.org", "b@example.org"]);
    expect(Object.values((merged.phones ?? {}) as Record<string, unknown>).length).toBe(
      1,
    );
  });

  it("takes a field only one of them holds, wherever it is", () => {
    const a = card({ organizations: { o: { "@type": "Organization", name: "Acme" } } });
    const b = card({ titles: { t: { "@type": "Title", name: "Engineer" } } });
    const merged = mergeContactCards(a, b);
    expect(merged.organizations).toEqual(a.organizations);
    expect(merged.titles).toEqual(b.titles);
  });

  it("takes the side the reader chose for a conflict", () => {
    const a = card({ name: { "@type": "Name", full: "Ada Lovelace" } });
    const b = card({ name: { "@type": "Name", full: "Ada Byron" } });
    expect(mergeContactCards(a, b, { name: "b" }).name).toEqual(b.name);
    expect(mergeContactCards(a, b, { name: "a" }).name).toEqual(a.name);
    // The surviving card's side is what is taken when nothing was chosen.
    expect(mergeContactCards(a, b).name).toEqual(a.name);
  });

  it("keeps the other anniversaries of both when the birthday is chosen", () => {
    const death = {
      "@type": "Anniversary" as const,
      kind: "death",
      date: { year: 2021, month: 5, day: 6 },
    };
    const a = card({
      anniversaries: {
        a: {
          "@type": "Anniversary",
          kind: "birth",
          date: { year: 1990, month: 1, day: 2 },
        },
        d: death,
      },
    });
    const b = card({
      anniversaries: {
        b: {
          "@type": "Anniversary",
          kind: "birth",
          date: { year: 2000, month: 3, day: 4 },
        },
      },
    });
    const merged = mergeContactCards(a, b, { birthday: "b" });
    const entries = Object.values(
      (merged.anniversaries ?? {}) as Record<string, { kind: string; date: unknown }>,
    );
    expect(entries.find((x) => x.kind === "birth")?.date).toEqual({
      year: 2000,
      month: 3,
      day: 4,
    });
    expect(entries).toContainEqual(death);
  });

  it("takes the chosen photo and keeps the other media of both", () => {
    const logo = {
      "@type": "Media" as const,
      kind: "logo" as const,
      uri: "data:image/png;base64,LOGO",
    };
    const a = card({
      media: {
        pa: { "@type": "Media", kind: "photo", uri: "data:image/jpeg;base64,AAAA" },
        l: logo,
      },
    });
    const b = card({
      media: {
        pb: { "@type": "Media", kind: "photo", uri: "data:image/jpeg;base64,BBBB" },
      },
    });
    const merged = mergeContactCards(a, b, { photo: "b" });
    const media = Object.values((merged.media ?? {}) as Record<string, { kind: string }>);
    expect(media.filter((m) => m.kind === "photo")).toEqual([
      { "@type": "Media", kind: "photo", uri: "data:image/jpeg;base64,BBBB" },
    ]);
    expect(media).toContainEqual(logo);
  });

  it("unions members by their uid, so a group keeps both sides' people", () => {
    const a = card({ kind: "group", members: { "u-1": true } });
    const b = card({ kind: "group", members: { "u-2": true } });
    expect(
      Object.keys(
        (mergeContactCards(a, b).members ?? {}) as Record<string, unknown>,
      ).sort(),
    ).toEqual(["u-1", "u-2"]);
  });

  it("writes an empty field as null, so the merged card is what was planned", () => {
    const merged = mergeContactCards(card(), card());
    expect(merged.notes).toBeNull();
    expect(merged.nicknames).toBeNull();
    expect(merged.anniversaries).toBeNull();
    expect(merged.media).toBeNull();
  });
});
