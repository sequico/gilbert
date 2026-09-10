import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_LABELS,
  G_LABEL_PREFIX,
  GROUP_LABELS_FILE,
  isAgentLabel,
  isLabelCatalog,
  isLabelCatalogEntry,
  missingAgentLabels,
} from "./labels.js";

test("the reserved prefix names the agent's own state", () => {
  assert.equal(G_LABEL_PREFIX, "G-");
  assert.equal(isAgentLabel("G-processed"), true);
  assert.equal(isAgentLabel("todo"), false);
  // A human label that merely starts with a capital G is not reserved.
  assert.equal(isAgentLabel("Groceries"), false);
});

test("the fixed set is complete and consistent", () => {
  const keywords = AGENT_LABELS.map((l) => l.keyword);
  assert.deepEqual(keywords, [
    "G-needattention",
    "G-processed",
    "G-awaiting",
    "G-rejected",
  ]);
  for (const label of AGENT_LABELS) {
    assert.ok(isAgentLabel(label.keyword), `${label.keyword} carries the prefix`);
    assert.ok(label.name.length > 0);
    assert.match(label.color, /^#[0-9a-f]{6}$/i);
  }
});

test("the catalog validator accepts what a group writes and nothing else", () => {
  assert.equal(
    isLabelCatalogEntry({ keyword: "todo", name: "TODO", color: "#dc2626" }),
    true,
  );
  // Nesting is display-only and the field is optional, so an entry that
  // carries it is still a valid entry.
  assert.equal(
    isLabelCatalogEntry({ keyword: "a", name: "A", color: "#111111", parent: "b" }),
    true,
  );
  assert.equal(isLabelCatalogEntry({ keyword: "", name: "A", color: "#111111" }), false);
  assert.equal(isLabelCatalogEntry({ name: "A", color: "#111111" }), false);
  assert.equal(isLabelCatalog({ labels: [] }), true);
  assert.equal(
    isLabelCatalog({ labels: [{ keyword: "k", name: "n", color: "c" }] }),
    true,
  );
  assert.equal(isLabelCatalog({ labels: [{}] }), false);
  assert.equal(isLabelCatalog([]), false);
  assert.equal(isLabelCatalog(null), false);
});

test("the guard names exactly the G- labels the group's catalog lacks", () => {
  const catalog = [
    { keyword: "todo", name: "TODO", color: "#dc2626" },
    { keyword: "G-processed", name: "Gilbert: processed", color: "#15803d" },
  ];
  assert.deepEqual(missingAgentLabels(catalog, ["G-processed"]), []);
  assert.deepEqual(missingAgentLabels(catalog, ["G-processed", "G-awaiting"]), [
    "G-awaiting",
  ]);
  // Human labels are free-form: the executor does not guard what the group
  // never had to declare.
  assert.deepEqual(missingAgentLabels(catalog, ["todo", "invoices"]), []);
  // The same missing keyword twice is named once.
  assert.deepEqual(missingAgentLabels(catalog, ["G-awaiting", "G-awaiting"]), [
    "G-awaiting",
  ]);
  assert.deepEqual(missingAgentLabels([], ["G-needattention"]), ["G-needattention"]);
});

test("the catalog file name is the one both tiers read", () => {
  assert.equal(GROUP_LABELS_FILE, "labels.json");
});
