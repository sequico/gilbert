import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AREA_NAMES,
  areaOfSource,
  declaredAreas,
  surfaceOfArea,
  writeSurfacesOf,
} from "../shared/areas.js";
import type { SurfaceMatrix } from "../shared/surfaces.js";
import { catalogueFor, selectedAreas } from "./areas.js";
import { TOOLS } from "./tools.js";

/**
 * The areas a run's catalogue is made of (ADR 0038).
 *
 * The invariants that keep "a run sees a handful of tools" true: every tool
 * belongs to exactly one area (so a new tool cannot be invisible to the
 * selection), the transversal three are always present, a change's own area is
 * always present, and a group cannot declare its way back to forty-five.
 */

test("the catalogue is eight jobs, each a name a provider accepts", () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.name),
    ["read", "find", "place", "draft", "event", "say", "remember", "settle"],
  );
  for (const tool of TOOLS)
    assert.match(
      tool.name,
      /^[a-zA-Z0-9_-]+$/,
      `${tool.name} is a function name a provider accepts`,
    );
});

test("the selection keeps reading free and narrows the four area writes", () => {
  const picked = catalogueFor(TOOLS, ["mail", "files", "chat", "knowledge", "memory"]);
  assert.deepEqual(
    picked.map((tool) => tool.name),
    ["read", "find", "place", "draft", "say", "remember"],
  );
  const place = picked.find((tool) => tool.name === "place");
  assert.ok(place);
  const actions = place.args.action?.values ?? [];
  assert.ok(actions.includes("file"), "a mail action is kept");
  assert.ok(actions.includes("save"), "a files action is kept");
  assert.ok(!actions.includes("create"), "no calendar action is invented");

  const calendarOnly = catalogueFor(TOOLS, ["calendar", "chat", "knowledge", "memory"]);
  assert.deepEqual(
    calendarOnly.map((tool) => tool.name),
    ["read", "find", "event", "say", "remember"],
  );
  assert.equal(
    TOOLS.find((tool) => tool.name === "settle")?.narrow?.(["mail"]),
    null,
    "a job whose area is not declared is not offered at all",
  );
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

test("every area may be declared, with no ceiling", () => {
  const all = [
    "mail",
    "files",
    "calendar",
    "contacts",
    "knowledge",
    "workorders",
    "chat",
    "memory",
  ] as const;
  const declared = declaredAreas(all);
  assert.equal(declared.problem, null, "all eight are accepted");
  assert.deepEqual([...declared.areas].sort(), [...all].sort());
});

test("a run writes through the areas it works, whatever wakes it", () => {
  const matrix = writeSurfacesOf(["mail", "files", "chat", "memory"]);
  assert.equal(matrix.mail, "watch", "a declared area may be written");
  assert.equal(matrix.files, "watch");
  assert.equal(matrix.chat, "watch", "the conversation is always writable");
  assert.equal(matrix.calendar, "off", "an undeclared area is not");
  assert.equal(
    matrix.knowledge,
    "off",
    "knowledge writes need the area, reading is free",
  );
});

test("an area nobody has is refused with the list of the ones there are", () => {
  const refused = declaredAreas(["mail", "invoices"]);
  assert.match(refused.problem ?? "", /"invoices"/);
  assert.match(refused.problem ?? "", /mail, files, calendar/);
  assert.deepEqual(refused.areas, ["mail"], "and the known ones are kept");
});

test("the matrix names the areas a group works, and forgets the ones turned off", () => {
  assert.deepEqual(
    [
      ...(selectedAreas([], {
        chat: "watch",
        mail: "watch",
        calendar: "off",
      } as SurfaceMatrix) ?? []),
    ].sort(),
    ["chat", "knowledge", "mail", "memory"],
  );
  assert.deepEqual(
    [
      ...(selectedAreas([], { chat: "watch", workorder: "ondemand" } as SurfaceMatrix) ??
        []),
    ].sort(),
    ["chat", "knowledge", "memory", "workorders"],
  );
});

test("a catalogue with no areas selected is handed whole", () => {
  assert.equal(catalogueFor(TOOLS, null), TOOLS, "no matrix, nothing to select");
});

test("every area's surface is the inverse of the surface's area", () => {
  /*
   * The wake row draws an area's surface beside the area, in the areas' own
   * order, so the two lists are one relation read twice. The two areas with no
   * surface are exactly the two whose changes can never wake a run (ADR 0038).
   */
  const wakeable = AREA_NAMES.filter((area) => surfaceOfArea(area) !== null);
  assert.deepEqual(wakeable, [
    "mail",
    "files",
    "calendar",
    "knowledge",
    "workorders",
    "chat",
  ]);
  for (const area of wakeable) {
    const surface = surfaceOfArea(area);
    assert.ok(surface);
    assert.equal(areaOfSource(surface), area, `"${surface}" reports as "${area}"`);
  }
  assert.equal(surfaceOfArea("contacts"), null, "contacts has no surface");
  assert.equal(surfaceOfArea("memory"), null, "memory has no surface");
});
