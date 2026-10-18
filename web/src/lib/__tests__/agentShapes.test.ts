import { RULE_SURFACES, RULE_VERSION } from "@gilbert/agent/rule";
import { INSTRUCTION_VERSION } from "@gilbert/shared/instruction";
import { expect, it } from "vitest";

/**
 * The agent's document shapes, as a surface writes them (ADR 0035).
 *
 * A group's rules and its standing instruction are the group's own documents, so
 * the client writes them with the group's session — and it writes them in the
 * shape the server reads. That shape is one definition, in the agent's tree, and
 * the alias `@gilbert/agent/*` is what lets this tier read it instead of
 * spelling a second one.
 */
it("a surface reads the agent's shapes from the one definition", () => {
  expect(RULE_VERSION).toBe(1);
  expect(INSTRUCTION_VERSION).toBe(1);
  expect(RULE_SURFACES).toContain("mail");
  expect(RULE_SURFACES).toEqual(["chat", "mail", "knowledge", "workorder", "files"]);
});
