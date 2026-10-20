import { RULE_SURFACES, RULE_VERSION } from "@gilbert/agent/rule";
import { INSTRUCTION_VERSION } from "@gilbert/shared/instruction";
import { expect, it } from "vitest";

/**
 * The agent's document shapes, as a surface writes them (ADR 0031).
 *
 * A group's rules and its standing instruction are the group's own documents, so
 * the client writes them with the group's session — and it writes them in the
 * shape the server reads. That shape is one definition, in the agent's tree, and
 * the alias `@gilbert/agent/*` is what lets this tier read it instead of
 * spelling a second one. The import above is the assertion: a second definition
 * would not resolve here at all.
 *
 * The version a document carries is the agent's to move, and a test that pinned
 * it would break on the day a rule gains a field rather than on the day the two
 * tiers disagreed; what is pinned is the surfaces the editor draws, which is the
 * client's own contract with the shape.
 */
it("a surface reads the agent's shapes from the one definition", () => {
  expect(Number.isInteger(RULE_VERSION)).toBe(true);
  expect(RULE_VERSION).toBeGreaterThanOrEqual(1);
  expect(Number.isInteger(INSTRUCTION_VERSION)).toBe(true);
  expect(RULE_SURFACES).toEqual([
    "chat",
    "mail",
    "files",
    "knowledge",
    "workorder",
    "calendar",
  ]);
});
