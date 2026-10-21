import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOLS } from "./tools.js";
import {
  AREA_NAMES,
  areaOf,
  CONTEXT_TOOL_PREFIXES,
  declaredAreas,
  isAreaTool,
  MAX_DECLARED_AREAS,
  selectAreas,
  TRANSVERSAL_AREAS,
} from "./areas.js";

/**
 * The areas a run's catalogue is made of (ADR 0038).
 *
 * The invariants that keep "a run sees a handful of tools" true: every tool
 * belongs to exactly one area (so a new tool cannot be invisible to the
 * selection), the transversal three are always present, a change's own area is
 * always present, and a group cannot declare its way back to forty-five.
 */

test("every tool in the catalogue names an area, and one only", () => {
  const seen = new Map<string, string>();
  for (const tool of TOOLS) {
    const area = isAreaTool(tool.name) ? areaOf(tool.name) : null;
    if (area === null) {
      assert.ok(
        CONTEXT_TOOL_PREFIXES.includes(tool.name.split(".")[0] ?? ""),
        `${tool.name} is either an area's tool or the harness's own`,
      );
      continue;
    }
    assert.ok(
      (AREA_NAMES as readonly string[]).includes(area),
      `${tool.name} belongs to a known area`,
    );
    const held = seen.get(tool.name);
    assert.equal(held, undefined, `${tool.name} is named once`);
    seen.set(tool.name, area);
  }
  assert.ok(seen.size > 0, "the catalogue is not empty");
});

test("a tool whose name names no area is refused, not guessed at", () => {
  assert.throws(() => areaOf("frobnicate.thing"), /names no area/);
  assert.throws(() => areaOf("mail"), /names no area/);
});

test("a prefix that is not the area's name still lands in its area", () => {
  assert.equal(areaOf("workorder.list"), "workorders");
  assert.ok(!isAreaTool("run.read"), "the harness's own tool is in no area");
});

test("the transversal areas are in every selection, whatever is declared", () => {
  const picked = selectAreas("files", []);
  for (const area of TRANSVERSAL_AREAS)
    assert.ok(picked.includes(area), `${area} is always selectable`);
  assert.ok(picked.includes("files"), "and the change's own area is there");
  assert.ok(!picked.includes("calendar"), "and nothing else is");
});

test("the change's area and the declared ones are both selected", () => {
  const picked = selectAreas("mail", ["files", "workorders"]);
  assert.deepEqual([...picked].sort(), [
    "chat",
    "files",
    "knowledge",
    "mail",
    "memory",
    "workorders",
  ]);
});

test("a group cannot declare its way back to a catalogue of forty-five", () => {
  const four = ["mail", "files", "calendar", "workorders"] as const;
  const refused = declaredAreas(four);
  assert.ok(refused.problem, "four areas are refused");
  assert.match(refused.problem ?? "", new RegExp(String(MAX_DECLARED_AREAS)));
  assert.equal(declaredAreas(["mail", "files", "calendar"]).problem, null);
});

test("an area nobody has is refused with the list of the ones there are", () => {
  const refused = declaredAreas(["mail", "invoices"]);
  assert.match(refused.problem ?? "", /"invoices"/);
  assert.match(refused.problem ?? "", /mail, files, calendar/);
  assert.deepEqual(refused.areas, ["mail"], "and the known ones are kept");
});
