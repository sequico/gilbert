import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mentionsAddress,
  mentionsName,
  messageDoc,
  repliesToAuthor,
} from "../shared/chat.js";
import {
  AGENT_ACTION_SPECS,
  AGENT_AUDIT_OUTCOMES,
  AGENT_NOTEBOOK_FACT_MAX,
  AGENT_NOTES_MAX,
  AGENT_TRIGGERS,
  type AgentAction,
  type AgentEmailView,
  type AgentNotebookDoc,
  type AgentRule,
  agentRuleJsonSchema,
  CHAT_CONTEXT_DEFAULT,
  CHAT_CONTEXT_MAX,
  changeIdOf,
  clampChatContext,
  consentRequired,
  FENCED_ACTIONS,
  hopOf,
  irreversible,
  isAgentAction,
  isAgentJob,
  isAgentNotebookDoc,
  isAgentNotes,
  isAgentRule,
  isAgentRulesDoc,
  isAgentTriggerRecord,
  leavesTheProcess,
  matchEmailFilter,
  meterOver,
  missingActionParams,
  monthOf,
  monthsSince,
  newJob,
  nextRunAfter,
  notebookFor,
  notesProblem,
  reviewOutcome,
  ruleNotesProblem,
  ruleProblem,
  ruleProblems,
  SUPPORTED_FILTER_KEYS,
  schemaProblems,
  UnsupportedFilterError,
} from "./documents.js";

/* A rule that is valid as written, so each test can vary one thing at a time. */
function rule(over: Partial<AgentRule> = {}): AgentRule {
  return {
    v: 1,
    id: "r1",
    version: 1,
    name: "Sort the invoices",
    enabled: true,
    trigger: { on: "email", filter: { subject: "invoice" } },
    review: { mode: "never" },
    instruction: "Label the invoice so the group can find it.",
    capabilities: ["keyword.add"],
    ...over,
  };
}

function email(over: Partial<AgentEmailView> = {}): AgentEmailView {
  return {
    id: "e1",
    mailboxIds: { inbox: true },
    keywords: {},
    receivedAt: "2026-09-10T08:00:00Z",
    size: 1200,
    subject: "Invoice 42",
    from: [{ name: "Ada", email: "ada@example.org" }],
    to: [{ email: "team@example.org" }],
    body: "please pay",
    ...over,
  };
}

test("a rule carries the instruction it runs on and a capability to allow", () => {
  assert.equal(isAgentRule(rule()), true);
  // A rule without an instruction, or with nothing allowed, would match and
  // then have nothing to do at all, which is the failure these refuse.
  const { instruction: _i, ...noInstruction } = rule();
  assert.equal(isAgentRule(noInstruction), false);
  const { capabilities: _c, ...noCapabilities } = rule();
  assert.equal(isAgentRule(noCapabilities), false);
});

test("a threshold review without a number is refused, not guessed", () => {
  // Reading a missing threshold as 0 would auto-execute everything, which is
  // the one reading the owner did not choose.
  assert.equal(isAgentRule(rule({ review: { mode: "threshold" } })), false);
  assert.equal(
    isAgentRule(rule({ review: { mode: "threshold", threshold: 0.7 } })),
    true,
  );
});

test("rules.json round-trips through its validator", () => {
  assert.equal(isAgentRulesDoc({ v: 1, rules: [rule()] }), true);
  assert.equal(isAgentRulesDoc({ v: 1, rules: [rule({ id: "" })] }), false);
  assert.equal(isAgentRulesDoc({ v: 1 }), false);
});

test("the action catalogue is the only vocabulary an action can use", () => {
  assert.equal(isAgentAction({ do: "keyword.add", with: { keyword: "todo" } }), true);
  assert.equal(isAgentAction({ do: "rm -rf" }), false);
  assert.deepEqual(missingActionParams({ do: "keyword.add", with: {} }), ["keyword"]);
  assert.deepEqual(missingActionParams({ do: "keyword.add", with: { keyword: "  " } }), [
    "keyword",
  ]);
  assert.deepEqual(missingActionParams({ do: "noop" }), []);
});

