import assert from "node:assert/strict";
import { test } from "node:test";
import {
  G_LABEL_PREFIX,
  GROUP_LABELS_FILE,
  isAgentLabel,
  isLabelCatalog,
  isLabelCatalogEntry,
} from "./labels.js";

test("the reserved prefix names the reserved state", () => {
  assert.equal(G_LABEL_PREFIX, "G-");
  assert.equal(isAgentLabel("G-processed"), true);
  assert.equal(isAgentLabel("todo"), false);
  // A human label that merely starts with a capital G is not reserved.
  assert.equal(isAgentLabel("Groceries"), false);
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

test("the catalog file name is the one both tiers read", () => {
  assert.equal(GROUP_LABELS_FILE, "labels.json");
});
