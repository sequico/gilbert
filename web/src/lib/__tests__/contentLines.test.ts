import { describe, expect, it } from "vitest";
import { foldLine, unfoldLines } from "@/lib/contentLines";

const octets = (line: string) => new TextEncoder().encode(line).length;

/** A line short enough to be left exactly as it is. */
const SHORT = "SUMMARY:Standup";

describe("foldLine", () => {
  it("leaves a line that already fits alone, whatever it carries", () => {
    expect(foldLine(SHORT)).toBe(SHORT);
    expect(foldLine("SUMMARY:Grüße aus München")).toBe("SUMMARY:Grüße aus München");
  });

  it("folds to 75 octets per line, continuation included", () => {
    const line = `DESCRIPTION:${"a".repeat(200)}`;
    const folded = foldLine(line).split("\r\n");
    expect(folded.length).toBeGreaterThan(1);
    for (const one of folded) expect(octets(one)).toBeLessThanOrEqual(75);
    // A continuation is marked by one space, and nothing else is added.
    for (const one of folded.slice(1)) expect(one.startsWith(" ")).toBe(true);
    expect(unfoldLines(foldLine(line))).toEqual([line]);
  });

  it("counts octets rather than characters, so non-ASCII folds sooner", () => {
    // 75 CJK characters are 225 octets: a fold counted in characters emits a
    // line three times the wire limit and calls it folded.
    const line = `SUMMARY:${"漢".repeat(75)}`;
    const folded = foldLine(line).split("\r\n");
    expect(folded.length).toBeGreaterThan(1);
    for (const one of folded) expect(octets(one)).toBeLessThanOrEqual(75);
    expect(unfoldLines(foldLine(line))).toEqual([line]);
  });

  it("cuts at a character boundary, never inside one", () => {
    // Accented letters and an emoji, which is a surrogate pair in JS: cutting
    // by UTF-16 index leaves a lone surrogate, and encoding that gives U+FFFD,
    // so the text that came out would not be the text that went in.
    const line = `DESCRIPTION:${"éèê😀".repeat(20)}`;
    const folded = foldLine(line);
    expect(new TextDecoder().decode(new TextEncoder().encode(folded))).toBe(folded);
    expect(unfoldLines(folded)).toEqual([line]);
  });

  it("round-trips whatever the line carries", () => {
    for (const line of [
      SHORT,
      `SUMMARY:${"a".repeat(300)}`,
      `SUMMARY:${"漢字かなカナ".repeat(40)}`,
      `NOTE:${"Grüße aus München, ".repeat(20)}`,
      `DESCRIPTION:${"x".repeat(74)}y`,
      `DESCRIPTION:${"x".repeat(75)}y`,
    ]) {
      expect(unfoldLines(foldLine(line))).toEqual([line]);
    }
  });
});

describe("unfoldLines", () => {
  it("joins a continuation with nothing between, per the RFC", () => {
    expect(unfoldLines("SUMMARY:A very\r\n  long title")).toEqual([
      "SUMMARY:A very long title",
    ]);
    expect(unfoldLines("SUMMARY:A\r\n\tB")).toEqual(["SUMMARY:AB"]);
  });

  it("handles all three line endings", () => {
    expect(unfoldLines("A\r\nB\nC\rD")).toEqual(["A", "B", "C", "D"]);
  });

  it("does not treat a leading space on the first line as a continuation", () => {
    expect(unfoldLines(" oops")).toEqual([" oops"]);
  });

  it("takes a tab as a continuation too, which LDIF exporters do emit", () => {
    // Wider than RFC 2849 (a single space) on purpose: the line is not legal
    // LDIF, and a real exporter means it as continued content — see `ldif.ts`.
    // One character comes off, marker or not, so the tab does not survive in
    // the value — the same rule that takes the single space off a space fold.
    expect(unfoldLines("cn: X\r\n\tphoto: junk\r\n")).toEqual(["cn: Xphoto: junk", ""]);
  });

  it("does not continue onto a blank line, which LDIF separates records with", () => {
    // Joining here would swallow the separator and merge two entries.
    expect(unfoldLines("dn: a\r\n\r\n b\r\n")).toEqual(["dn: a", "", " b", ""]);
  });
});
