import { describe, expect, it } from "vitest";
import type { ContactCard, JSContactMedia } from "@/jmap/types";
import { contactFromAddress, contactPhoto, nameParts, withPhoto } from "../contacts";

const parts = (name: string | null, email = "a@b.io") =>
  nameParts(contactFromAddress({ name, email }) as ContactCard);

describe("contactFromAddress", () => {
  it("keeps the address as the preferred email", () => {
    const card = contactFromAddress({ name: "Ada Lovelace", email: "ada@example.org" });
    const emails = Object.values(card.emails ?? {});
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ address: "ada@example.org", pref: 1 });
    expect(card.kind).toBe("individual");
  });

  it("splits a display name into components", () => {
    expect(parts("Ada Lovelace")).toMatchObject({ given: "Ada", surname: "Lovelace" });
    expect(parts("Ada King Lovelace")).toMatchObject({
      given: "Ada",
      middle: "King",
      surname: "Lovelace",
    });
    expect(parts("Prince")).toMatchObject({ given: "Prince", surname: "" });
  });

  it("unpicks the surname-first form", () => {
    expect(parts("Lovelace, Ada")).toMatchObject({ given: "Ada", surname: "Lovelace" });
  });

  it("strips surrounding quotes", () => {
    expect(parts('"Ada Lovelace"')).toMatchObject({ given: "Ada", surname: "Lovelace" });
  });

  it("leaves the name empty when the header carries an address, not a name", () => {
    expect(
      contactFromAddress({ name: "ada@example.org", email: "ada@example.org" }).name,
    ).toBeUndefined();
    expect(
      contactFromAddress({ name: null, email: "ada@example.org" }).name,
    ).toBeUndefined();
    expect(
      contactFromAddress({ name: "   ", email: "ada@example.org" }).name,
    ).toBeUndefined();
  });
});

/*
 * A photo has to arrive as a `data:` URI.
 *
 * Stalwart refuses a `blobId` in a card's `media` -- "blobIds in media is not
 * supported", which fails the whole `ContactCard/set` -- so a photo saved the
 * RFC 9610 way never persisted on a real server, while the mock took it and
 * every test passed. `withPhoto` is the one place that decides the shape, and
 * `contactPhoto` is the one place that reads it back.
 */
describe("withPhoto", () => {
  const photo = { dataUrl: "data:image/jpeg;base64,AAAA", type: "image/jpeg" };

  it("puts the photo in as a data URI, never a blob id", () => {
    const media = withPhoto(undefined, photo)!;
    const [m] = Object.values(media);
    expect(m).toEqual({
      "@type": "Media",
      kind: "photo",
      uri: photo.dataUrl,
      mediaType: "image/jpeg",
    });
    expect(m).not.toHaveProperty("blobId");
  });

  it("replaces an existing photo and leaves other media alone", () => {
    const media = withPhoto(
      {
        old: { kind: "photo", blobId: "b1" },
        l: { kind: "logo", uri: "data:image/png;base64,BB" },
      },
      photo,
    )!;
    expect(Object.values(media).filter((m) => m.kind === "photo")).toHaveLength(1);
    expect(media.old).toBeUndefined();
    expect(media.l).toEqual({ kind: "logo", uri: "data:image/png;base64,BB" });
  });

  it("removes only the photo, and answers null when nothing is left", () => {
    const kept = withPhoto(
      { p: { kind: "photo", uri: photo.dataUrl }, l: { kind: "logo", uri: "data:x,y" } },
      null,
    )!;
    expect(Object.values(kept).map((m) => m.kind)).toEqual(["logo"]);
    expect(withPhoto({ p: { kind: "photo", uri: photo.dataUrl } }, null)).toBeNull();
    expect(withPhoto(undefined, null)).toBeNull();
  });

  it("reads back through contactPhoto, which is what the avatar asks", () => {
    const media = withPhoto(undefined, photo) as Record<string, JSContactMedia>;
    const card = { media } as ContactCard;
    expect(contactPhoto(card, "a1")).toBe(photo.dataUrl);
  });

  /*
   * The old shape is still read rather than discarded: a card written before
   * this change, or by another client, carries a `blobId`, and the photo is
   * fetched through the proxy rather than dropped.
   */
  it("still reads a blob-backed photo a card already carries", () => {
    const card = {
      media: { p: { kind: "photo", blobId: "b9" } },
    } as unknown as ContactCard;
    expect(contactPhoto(card, "a1")).toContain("b9");
  });
});
