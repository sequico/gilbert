import { describe, expect, it } from "vitest";
import { filterTypeSelectOptions } from "@/ui/TypeSelect";

/**
 * The filter behind every picker on the identity surfaces. A directory can be
 * long and an administrator types part of a name or part of an address, so both
 * the value and the label match — case-insensitively — and an empty query offers
 * everything rather than nothing.
 */

const OPTIONS = [
  { value: "team@example.org", label: "Team" },
  { value: "design@example.org", label: "Design" },
  { value: "ada@example.com" },
];

describe("filtering what a type-select offers", () => {
  it("matches the value and the label, case-insensitively", () => {
    expect(filterTypeSelectOptions(OPTIONS, "design").map((o) => o.value)).toEqual([
      "design@example.org",
    ]);
    expect(filterTypeSelectOptions(OPTIONS, "TEAM").map((o) => o.value)).toEqual([
      "team@example.org",
    ]);
    expect(
      filterTypeSelectOptions(OPTIONS, "EXAMPLE.ORG").map((o) => o.value),
    ).toHaveLength(2);
  });

  it("matches an option that has no label on its value", () => {
    expect(filterTypeSelectOptions(OPTIONS, "ada").map((o) => o.value)).toEqual([
      "ada@example.com",
    ]);
  });

  it("offers everything for an empty query and nothing for a query nothing matches", () => {
    expect(filterTypeSelectOptions(OPTIONS, "  ")).toBe(OPTIONS);
    expect(filterTypeSelectOptions(OPTIONS, "nobody")).toEqual([]);
  });
});
