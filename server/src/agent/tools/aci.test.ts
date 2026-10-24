/**
 * The interface rules the eight jobs keep, checked (ADR 0038).
 *
 * A live installation measured what a badly shaped interface costs — 260 refused
 * steps across 94 of 171 runs, invented names, a mailbox id where a message id
 * belongs — and the eight jobs answered it. What keeps a ninth job from becoming
 * the forty-fifth is not the habit of whoever writes it but these five rules,
 * stated in `jobs.ts`'s header and held here: a name the provider accepts, one
 * verb for one meaning, one discriminator with a schema branch per value, a
 * refusal that names what it accepts, and an answer that distils.
 *
 * Each test fails when its rule is broken, which is the point: a test that only
 * shows the catalogue loads proves nothing about the interface.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TOOLS } from "../tools.js";
import { textArg } from "./args.js";
import { ToolError } from "./define.js";

/** The discriminator a job call is chosen by, when it has one. */
function discriminatorOf(tool: (typeof TOOLS)[number]): string | null {
  return tool.args.kind ? "kind" : tool.args.action ? "action" : null;
}

/** The values a job's discriminator accepts, as the turn is told them. */
function valuesOf(tool: (typeof TOOLS)[number], discriminator: string): string[] {
  const spec = tool.args[discriminator];
  assert.equal(spec?.type, "one of", `${tool.name}: "${discriminator}" is not a choice`);
  return [...(spec?.values ?? [])];
}

test("every job's name is one lowercase word, and no dot", () => {
  for (const tool of TOOLS)
    assert.match(
      tool.name,
      /^[a-z][a-z0-9-]*$/,
      `"${tool.name}" is not a name a provider accepts: ` +
        "one lowercase word, no dot (a refused name costs a whole turn)",
    );
});

test("every value of a job's discriminator is named where the turn reads it", () => {
  /*
   * The description and the discriminator's `about` are both handed to the turn
   * (the description above the schema, the `about` inside it): a value neither of
   * them names is a capability the model must guess, which is how `mail.search`
   * was invented beside a `find` that does it.
   */
  for (const tool of TOOLS) {
    const discriminator = discriminatorOf(tool);
    if (!discriminator) continue;
    const told = `${tool.description} ${tool.args[discriminator]?.about ?? ""}`;
    for (const value of valuesOf(tool, discriminator))
      assert.ok(
        told.includes(value),
        `${tool.name}: "${value}" is a value neither the description nor the ` +
          `discriminator's "about" names`,
      );
  }
});

test("every value carries its own schema branch, and no other value's arguments", () => {
  /*
   * One object carrying every route's keys said that a mail search takes a
   * `path` — the refusal the live eval paid for. A branch per value is what lets
   * a provider refuse a wrong argument before the step is paid for.
   */
  for (const tool of TOOLS) {
    const discriminator = discriminatorOf(tool);
    if (!discriminator) continue;
    const values = valuesOf(tool, discriminator);
    const parameters = tool.parameters?.() as
      | { oneOf?: Array<Record<string, unknown>> }
      | undefined;
    const branches = parameters?.oneOf ?? [];
    assert.equal(
      branches.length,
      values.length,
      `${tool.name}: ${values.length} values, ${branches.length} schema branches`,
    );
    const branchValues: string[] = [];
    for (const branch of branches) {
      const properties = (branch.properties ?? {}) as Record<string, { enum?: string[] }>;
      const chosen: string | undefined = properties[discriminator]?.enum?.[0];
      assert.equal(
        typeof chosen,
        "string",
        `${tool.name}: a branch names no ${discriminator}`,
      );
      branchValues.push(String(chosen));
      assert.deepEqual(
        branch.required,
        [discriminator],
        `${tool.name}: a branch does not require its ${discriminator}`,
      );
      assert.equal(
        branch.additionalProperties,
        false,
        `${tool.name}: a branch accepts arguments of another value`,
      );
    }
    assert.deepEqual(
      branchValues.sort(),
      [...values].sort(),
      `${tool.name}: the branches and the values are not the same set`,
    );
  }
});

test("a narrowed job keeps its name and offers nothing outside the areas", () => {
  /*
   * Narrowing is the catalogue's selection (ADR 0038), not a second catalogue:
   * a renamed or re-valued job would be a second spelling of the same verb, and
   * the model would have to learn both.
   */
  for (const tool of TOOLS) {
    if (!tool.narrow) continue;
    const kept = tool.narrow(["mail"]);
    if (!kept) continue;
    assert.equal(kept.name, tool.name, `"${tool.name}" was renamed by narrowing`);
    const discriminator = discriminatorOf(tool);
    if (!discriminator) continue;
    const before = valuesOf(tool, discriminator);
    const after = valuesOf(kept, discriminator);
    for (const value of after)
      assert.ok(before.includes(value), `${kept.name}: narrowing invented "${value}"`);
    assert.ok(after.length > 0, `${kept.name}: narrowing kept a job with no value`);
  }
});

test("a refusal names what it accepts", () => {
  /*
   * "bad arguments" is a step paid for nothing. The refusal is the only thing
   * the model reads before its next call, so it carries the list.
   */
  const find = TOOLS.find((tool) => tool.name === "find");
  assert.ok(find, "the catalogue holds `find`");
  const values = valuesOf(find, "kind");
  assert.throws(
    () => find.parse({ kind: "mail-box", query: "from:x" }),
    (error: unknown) => {
      assert.ok(error instanceof ToolError);
      for (const value of values)
        assert.ok(
          error.message.includes(value),
          `the refusal does not name "${value}": ${error.message}`,
        );
      return true;
    },
  );
  assert.throws(
    () => find.parse({ query: "from:x" }),
    (error: unknown) => {
      assert.ok(error instanceof ToolError);
      for (const value of values)
        assert.ok(
          error.message.includes(value),
          "a missing discriminator names no value",
        );
      return true;
    },
  );
  assert.throws(
    () => textArg({}, "id"),
    (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.match(
        error.message,
        /"id"/,
        "an argument refusal does not name the argument",
      );
      return true;
    },
  );
});