test("sending reaches outside the group, so it needs consent", () => {
  const send: AgentAction = { do: "mail.send", with: { to: "a@b.c" } };
  const label: AgentAction = { do: "keyword.add", with: { keyword: "todo" } };
  assert.equal(consentRequired([label]), false);
  assert.equal(consentRequired([label, send]), true);
  // A policy of `never` cannot relax the floor: sending is the ADR's one
  // irreversible point, and the floor wins over the mode **and** over
  // `allowExternal` — an irreversible effect nobody was asked about is the
  // failure this floor exists to prevent, so no field of a rule document can
  // switch it off. `allowExternal` still governs the consent a *reversible*
  // external action needs; today `mail.send` is the only external action and it
  // is also irreversible, so the two coincide.
  assert.equal(reviewOutcome({ mode: "never" }, [send], 1), "pause");
  assert.equal(
    reviewOutcome({ mode: "never", allowExternal: true }, [send], 1),
    "pause",
    "the irreversible floor is not a knob",
  );
  assert.equal(irreversible([send]), true);
  assert.equal(irreversible([label]), false);
});

test("every action the fence names is fenced, whatever its spec flags say", () => {
  // The set a run must not repeat after its unit moved on is written out in the
  // code rather than read off the specs: `chat.post` and `mail.draft` reach
  // people without being `external`, `irreversible` or `unrepeatable`, and a
  // fence that read the flags let a run whose claim a successor took post in the
  // group's chat a second time.
  assert.deepEqual(
    [...FENCED_ACTIONS].sort(),
    [
      "chat.post",
      "document.extract",
      "document.merge",
      "document.split",
      "file.write",
      "mail.draft",
      "mail.extract",
      "mail.send",
    ],
    "the set names sending, posting, drafting, filing, and the page work that writes a file",
  );
  for (const name of FENCED_ACTIONS) {
    assert.equal(
      leavesTheProcess({ do: name }),
      true,
      `${name} leaves the process, so the fence stops for it`,
    );
  }
  // The actions the catalogue deliberately leaves outside it are the ones a
  // retry may redo: a label or a mailbox move is either idempotent or harmless
  // to do twice, and reading a page writes nothing at all — it hands the model
  // what the page says and leaves no trace to repeat.
  const inside = AGENT_ACTION_SPECS.map((spec) => spec.name)
    .filter((name) => !FENCED_ACTIONS.has(name))
    .sort();
  assert.deepEqual(inside, [
    "document.read",
    "keyword.add",
    "keyword.remove",
    "mail.move",
    "noop",
  ]);
  for (const name of inside) {
    assert.equal(leavesTheProcess({ do: name }), false, `${name} may run twice`);
  }
  // A spec that says it reaches a person is in the set: the flags and the fence
  // cannot drift apart with an action fenced in one place and not in the other.
  for (const spec of AGENT_ACTION_SPECS) {
    if (spec.external || spec.irreversible || spec.unrepeatable) {
      assert.equal(
        FENCED_ACTIONS.has(spec.name),
        true,
        `${spec.name} is flagged as leaving the process and is fenced for it`,
      );
    }
  }
});

test("the review gate follows the mode, the confidence and the T0 convention", () => {
  const label: AgentAction[] = [{ do: "keyword.add", with: { keyword: "todo" } }];
  assert.equal(reviewOutcome({ mode: "always" }, label, 1), "pause");
  assert.equal(reviewOutcome({ mode: "never" }, label, 0), "execute");
  assert.equal(
    reviewOutcome({ mode: "threshold", threshold: 0.6 }, label, 0.6),
    "execute",
  );
  assert.equal(
    reviewOutcome({ mode: "threshold", threshold: 0.6 }, label, 0.59),
    "pause",
  );
  // A deterministic run carries confidence 1, so a group wanting a person on
  // a T0 automation picks `always`, not a threshold.
  assert.equal(reviewOutcome({ mode: "threshold", threshold: 1 }, label, 1), "execute");
});

test("ruleProblem names what would stop a run", () => {
  assert.equal(ruleProblem(rule()), null);
  assert.match(ruleProblem(rule({ instruction: "   " })) ?? "", /needs an instruction/);
  assert.equal(
    ruleProblem(rule({ capabilities: [] })),
    "the rule needs at least one capability to allow: with none it could do nothing",
  );
});

