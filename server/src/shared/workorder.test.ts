import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChecklist,
  buildWorkorderDoc,
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
  const checklist = buildChecklist(template, ["s1", "s2"]);
  assert.deepEqual(checklist.template, template);
  assert.deepEqual(
    checklist.steps.map((s) => [s.id, s.state, s.by, s.at]),
    [
      ["s1", "open", null, null],
      ["s2", "open", null, null],
    ],
  );
  assert.equal(stepOf(checklist, "s2")?.id, "s2");
  assert.equal(stepOf(checklist, "nope"), undefined);
});

test("a root carries the name and the state; a part does not", () => {
  const checklist = buildChecklist(template, ["s1"]);
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
  const checklist = buildChecklist(template, ["s1"]);
  const good = buildWorkorderDoc({ uid: "u1", by: "g", at: "t", checklist });
  assert.equal(isWorkorderDoc({ ...good, v: 2 }), false);
  assert.equal(isWorkorderDoc({ ...good, uid: 7 }), false);
  assert.equal(isWorkorderDoc({ ...good, state: "nope" }), false);
  assert.equal(
    isWorkorderDoc({
      ...good,
      checklist: { template, steps: [{ id: "s1", state: "maybe" }] },
    }),
    false,
    "a step state is open or done",
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
