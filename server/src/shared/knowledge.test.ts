import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blocksFromText,
  buildDraft,
  buildRevision,
  buildState,
  checklistBlocks,
  checklistGroups,
  conditionClause,
  emptyChecklist,
  isChecklistTemplate,
  isKnowledgeChecklist,
  isKnowledgeDraft,
  isKnowledgeRevision,
  isKnowledgeState,
  isReservedArticleName,
  itemStepPath,
  KNOWLEDGE_FOLDER,
  type KnowledgeChecklist,
  type KnowledgeState,
  knowledgeFolderName,
  MAX_TAGS,
  normalizeKnowledgeTags,
  pendingIsDue,
  plainStepPath,
  plainTextFromBlocks,
  resolveChecklist,
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

test("plain text becomes blocks: headings, lists and paragraphs", () => {
  const text = [
    "Intro line one",
    "continues on the next line.",
    "",
    "## Section",
    "- first",
    "- second",
    "",
    "1. one",
    "2. two",
    "",
    "Closing paragraph.",
  ].join("\n");
  const blocks = blocksFromText(text) as Array<{
    type: string;
    content?: Array<{ text?: string }>;
    props?: { level?: number };
  }>;
  assert.deepEqual(
    blocks.map((block) => block.type),
    [
      "paragraph",
      "heading",
      "bulletListItem",
      "bulletListItem",
      "numberedListItem",
      "numberedListItem",
      "paragraph",
    ],
  );
  assert.equal(
    blocks[0]?.content?.[0]?.text,
    "Intro line one continues on the next line.",
    "consecutive plain lines fold into one paragraph",
  );
  assert.equal(blocks[1]?.props?.level, 2);
  assert.equal(blocks[2]?.content?.[0]?.text, "first");
  assert.equal(blocks[6]?.content?.[0]?.text, "Closing paragraph.");
  assert.deepEqual(blocksFromText("   "), [], "blank text mints no block");
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
    rev: 1,
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
      rev: 1,
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
      rev: 2,
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
      rev: 1,
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
      rev: 2,
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

/** A process template: a variant, a plain section, a repeat, a final section. */
const process: KnowledgeChecklist = {
  variants: [
    {
      key: "company",
      label: "Company",
      values: [
        { value: "north", label: "North" },
        { value: "south", label: "South" },
      ],
    },
  ],
  sections: [
    {
      key: "paperwork",
      label: "Paperwork",
      steps: [
        { key: "ref", label: "Record the reference" },
        {
          key: "sign",
          label: "Sign the form",
          condition: { variant: "company", equals: "north" },
        },
      ],
    },
    {
      key: "loading",
      label: "Loading",
      repeat: { item: "Container", fields: [{ key: "seal", label: "Seal" }] },
      steps: [
        { key: "load", label: "Load the container" },
        { key: "seal", label: "Seal the container" },
      ],
    },
    {
      key: "final",
      label: "Final",
      steps: [{ key: "dispatch", label: "Dispatch" }],
    },
  ],
};

test("a checklist template's rules build its body and its text", () => {
  const blocks = checklistBlocks(process);
  assert.deepEqual(
    blocks.map((block) => (block as { type?: unknown }).type),
    [
      "heading",
      "checkListItem",
      "checkListItem",
      "heading",
      "checkListItem",
      "checkListItem",
      "heading",
      "checkListItem",
    ],
    "each section is a heading and each step is a checklist item",
  );
  const headings = blocks
    .filter((block) => (block as { type?: unknown }).type === "heading")
    .map((block) => (block as { content?: Array<{ text?: string }> }).content?.[0]?.text);
  assert.deepEqual(
    headings,
    ["Paperwork", "Loading (per Container)", "Final"],
    "a repeated section names its item and a condition rides on the step",
  );
  const steps = blocks
    .filter((block) => (block as { type?: unknown }).type === "checkListItem")
    .map((block) => (block as { id?: unknown }).id);
  assert.deepEqual(
    steps,
    ["paperwork.ref", "paperwork.sign", "loading.load", "loading.seal", "final.dispatch"],
    "a step's id is its plain path, the stable key a workorder stores",
  );
  const text = plainTextFromBlocks(blocks);
  assert.match(text, /Paperwork/);
  assert.match(text, /Record the reference/);
  assert.match(text, /Sign the form \(company = north\)/);
});

test("the rules decide which sections, items and steps apply", () => {
  const resolved = resolveChecklist(
    process,
    { company: "north" },
    {
      loading: ["CONT-1", "CONT-2"],
    },
    null,
  );
  assert.deepEqual(
    resolved.map((section) => section.key),
    ["paperwork", "loading", "final"],
  );
  const paperwork = resolved[0]!;
  assert.equal(paperwork.repeat, null);
  assert.deepEqual(
    paperwork.items.map((item) => [item.key, item.label]),
    [["", "Paperwork"]],
    "a plain section is one item named by its section",
  );
  assert.deepEqual(
    paperwork.items[0]!.steps.map((step) => step.path),
    ["paperwork.ref", "paperwork.sign"],
    "the north branch keeps the conditional step",
  );
  const loading = resolved[1]!;
  assert.equal(loading.repeat?.item, "Container");
  assert.deepEqual(
    loading.items.map((item) => item.key),
    ["CONT-1", "CONT-2"],
    "a repeated section instantiates once per chosen item",
  );
  assert.deepEqual(
    loading.items[0]!.steps.map((step) => step.path),
    ["loading[CONT-1].load", "loading[CONT-1].seal"],
    "the item's key rides inside the step path so two containers never collide",
  );

  const south = resolveChecklist(
    process,
    { company: "south" },
    {
      loading: ["CONT-1"],
    },
    null,
  );
  assert.deepEqual(
    south[0]!.items[0]!.steps.map((step) => step.path),
    ["paperwork.ref"],
    "the south branch drops the step whose condition does not hold",
  );
});

test("a section's own condition gates the whole section", () => {
  const gated: KnowledgeChecklist = {
    variants: process.variants,
    sections: [
      {
        key: "hazmat",
        label: "Hazardous cargo",
        condition: { variant: "company", equals: "south" },
        repeat: { item: "Container", fields: [] },
        steps: [{ key: "plate", label: "Fix the placard" }],
      },
    ],
  };
  assert.deepEqual(
    resolveChecklist(gated, { company: "north" }, { hazmat: ["CONT-1"] }, null),
    [],
    "a section whose condition does not hold is left out whole",
  );
  const south = resolveChecklist(
    gated,
    { company: "south" },
    { hazmat: ["CONT-1"] },
    null,
  );
  assert.deepEqual(
    south[0]!.items[0]!.steps.map((step) => step.path),
    ["hazmat[CONT-1].plate"],
  );
});

test("a section assigned to a group resolves only for that group", () => {
  const grouped: KnowledgeChecklist = {
    variants: [],
    sections: [
      { key: "global", label: "Global", steps: [{ key: "g", label: "G" }] },
      {
        key: "customs",
        label: "Customs",
        group: "acct-customs",
        steps: [{ key: "decl", label: "Declare" }],
      },
    ],
  };
  assert.deepEqual(checklistGroups(grouped), ["acct-customs"]);
  assert.deepEqual(
    resolveChecklist(grouped, {}, {}, null).map((section) => section.key),
    ["global"],
    "the global part holds the unassigned sections",
  );
  assert.deepEqual(
    resolveChecklist(grouped, {}, {}, "acct-customs").map((section) => section.key),
    ["customs"],
    "a group's part holds only its assigned sections",
  );
});

test("a draft built from rules derives its body and travels with the definition", () => {
  const draft = buildDraft({
    id: "a1",
    title: "Packing",
    tags: [],
    blocks: [],
    text: "ignored on purpose",
    checklist: process,
    by: "g",
    at: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(isKnowledgeDraft(draft), true);
  assert.equal(isChecklistTemplate(draft), true);
  assert.deepEqual(draft.checklist, process);
  assert.match(
    draft.text,
    /Record the reference/,
    "the text is derived, never the caller's",
  );
  assert.equal(
    isKnowledgeDraft({ ...draft, checklist: { schema: {}, uiSchema: {} } }),
    false,
    "a definition that is not the process shape is refused",
  );
});

test("a page with blocks alone is not a checklist template", () => {
  const draft = buildDraft({
    id: "a1",
    title: "Policy",
    tags: [],
    blocks: [{ type: "checkListItem", id: "s1", content: [{ type: "text", text: "x" }] }],
    text: "x",
    by: "g",
    at: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(
    isChecklistTemplate(draft),
    false,
    "checklist-looking blocks alone do not make a template (ADR 0030)",
  );
  assert.equal(draft.checklist, null);
});

test("the path helpers and a condition clause are the contract's", () => {
  assert.equal(plainStepPath("loading", "seal"), "loading.seal");
  assert.equal(itemStepPath("loading", "CONT-1", "seal"), "loading[CONT-1].seal");
  assert.equal(
    conditionClause({ variant: "company", equals: "north" }),
    "company = north",
  );
  assert.equal(conditionClause(undefined), "");
});

test("an empty checklist is valid rules with no steps", () => {
  const empty = emptyChecklist();
  assert.equal(isKnowledgeChecklist(empty), true);
  assert.deepEqual(checklistBlocks(empty), []);
});

test("a section's gate is bounded, validated and carried into the resolution", () => {
  /*
   * The gate (ADR 0030): a section names up to three prerequisite sections; the
   * validator refuses a fourth, and `resolveChecklist` carries the keys so the
   * workorder side can decide whether the section shows. Fails if the bound or
   * the carry is removed.
   */
  const checklist: KnowledgeChecklist = {
    variants: [],
    sections: [
      {
        key: "production",
        label: "Production",
        steps: [{ key: "make", label: "Make" }],
      },
      {
        key: "billing",
        label: "Billing",
        requires: ["production"],
        steps: [{ key: "invoice", label: "Invoice" }],
      },
    ],
  };
  assert.equal(isKnowledgeChecklist(checklist), true, "a gated section validates");
  const resolved = resolveChecklist(checklist, {}, {}, null);
  assert.deepEqual(
    resolved.find((section) => section.key === "billing")?.requires,
    ["production"],
    "the resolution carries the gate's prerequisites",
  );

  const tooMany = {
    ...checklist,
    sections: [
      checklist.sections[0]!,
      { ...checklist.sections[1]!, requires: ["a", "b", "c", "d"] },
    ],
  };
  assert.equal(
    isKnowledgeChecklist(tooMany),
    false,
    "more than three prerequisites is refused",
  );
  const blocks = JSON.stringify(checklistBlocks(checklist));
  assert.match(blocks, /after production/, "the derived body names the gate");
});