test("the filter subset matches the way RFC 8621 says it should", () => {
  assert.equal(matchEmailFilter(undefined, email()), true);
  assert.equal(matchEmailFilter({ subject: "invoice" }, email()), true);
  assert.equal(
    matchEmailFilter({ subject: "INVOICE" }, email()),
    true,
    "case-insensitive",
  );
  assert.equal(matchEmailFilter({ subject: "receipt" }, email()), false);
  assert.equal(matchEmailFilter({ from: "ada" }, email()), true);
  assert.equal(matchEmailFilter({ from: "grace" }, email()), false);
  assert.equal(matchEmailFilter({ to: "team@example.org" }, email()), true);
  assert.equal(matchEmailFilter({ inMailbox: "inbox" }, email()), true);
  assert.equal(matchEmailFilter({ inMailbox: "archive" }, email()), false);
  assert.equal(matchEmailFilter({ hasKeyword: "$seen" }, email()), false);
  assert.equal(
    matchEmailFilter({ hasKeyword: "$seen" }, email({ keywords: { $seen: true } })),
    true,
  );
  assert.equal(matchEmailFilter({ notKeyword: "$seen" }, email()), true);
  assert.equal(matchEmailFilter({ minSize: 1000, maxSize: 2000 }, email()), true);
  assert.equal(matchEmailFilter({ minSize: 5000 }, email()), false);
  assert.equal(matchEmailFilter({ before: "2026-09-11T00:00:00Z" }, email()), true);
  assert.equal(matchEmailFilter({ before: "2026-09-09T00:00:00Z" }, email()), false);
  assert.equal(matchEmailFilter({ after: "2026-09-10T00:00:00Z" }, email()), true);
  assert.equal(matchEmailFilter({ body: "pay" }, email()), true);
  assert.equal(matchEmailFilter({ text: "ada" }, email()), true);
});

test("the three operators compose, and NOT negates", () => {
  assert.equal(
    matchEmailFilter(
      {
        operator: "AND",
        conditions: [{ subject: "invoice" }, { from: "ada" }],
      },
      email(),
    ),
    true,
  );
  assert.equal(
    matchEmailFilter(
      {
        operator: "OR",
        conditions: [{ subject: "receipt" }, { from: "ada" }],
      },
      email(),
    ),
    true,
  );
  assert.equal(
    matchEmailFilter({ operator: "NOT", conditions: [{ subject: "invoice" }] }, email()),
    false,
  );
});

test("a filter the executor cannot honour is refused loudly, never ignored", () => {
  // A rule that silently never fires is the failure the ADR calls out: the
  // operator would have no way to tell it apart from a rule that matches
  // nothing.
  assert.throws(
    () => matchEmailFilter({ inThread: "t1" }, email()),
    (err: unknown) => err instanceof UnsupportedFilterError && err.key === "inThread",
  );
  assert.throws(
    () => matchEmailFilter({ operator: "XOR", conditions: [] }, email()),
    UnsupportedFilterError,
  );
  assert.throws(
    () => matchEmailFilter({ operator: "AND" }, email()),
    UnsupportedFilterError,
  );
});

test("a job is born pending, with the rule version it started on", () => {
  const job = newJob({
    id: "j1",
    accountId: "g1",
    rule: { id: "r1", version: 3 },
    trigger: { on: "email", emailId: "e1", at: "2026-09-10T08:00:00Z" },
  });
  assert.equal(job.state, "pending");
  assert.equal(job.ruleVersion, 3);
  assert.equal(job.attempts, 0);
  assert.equal(isAgentJob(job), true);
  assert.equal(isAgentJob({ ...job, state: "waiting" }), false);
  assert.equal(isAgentJob({ ...job, lease: { owner: "w1" } }), false);
});

test("the schedule's next instant is in the future and on the grid", () => {
  const scheduled = rule({
    trigger: { on: "schedule", everyMinutes: 15 },
  });
  const now = new Date("2026-09-10T08:07:00Z");
  const next = nextRunAfter(scheduled, now);
  assert.equal(next?.toISOString(), "2026-09-10T08:15:00.000Z");
  // On the grid exactly: the next one, not this one.
  const onGrid = nextRunAfter(scheduled, new Date("2026-09-10T08:15:00Z"));
  assert.equal(onGrid?.toISOString(), "2026-09-10T08:30:00.000Z");
  assert.equal(nextRunAfter(rule(), now), null, "a non-schedule rule has no next run");
});

