import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChecklist,
  buildWorkorderDoc,
  isStepComplete,
  isTerminalState,
  isWorkorderDoc,
  isWorkorderState,
  stepOf,
  WORKORDER_CLOSED_FOLDER,
  WORKORDER_FOLDER,
  type WorkorderTemplateRef,
  workorderFileName,
} from "./workorder.js";

/**
 * The workorder's one definition (ADR 0028).
 *
 * The shape, its validators and the pure helpers a document is built and read
 * through: a checklist bound to a KB template revision, the step states and
 * their signatures, the friendly name on the root, the terminal states. Each
 * test fails if the mechanism is removed.
 */

const template: WorkorderTemplateRef = {
  accountId: "acct",
  id: "kb-1",
  revision: "rev-1",
};

test("a checklist is bound to a template revision, every step open", () => {
  const checklist = buildChecklist({
    template,
    variants: { company: "north" },
    items: { loading: [{ key: "CONT-1", data: { seal: "S-1" } }] },
    stepPaths: ["paperwork.ref", "loading[CONT-1].load"],
  });
  assert.deepEqual(checklist.template, template);
  assert.deepEqual(checklist.variants, { company: "north" });
  assert.deepEqual(checklist.items.loading, [{ key: "CONT-1", data: { seal: "S-1" } }]);
  assert.deepEqual(
    checklist.steps.map((s) => [s.path, s.state, s.by, s.at, s.note]),
    [
      ["paperwork.ref", "open", null, null, ""],
      ["loading[CONT-1].load", "open", null, null, ""],
    ],
  );
  assert.equal(stepOf(checklist, "loading[CONT-1].load")?.path, "loading[CONT-1].load");
  assert.equal(stepOf(checklist, "nope"), undefined);
});

test("done and skipped count as complete; open and not-applicable do not", () => {
  assert.equal(isStepComplete("done"), true);
  assert.equal(isStepComplete("skipped"), true);
  assert.equal(isStepComplete("open"), false);
  assert.equal(isStepComplete("not-applicable"), false);
});

test("a root carries the name and the state; a part does not", () => {
  const checklist = buildChecklist({
    template,
    variants: {},
    items: {},
    stepPaths: ["paperwork.ref"],
  });
  const root = buildWorkorderDoc({
    uid: "u1",
    by: "master@example.com",
    at: "2026-10-02T00:00:00.000Z",
    checklist,
    name: "Q3 delivery",
    state: "running",
  });
  assert.equal(isWorkorderDoc(root), true);
  assert.equal(root.name, "Q3 delivery");
  assert.equal(root.state, "running");
  assert.equal(root.created.at, root.updated.at);

  const part = buildWorkorderDoc({
    uid: "u1",
    by: "master@example.com",
    at: "2026-10-02T00:00:00.000Z",
    checklist,
  });
  assert.equal(isWorkorderDoc(part), true);
  assert.equal(part.name, undefined, "a part carries no friendly name");
  assert.equal(part.state, undefined, "and no state");
});

test("the terminal states are the ones that move the root to closed/", () => {
  assert.equal(isTerminalState("running"), false);
  for (const state of ["completed", "cancelled", "replaced"] as const)
    assert.equal(isTerminalState(state), true);
  assert.equal(isWorkorderState("superseded"), false);
  assert.equal(isWorkorderState("running"), true, "the one non-terminal state is valid");
});

test("a malformed document is refused", () => {
  const checklist = buildChecklist({
    template,
    variants: {},
    items: {},
    stepPaths: ["paperwork.ref"],
  });
  const good = buildWorkorderDoc({ uid: "u1", by: "g", at: "t", checklist });
  assert.equal(isWorkorderDoc({ ...good, v: 2 }), false);
  assert.equal(isWorkorderDoc({ ...good, uid: 7 }), false);
  assert.equal(isWorkorderDoc({ ...good, state: "nope" }), false);
  assert.equal(
    isWorkorderDoc({
      ...good,
      checklist: { ...checklist, steps: [{ path: "s1", state: "maybe" }] },
    }),
    false,
    "a step state is one of the four",
  );
  assert.equal(
    isWorkorderDoc({
      ...good,
      checklist: { ...checklist, steps: [{ path: "s1", state: "open", by: null }] },
    }),
    false,
    "a step carries its instant and its note too",
  );
  assert.equal(
    isWorkorderDoc({ ...good, refs: [{ accountId: "a", kind: "mail", id: "x" }] }),
    false,
  );
});

test("the folder names and the file name are the contract's", () => {
  assert.equal(WORKORDER_FOLDER, "workorders");
  assert.equal(WORKORDER_CLOSED_FOLDER, "closed");
  assert.equal(workorderFileName("abc"), "abc.json");
});
