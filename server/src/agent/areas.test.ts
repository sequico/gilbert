import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AREA_NAMES,
  areaOf,
  areasOfSurfaces,
  CONTEXT_TOOL_PREFIXES,
  catalogueFor,
  declaredAreas,
  isAreaTool,
  MAX_DECLARED_AREAS,
  selectedAreas,
} from "./areas.js";
import { TOOLS } from "./tools.js";

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

test("the areas of a run are its instruction's and its matrix's, plus the three", () => {
  const picked = selectedAreas(["workorders"], {
    chat: "watch",
    mail: "watch",
    files: "off",
    knowledge: "off",
    workorder: "off",
    calendar: "off",
  });
  assert.deepEqual(picked, ["mail", "knowledge", "workorders", "chat", "memory"]);
  assert.equal(selectedAreas([], undefined), null, "a run with neither selects nothing");
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

test("the matrix names the areas a group works, and forgets the ones turned off", () => {
  assert.deepEqual(
    [...areasOfSurfaces({ chat: "watch", mail: "watch", calendar: "off" })].sort(),
    ["chat", "knowledge", "mail", "memory"],
  );
  assert.deepEqual(
    [...areasOfSurfaces({ chat: "watch", workorder: "ondemand" })].sort(),
    ["chat", "knowledge", "memory", "workorders"],
  );
});

test("the selection narrows what a run may change, never what it may read", () => {
  const catalogue = [
    { name: "mail.search", writes: false },
    { name: "mail.send", writes: true },
    { name: "calendar.schedule", writes: true },
    { name: "run.read" },
  ];
  const picked = catalogueFor(catalogue, ["mail", "chat", "knowledge", "memory"]);
  assert.deepEqual(
    picked.map((tool) => tool.name),
    ["mail.search", "mail.send", "run.read"],
    "reading stays free; a write outside the areas is not offered",
  );
  assert.equal(catalogueFor(catalogue, null), catalogue, "no matrix, nothing to select");
});