test("the chat context is bounded: 50 by default, 300 at the ceiling", () => {
  assert.equal(clampChatContext(), CHAT_CONTEXT_DEFAULT);
  assert.equal(clampChatContext(undefined), 50);
  assert.equal(clampChatContext(10), 10);
  assert.equal(clampChatContext(5000), CHAT_CONTEXT_MAX);
  assert.equal(clampChatContext(0), 50);
  assert.equal(clampChatContext(Number.NaN), 50);
});

test("a mention finds the address and the local part, and stops at the word", () => {
  const address = "gilbert@example.org";
  assert.equal(mentionsAddress("hi @gilbert@example.org", address), true);
  assert.equal(mentionsName("hi @gilbert@example.org", address), true);
  // Typed by hand and never picked from the picker: the ADR calls this a
  // mention too, and it is the loose form the executor must honour.
  assert.equal(mentionsName("@gilbert can you file this?", address), true);
  assert.equal(mentionsName("@Gilbert please", address), true);
  assert.equal(mentionsName("@gilberta no", address), false);
  assert.equal(mentionsName("@gilbert.example.org no", address), false);
  assert.equal(
    mentionsAddress("@gilbert", address),
    false,
    "the strict form stays strict",
  );
});

test("a reply counts as an address only when its parent is the agent's", () => {
  const agent = "gilbert@example.org";
  const mine = { from: agent } as const;
  const theirs = { from: "ada@example.org" } as const;
  assert.equal(repliesToAuthor({ replyTo: "m1" }, mine, agent), true);
  assert.equal(repliesToAuthor({ replyTo: "m1" }, theirs, agent), false);
  assert.equal(repliesToAuthor({}, mine, agent), false);
  assert.equal(repliesToAuthor({ replyTo: "m1" }, null, agent), false);
});

test("a message document carries the mention the picker wrote", () => {
  const doc = messageDoc("gilbert@example.org", "on it @ada@example.org", "m1", [
    { kind: "principal", id: "ada@example.org" },
  ]);
  assert.equal(doc.v, 1);
  assert.deepEqual(doc.mentions, [{ kind: "principal", id: "ada@example.org" }]);
  assert.equal(doc.replyTo, "m1");
  assert.equal(messageDoc("a@b.c", "plain").mentions, undefined);
});

test("the published schema is the same catalogue the runtime reads", () => {
  // One source of truth: the schema is built from the constants, and this is
  // the test that fails if somebody adds a trigger or an action to one and not
  // the other.
  type Node = {
    enum?: string[];
    items?: { enum?: string[]; properties?: Record<string, { enum?: string[] }> };
    properties?: Record<string, Node>;
    allOf?: unknown[];
  };
  const schema = agentRuleJsonSchema() as unknown as {
    $schema: string;
    required: string[];
    properties: Record<string, Node>;
    "x-actions": Array<{ name: string; params: unknown[] }>;
    "x-filterKeys": string[];
  };
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(schema.required.includes("instruction"));
  assert.ok(schema.required.includes("capabilities"));
  assert.deepEqual(schema.properties.trigger?.properties?.on?.enum, [...AGENT_TRIGGERS]);
  assert.deepEqual(schema.properties.review?.properties?.mode?.enum, [
    "always",
    "threshold",
    "never",
  ]);
  const names = AGENT_ACTION_SPECS.map((spec) => spec.name);
  assert.deepEqual(
    schema.properties.capabilities?.items?.enum,
    names,
    "a rule may name exactly the catalogue's actions",
  );
  assert.deepEqual(schema["x-filterKeys"], [...SUPPORTED_FILTER_KEYS]);
  assert.deepEqual(
    schema["x-actions"].map((action) => action.name),
    names,
  );
  assert.ok(schema.required.includes("instruction"));
  assert.ok(schema.required.includes("review"));
  // The cross-field halves the schema can state: a schedule needs its
  // interval, a threshold needs its number.
  assert.ok(Array.isArray(schema.properties.trigger?.allOf));
  assert.ok(Array.isArray(schema.properties.review?.allOf));
});

test("a notebook is facts, and a fact the document cannot hold is refused", () => {
  const doc: AgentNotebookDoc = {
    v: 1,
    facts: [{ id: "f1", text: "Invoices are filed under the client's name." }],
    updatedAt: "2026-09-12T10:00:00.000Z",
    updatedBy: "demo@example.com",
  };
  assert.equal(isAgentNotebookDoc(doc), true);
  assert.equal(
    isAgentNotebookDoc({ ...doc, facts: [] }),
    true,
    "a group may hold nothing",
  );
  assert.equal(
    isAgentNotebookDoc({
      ...doc,
      facts: [{ id: "f1", text: "x".repeat(AGENT_NOTEBOOK_FACT_MAX + 1) }],
    }),
    false,
    "a fact longer than the document allows is not a fact",
  );
  assert.equal(
    isAgentNotebookDoc({
      v: 1,
      facts: [{ text: "no id" }],
      updatedAt: "x",
      updatedBy: "y",
    }),
    false,
    "every fact carries the id a surface changes it by",
  );
});

