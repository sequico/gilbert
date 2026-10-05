import { CAPABILITIES } from "@gilbert/shared/capabilities";
import { describe, expect, it } from "vitest";
import { CAP } from "@/jmap/client";

/**
 * The two tiers read one capability vocabulary, and this is the seam where
 * they can drift apart.
 *
 * `CAP` is the browser's half: what `usingFor` puts in a request's `using`, and
 * what picks the account that owns a surface (`primaryAccounts`,
 * `accountCapabilities`). A capability the shared tier knows and `CAP` does not
 * is one no surface can ever select an account by; a URN in `CAP` that the
 * shared tier does not define is a request Stalwart refuses with
 * `unknownMethod` on a server that is working exactly as documented.
 *
 * What this cannot catch is a `CAP` value that spells a URN out literally
 * instead of referencing the shared constant: at run time the two are the same
 * string. That half is held by the file's shape — every entry is a reference —
 * rather than by an assertion.
 */
describe("the client's capability vocabulary", () => {
  const shared: string[] = Object.values(CAPABILITIES);
  const named: string[] = Object.values(CAP);

  it("names every capability the shared tier defines", () => {
    expect(shared.filter((urn) => !named.includes(urn))).toEqual([]);
  });

  it("names nothing the shared tier does not define", () => {
    expect(named.filter((urn) => !shared.includes(urn))).toEqual([]);
  });

  it("keeps the two lists the same size, so neither test is vacuous", () => {
    // Every entry is one URN: a `CAP` that named two keys for one capability,
    // or a shared entry nothing in the browser can name, shows up as a length
    // difference rather than as a passing pair of empty filters.
    expect(new Set(named).size).toBe(named.length);
    expect(new Set(shared).size).toBe(shared.length);
    expect(named.length).toBe(shared.length);
  });
});
