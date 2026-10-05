import { describe, expect, it } from "vitest";
import { needsAssets } from "@/lib/signatureImages";

/**
 * ADR 0007: the administration writes somebody else's identity, so it has no
 * Files of theirs to store a signature's assets in. `needsAssets` is what tells
 * that surface apart from the person's own settings — a signature carrying a
 * `data:` picture cannot be written without them, and one that does not carry
 * one can. It is the predicate the editor refuses and saves by, so a plain
 * signature must stay plain.
 */

describe("which signatures need the account's own Files", () => {
  it("a pasted picture does", () => {
    expect(
      needsAssets('<p>Regards<br><img src="data:image/png;base64,iVBORw0KGgo="></p>'),
    ).toBe(true);
  });

  it("a plain signature does not", () => {
    expect(needsAssets("<p>Regards,<br>Team</p>")).toBe(false);
    expect(needsAssets("")).toBe(false);
  });

  it("a stored picture does not: its src is already a Files URL", () => {
    expect(
      needsAssets('<img src="/api/blob/a1/b1/logo.png?accept=image/png&inline=1">'),
    ).toBe(false);
  });
});