test("the notebook reaches the prompt as one line per fact, in the order the group keeps them", () => {
  assert.equal(notebookFor(null), "");
  assert.equal(
    notebookFor({
      v: 1,
      facts: [
        { id: "a", text: "The group works in Italian." },
        { id: "b", text: "   " },
        { id: "c", text: "Ada's invoices are filed under the client." },
      ],
      updatedAt: "2026-09-12T10:00:00.000Z",
      updatedBy: "demo@example.com",
    }),
    "- The group works in Italian.\n- Ada's invoices are filed under the client.",
    "a blank fact is nothing to say, not a blank line",
  );
});

test("a meter adds what was reported and counts the runs that said nothing", () => {
  const full = meterOver([
    {
      outcome: "running",
      usage: { inputHitTokens: 900, inputMissTokens: 30, outputTokens: 7 },
    },
    {
      outcome: "failed",
      usage: { inputHitTokens: 100, inputMissTokens: null, outputTokens: 3 },
    },
  ]);
  assert.deepEqual(full, {
    inputHitTokens: 1000,
    inputMissTokens: 30,
    outputTokens: 10,
    runs: 2,
    uncounted: 0,
  });
  // A run the provider gave no numbers for is counted, not added as a zero: a
  // reading has to be able to say "twelve runs, nine counted" (ADR 0003).
  const mixed = meterOver([
    {
      outcome: "done",
      usage: { inputHitTokens: 5, inputMissTokens: null, outputTokens: null },
    },
    { outcome: "awaiting_approval" },
  ]);
  assert.deepEqual(mixed, {
    inputHitTokens: 5,
    inputMissTokens: null,
    outputTokens: null,
    runs: 2,
    uncounted: 1,
  });
  // A refusal is the absence of a run, a due run nothing fired never asked a
  // provider anything, and a holder that stopped reporting answers for nothing:
  // none of the three is a run, and none is a run whose provider was silent.
  const absent = meterOver([
    { outcome: "refused" },
    { outcome: "missed" },
    { outcome: "timeout" },
  ]);
  assert.deepEqual(absent, {
    inputHitTokens: null,
    inputMissTokens: null,
    outputTokens: null,
    runs: 0,
    uncounted: 0,
  });
  assert.deepEqual(meterOver([]), {
    inputHitTokens: null,
    inputMissTokens: null,
    outputTokens: null,
    runs: 0,
    uncounted: 0,
  });
  // Silence arrives in two shapes and reads as one fact: a provider that
  // reported no field at all is the same run whether the entry carries no
  // usage or a row of nulls (ADR 0003).
  assert.deepEqual(
    meterOver([
      {
        outcome: "done",
        usage: { inputHitTokens: null, inputMissTokens: null, outputTokens: null },
      },
    ]),
    {
      inputHitTokens: null,
      inputMissTokens: null,
      outputTokens: null,
      runs: 1,
      uncounted: 1,
    },
  );
  // A pass that resumed a plan already decided was counted where the plan was
  // made: counting it here would bill one run twice (ADR 0003).
  assert.deepEqual(meterOver([{ outcome: "running", resumed: true }]), {
    inputHitTokens: null,
    inputMissTokens: null,
    outputTokens: null,
    runs: 0,
    uncounted: 0,
  });
});

test("the published schema is what a save is refused against", () => {
  // One validator, from the one document: the editor in the browser and the
  // save path on the server run the same check.
  assert.deepEqual(schemaProblems(rule()), []);
  assert.deepEqual(ruleProblems(rule()), []);

  const noActions = schemaProblems(rule({ actions: [] }));
  assert.deepEqual(noActions, [], "an empty action list is a shape the schema allows");

  // The cross-field half comes through the same door, so a form shows one list.
  const noCaps = ruleProblems(rule({ capabilities: [] }));
  assert.ok(noCaps.some((problem) => /capabilities/.test(problem)));
  assert.ok(ruleProblems({ hello: "world" }).length > 0, "not a rule at all");
});

