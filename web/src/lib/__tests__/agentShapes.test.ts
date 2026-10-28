// @vitest-environment node
import { AREA_NAMES } from "@gilbert/shared/areas";
import { INSTRUCTION_VERSION } from "@gilbert/shared/instruction";
import { SURFACES } from "@gilbert/shared/surfaces";
import { expect, it } from "vitest";

/**
 * The agent's document shapes, as a surface writes them (ADR 0038).
 *
 * A group's instruction is the group's own document, so the client writes it
 * with the group's session — and it writes it in the shape the server reads.
 * That shape is one definition, in the shared tree, and the aliases
 * `@gilbert/shared/*` are what let this tier read it instead of spelling a
 * second one. The imports above are the assertion: a second definition would not
 * resolve here at all.
 *
 * The version a document carries is the agent's to move, and a test that pinned
 * it would break on the day the document gains a field rather than on the day
 * the two tiers disagreed; what is pinned is what the editor draws.
 */
it("a surface reads the agent's shapes from the one definition", () => {
  expect(Number.isInteger(INSTRUCTION_VERSION)).toBe(true);
  expect(INSTRUCTION_VERSION).toBeGreaterThanOrEqual(1);
  expect(AREA_NAMES).toEqual([
    "mail",
    "files",
    "calendar",
    "contacts",
    "knowledge",
    "workorders",
    "chat",
    "memory",
  ]);
  expect(SURFACES).toEqual([
    "chat",
    "mail",
    "files",
    "knowledge",
    "workorder",
    "calendar",
  ]);
});
