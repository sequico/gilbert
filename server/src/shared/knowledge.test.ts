import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDraft,
  buildRevision,
  buildState,
  isKnowledgeDraft,
  isKnowledgeRevision,
  isKnowledgeState,
  isReservedArticleName,
  KNOWLEDGE_FOLDER,
  type KnowledgeState,
  knowledgeFolderName,
  MAX_TAGS,
  normalizeKnowledgeTags,
  pendingIsDue,
  plainTextFromBlocks,
  revisionInForceAt,
  stateAfterApproval,
} from "./knowledge.js";

/**
 * The knowledge base's one definition (ADR 0024).
 *
 * These pin the mechanisms a reader and a writer depend on: the folder-name
 * rule that makes a title a Files name, the lifecycle arithmetic that decides
 * which revision is in force and when a pending one takes over, and the
 * validators that let a reader trust a document it did not write. Each fails
 * if the mechanism is removed, which is what keeps "the KB versions its
 * articles" true rather than merely asserted.
 */

test("a title becomes the folder name Files carries", () => {
  assert.equal(knowledgeFolderName("  Quality  manual  "), "Quality manual");
  assert.equal(knowledgeFolderName("a/b"), "a-b", "a slash cannot be a path");
  assert.equal(knowledgeFolderName("..hidden"), "hidden", "a leading dot is stripped");
  assert.equal(
    knowledgeFolderName(""),
    "Untitled",
    "an empty title still names a folder",
  );
  assert.equal(knowledgeFolderName("   "), "Untitled");
  assert.ok(knowledgeFolderName("x".repeat(500)).length <= 200, "bounded to MAX_TITLE");
});

test("the reserved child is never an article", () => {
  assert.equal(isReservedArticleName("revisions"), true);
  assert.equal(isReservedArticleName("Revisions"), false, "case matters, as in Files");
  assert.equal(isReservedArticleName("Policies"), false);
});

test("tags normalise: trimmed, deduped, bounded", () => {
  assert.deepEqual(normalizeKnowledgeTags(["  ISO 9001 ", "iso 9001", "QMS"]), [
    "ISO 9001",
    "QMS",
  ]);
  assert.deepEqual(normalizeKnowledgeTags("nope"), []);
  assert.equal(
    normalizeKnowledgeTags(Array.from({ length: 100 }, (_, i) => `t${i}`)).length,
    MAX_TAGS,
  );
  assert.ok(normalizeKnowledgeTags(["x".repeat(200)])[0]!.length <= 60);
});

test("a draft validates, and a bare folder does not", () => {
  const draft = buildDraft({
    id: "a1",
    title: "Policy",
    tags: ["iso"],
    blocks: [],
    text: "",
    by: "gilbert@example.com",
    at: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(isKnowledgeDraft(draft), true);
  assert.equal(
    draft.created.at,
    draft.updated.at,
    "a new draft is born and updated at once",
  );
  assert.equal(isKnowledgeDraft({ ...draft, v: 2 }), false);
  assert.equal(isKnowledgeDraft({ id: "a1" }), false);
});

test("a revision carries the draft and its issuance", () => {
  const draft = buildDraft({
    id: "a1",
    title: "Policy",
    tags: [],
    blocks: [],
    text: "body",
    by: "gilbert@example.com",
    at: "2026-10-01T00:00:00.000Z",
  });
  const revision = buildRevision(draft, {
    revision: "r1",
    approvedBy: "gilbert@example.com",
    approvedAt: "2026-10-02T00:00:00.000Z",
    effectiveAt: "2026-10-02T00:00:00.000Z",
    supersedes: null,
  });
  assert.equal(isKnowledgeRevision(revision), true);
  assert.equal(revision.text, "body");
  assert.equal(revision.id, draft.id, "a revision keeps the article's identity");
  assert.equal(revision.supersedes, null);
});

test("the lifecycle: a past date is in force, a future date is pending", () => {
  const state: KnowledgeState = buildState({
    id: "a1",
    title: "Policy",
    tags: [],
    by: "gilbert@example.com",
    at: "2026-10-01T00:00:00.000Z",
  });
  const now = new Date("2026-10-10T00:00:00.000Z");

  const past = stateAfterApproval(
    state,
    {
      revision: "r1",
      effectiveAt: "2026-10-05T00:00:00.000Z",
      approvedBy: "gilbert@example.com",
      approvedAt: "2026-10-04T00:00:00.000Z",
      title: "Policy",
      tags: [],
    },
    now,
  );
  assert.equal(past.inForce?.revision, "r1");
  assert.equal(past.pending, null);
  assert.equal(isKnowledgeState(past), true);

  const future = stateAfterApproval(
    past,
    {
      revision: "r2",
      effectiveAt: "2026-11-01T00:00:00.000Z",
      approvedBy: "gilbert@example.com",
      approvedAt: "2026-10-11T00:00:00.000Z",
      title: "Policy",
      tags: [],
    },
    now,
  );
  assert.equal(future.inForce?.revision, "r1", "the old revision stays in force");
  assert.equal(future.pending?.revision, "r2", "the new one waits its date");
  assert.equal(pendingIsDue(future, now), false);

  // And once the date arrives, the reader sees the pending one without a write.
  const later = new Date("2026-11-02T00:00:00.000Z");
  assert.equal(pendingIsDue(future, later), true);
  assert.equal(revisionInForceAt(future, later)?.revision, "r2");
  assert.equal(
    revisionInForceAt(future, now)?.revision,
    "r1",
    "before the date, the previous revision is what a reader sees",
  );
});

test("approving again replaces the pending revision, never the one in force", () => {
  const base = buildState({
    id: "a1",
    title: "Policy",
    tags: [],
    by: "g",
    at: "2026-10-01T00:00:00.000Z",
  });
  const now = new Date("2026-10-10T00:00:00.000Z");
  const withPending = stateAfterApproval(
    base,
    {
      revision: "r1",
      effectiveAt: "2026-11-01T00:00:00.000Z",
      approvedBy: "g",
      approvedAt: "2026-10-09T00:00:00.000Z",
      title: "Policy",
      tags: [],
    },
    now,
  );
  const replaced = stateAfterApproval(
    withPending,
    {
      revision: "r2",
      effectiveAt: "2026-12-01T00:00:00.000Z",
      approvedBy: "g",
      approvedAt: "2026-10-10T00:00:00.000Z",
      title: "Policy",
      tags: [],
    },
    now,
  );
  assert.equal(replaced.pending?.revision, "r2");
  assert.equal(replaced.inForce, null, "nothing was ever in force yet");
});

test("an article with no approval is not in force", () => {
  const state = buildState({
    id: "a1",
    title: "T",
    tags: [],
    by: "g",
    at: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(revisionInForceAt(state, new Date("2027-01-01T00:00:00.000Z")), null);
});

test("a block document flattens to the text search and agents read", () => {
  const blocks = [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Quality " },
        { type: "text", text: "policy" },
      ],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Scope" }],
      children: [
        { type: "bulletListItem", content: [{ type: "text", text: "Packing" }] },
        { type: "bulletListItem", content: [{ type: "text", text: "Labels" }] },
      ],
    },
  ];
  const text = plainTextFromBlocks(blocks);
  assert.match(text, /Quality policy/);
  assert.match(text, /Scope/);
  assert.match(text, /Packing/);
  assert.match(text, /Labels/);
  assert.equal(plainTextFromBlocks("nope"), "");
});

test("the tier's folder is the one name both tiers walk", () => {
  assert.equal(KNOWLEDGE_FOLDER, "knowledge");
});