test("a filter that is valid and could never fire is refused, not accepted", () => {
  // The failure this closes: `minSize: "1000"` is a supported key with a value
  // the matcher compares as a number, so it is false for every message — an
  // automation that looks armed and silently does nothing.
  const typed = rule({
    trigger: { on: "email", filter: { minSize: "1000" } },
  });
  assert.deepEqual(schemaProblems(typed), [], "the schema alone cannot see it");
  assert.ok(
    ruleProblems(typed).some((problem) => /number/.test(problem)),
    "and the author is told before saving",
  );

  // A key beside `operator` is the same failure the other way: silently
  // ignored rather than refused.
  const sibling = rule({
    trigger: {
      on: "email",
      filter: { operator: "OR", conditions: [{ subject: "x" }], minSize: 10 },
    },
  });
  assert.ok(
    ruleProblems(sibling).some((problem) => /minSize/.test(problem)),
    "the key the matcher would never read is named",
  );
  assert.throws(
    () =>
      matchEmailFilter(
        { operator: "OR", conditions: [{ subject: "x" }], minSize: 10 },
        email(),
      ),
    /minSize beside OR/,
    "and the executor refuses it too, rather than matching as if it were absent",
  );

  const fine = rule({
    trigger: {
      on: "email",
      filter: { operator: "OR", conditions: [{ subject: "x" }, { minSize: 10 }] },
    },
  });
  assert.deepEqual(ruleProblems(fine), []);
});

test("a group with no conditions is refused, whichever operator groups it", () => {
  // An empty group is not "no filter": `AND` over nothing is true, `OR` over
  // nothing is false, and `NOT` over nothing matches every message in the
  // account. A rule like that is armed and does something nobody wrote, so the
  // author is refused rather than left with a surprise in the trail.
  for (const operator of ["AND", "OR", "NOT"]) {
    const grouped = rule({
      trigger: { on: "email", filter: { operator, conditions: [] } },
    });
    assert.ok(
      ruleProblems(grouped).some((problem) => /has none/.test(problem)),
      `${operator} with no conditions is refused`,
    );
  }

  // The shape without a conditions list at all is the same defect, and refused
  // the same way rather than reaching the matcher.
  const missing = rule({ trigger: { on: "email", filter: { operator: "AND" } } });
  assert.ok(
    ruleProblems(missing).some((problem) => /has none/.test(problem)),
    "an operator without its conditions is refused too",
  );

  const fine = rule({
    trigger: { on: "email", filter: { operator: "NOT", conditions: [] } },
  });
  assert.deepEqual(
    schemaProblems(fine),
    [],
    "the published schema still accepts the shape",
  );
  assert.ok(ruleProblems(fine).length > 0, "and the authoring rules are what refuses it");
});

test("the material a run needs is checked for being there, not just typed", () => {
  // `""` is a string, so the schema is satisfied and the model is asked
  // nothing; the emptiness is a rule the document cannot state.
  assert.ok(
    ruleProblems(rule({ instruction: "" })).some((problem) =>
      /instruction/.test(problem),
    ),
  );
  assert.ok(
    ruleProblems(rule({ capabilities: [] })).some((problem) => /nothing/.test(problem)),
  );
});

/**
 * One door for an author's notes (ADR 0003).
 *
 * The bound is one number and the refusal is one code, wherever a person writes
 * notes: the group's standing instruction answers with the code and the maximum,
 * and an automation's own notes are read through the same door rather than
 * coming back as a complaint about the shape of a document.
 */
test("a note past the bound is refused with the code and the number it may be", () => {
  const atBound = "x".repeat(AGENT_NOTES_MAX);
  const over = "x".repeat(AGENT_NOTES_MAX + 1);
  assert.equal(notesProblem(atBound), null, "a note at the bound fits");
  assert.equal(notesProblem(undefined), null, "and no notes at all is no problem");
  assert.deepEqual(notesProblem(over), {
    code: "notes_too_long",
    max: AGENT_NOTES_MAX,
    length: AGENT_NOTES_MAX + 1,
  });

  // A rule arrives as an untyped document: this is what a save answers a person
  // with, instead of a schema complaint about a length.
  assert.deepEqual(ruleNotesProblem(rule({ notes: over })), {
    code: "notes_too_long",
    max: AGENT_NOTES_MAX,
    length: AGENT_NOTES_MAX + 1,
  });
  assert.equal(
    ruleNotesProblem(rule({ notes: atBound })),
    null,
    "a note at the bound fits here too",
  );
  assert.equal(
    ruleNotesProblem({ hello: "world" }),
    null,
    "and a document that carries no notes field has no note to refuse",
  );

  // The validator reads the same door, so a note the door refuses is a document
  // this build does not accept.
  assert.equal(isAgentNotes(over), false);
  assert.equal(isAgentNotes(atBound), true);
  assert.equal(isAgentRule(rule({ notes: over })), false);
});

test("a retention window is the months it spans, oldest first", () => {
  assert.deepEqual(
    monthsSince(new Date("2026-09-10T12:00:00Z"), new Date("2026-11-02T00:00:00Z")),
    ["2026-09", "2026-10", "2026-11"],
  );
  assert.equal(
    monthsSince(new Date("2025-09-10T12:00:00Z"), new Date("2026-09-10T12:00:00Z"))
      .length,
    13,
    "twelve months of retention reach across thirteen calendar months",
  );
  assert.deepEqual(
    monthsSince(new Date("2026-10-01T00:00:00Z"), new Date("2026-09-30T00:00:00Z")),
    [],
    "a window that ends before it starts holds no month",
  );
});

test("the window's oldest month is the month the prune keeps, not the one it drops", () => {
  // `pruneAudit` drops whole months below `monthOf(keepFrom)`, so the oldest
  // month a copy can still read is that month itself. The two rules have to
  // agree on that boundary, or a copy asks for a month that is already gone.
  const keepFrom = new Date("2025-09-10T12:00:00Z");
  const now = new Date("2026-09-10T12:00:00Z");
  const months = monthsSince(keepFrom, now);
  assert.equal(months[0], monthOf(keepFrom));
  assert.equal(months[months.length - 1], monthOf(now));
});

test("a job's trigger carries its lineage, and a trigger with no count is hop one", () => {
  // The count starts at the trigger (ADR 0003): what wakes a rule by itself is
  // hop one, and a record written before the count existed reads as that too.
  const base = { v: 1 as const, id: "j1", accountId: "a3", ruleId: "r1", ruleVersion: 1 };
  const at = "2026-09-10T12:00:00Z";
  const made = newJob({
    id: "j1",
    accountId: "a3",
    rule: { id: "r1", version: 1 },
    trigger: { on: "email", emailId: "m1", at },
  });
  assert.equal(made.trigger.hop, 1, "a job nothing woke but its trigger is hop one");
  assert.equal(made.trigger.parentJobId, undefined);

  const woken = {
    ...base,
    state: "pending",
    trigger: { on: "filenode", nodeId: "n1", parentJobId: "j0", hop: 3, at },
    attempts: 0,
    createdAt: at,
    updatedAt: at,
  };
  assert.ok(isAgentJob(woken), "the lineage the job document carries reads back");
  assert.equal(hopOf({ hop: 3 }), 3);
  assert.equal(hopOf({}), 1, "and a trigger with no count is hop one");
  assert.equal(hopOf({ hop: 0 }), 1, "a count below one is not a hop");
  assert.equal(
    isAgentTriggerRecord({ on: "filenode", nodeId: "n1", parentJobId: "j0", hop: 0, at }),
    false,
    "a hop that is not a hop is refused rather than read as one",
  );
  assert.ok(
    isAgentJob({
      ...woken,
      effects: [
        { type: "Email", id: "m1" },
        { type: "FileNode", id: "n1" },
      ],
    }),
    "and the records a run wrote ride the job that wrote them",
  );
  assert.equal(
    isAgentJob({ ...woken, effects: [{ type: "Mailbox", id: "x" }] }),
    false,
    "a record the change cannot name back is not an effect",
  );
  assert.ok(
    AGENT_AUDIT_OUTCOMES.includes("refused"),
    "a refusal is an outcome of its own, beside missed and timeout",
  );
  assert.equal(
    changeIdOf({ on: "filenode", nodeId: "n1", at }),
    "n1",
    "a change is identified by the record it names, not by the pass that read it",
  );
  assert.equal(
    changeIdOf({ on: "manual", emailId: "m1", at }),
    at,
    "and a person's ask by the instant it was made",
  );
});
