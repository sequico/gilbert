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
  AGENT_AREAS,
  AGENT_AUDIT_OUTCOMES,
  AGENT_AUTOMATION_LABELS,
  AGENT_LOOKUP_KINDS,
  AGENT_LOOKUP_MESSAGES_MAX,
  AGENT_LOOKUP_QUERY_MAX,
  AGENT_NOTEBOOK_FACT_MAX,
  AGENT_REVIEW_THRESHOLD,
  AGENT_SCHEDULE_MINUTES_DEFAULT,
  AGENT_SCHEDULE_PRESETS,
  AGENT_TRIGGERS,
  type AgentAction,
  type AgentGroupPolicyDoc,
  type AgentNotebookDoc,
  type AgentRule,
  actionParamsText,
  agentRuleJsonSchema,
  areaActions,
  automationLabel,
  CHAT_CONTEXT_DEFAULT,
  CHAT_CONTEXT_MAX,
  changeIdOf,
  clampChatContext,
  consentRequired,
  effectiveCapabilities,
  FENCED_ACTIONS,
  GONE_AUTOMATION_LABEL,
  hopOf,
  irreversible,
  isAgentAction,
  isAgentGroupPolicyDoc,
  isAgentJob,
  isAgentLookup,
  isAgentNotebookDoc,
  isAgentRule,
  isAgentRulesDoc,
  isAgentTriggerRecord,
  leavesTheProcess,
  lookupLabel,
  meterOver,
  missingActionParams,
  monthOf,
  monthsSince,
  newDecision,
  newJob,
  nextRunAfter,
  notebookFor,
  policyOf,
  reviewOutcome,
  ruleProblem,
  ruleProblems,
  rulesProblem,
  scheduleMinutesOf,
  schemaProblems,
  standaloneActions,
} from "./documents.js";

/* A rule that is valid as written, so each test can vary one thing at a time. */
function rule(over: Partial<AgentRule> = {}): AgentRule {
  return {
    v: 1,
    id: "r1",
    version: 1,
    enabled: true,
    trigger: { on: "email" },
    instruction: "Label the invoice so the group can find it.",
    capabilities: ["keyword.add"],
    ...over,
  };
}

/** A group's policy, with the cautious default every test varies from. */
function policy(
  over: Partial<AgentGroupPolicyDoc> = {},
): Pick<AgentGroupPolicyDoc, "review" | "allowExternal"> {
  return { review: "never", allowExternal: false, ...over };
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

test("an automation carries no review policy: that is the group's own document", () => {
  // Who a run stops for is a fact about the group, written once (ADR 0006), so
  // a field on the rule is not part of this shape and is not validated as one.
  assert.equal(isAgentRule({ ...rule(), review: { mode: "never" } }), true);
});

test("a group's policy is a document of its own, and its default is the confident reading", () => {
  assert.equal(
    isAgentGroupPolicyDoc({
      v: 1,
      review: "threshold",
      allowExternal: true,
      updatedAt: "2026-09-10T08:00:00Z",
      updatedBy: "admin@example.org",
    }),
    true,
  );
  // A mode this build does not know, or a missing flag, is not a policy.
  assert.equal(
    isAgentGroupPolicyDoc({ v: 1, review: "sometimes", allowExternal: false }),
    false,
  );
  assert.equal(isAgentGroupPolicyDoc({ v: 1, review: "never" }), false);
  // A group that has written none runs on the confident reading: an in-group
  // action the model is sure of goes ahead, an unsure one stops for a person,
  // and nothing has raised the external-send floor.
  assert.deepEqual(policyOf(null), { review: "threshold", allowExternal: false });
  assert.deepEqual(policyOf(policy({ review: "never", allowExternal: true })), {
    review: "never",
    allowExternal: true,
  });
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
  assert.equal(reviewOutcome(policy({ review: "never" }), [send], 1), "pause");
  assert.equal(
    reviewOutcome(policy({ review: "never", allowExternal: true }), [send], 1),
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
      "notebook.write",
    ],
    "the set names sending, posting, drafting, filing, the page work that writes a file, and the memory a run writes",
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

test("the review gate follows the group's policy and the confidence", () => {
  const label: AgentAction[] = [{ do: "keyword.add", with: { keyword: "todo" } }];
  assert.equal(reviewOutcome(policy({ review: "always" }), label, 1), "pause");
  assert.equal(reviewOutcome(policy({ review: "never" }), label, 0), "execute");
  /*
   * The threshold is one constant rather than a field: an author picking "run
   * it unattended when the model is confident" picks the behaviour, and the
   * number is what "confident" means (ADR 0006).
   */
  assert.equal(
    reviewOutcome(policy({ review: "threshold" }), label, AGENT_REVIEW_THRESHOLD),
    "execute",
    "at the threshold the run goes ahead",
  );
  assert.equal(
    reviewOutcome(policy({ review: "threshold" }), label, AGENT_REVIEW_THRESHOLD - 0.01),
    "pause",
  );
});

test("one enabled automation per trigger is refused as a list, not as a document", () => {
  /*
   * An automation carries no filter, so nothing in the document tells two of
   * them on one trigger apart, and the executor runs every enabled automation
   * on a trigger against every item that trigger produces: two of them answer
   * the same arrival twice (ADR 0006 decision one).
   */
  assert.equal(rulesProblem([]), null);
  assert.equal(rulesProblem([rule({ trigger: { on: "email" } })]), null);
  assert.equal(
    rulesProblem([
      rule({ id: "a", trigger: { on: "email" } }),
      rule({ id: "b", trigger: { on: "chat" } }),
      rule({ id: "c", trigger: { on: "schedule", everyMinutes: 60 } }),
      rule({ id: "d", trigger: { on: "filenode" } }),
    ]),
    null,
    "one per trigger is the whole of what a group may hold",
  );
  const doubled = rulesProblem([
    rule({ id: "a", trigger: { on: "email" } }),
    rule({ id: "b", trigger: { on: "email" } }),
  ]);
  assert.match(doubled ?? "", /email/);
  assert.match(doubled ?? "", /leave one enabled per trigger/);
  /*
   * A disabled automation wakes nothing, so it is a draft: it may sit beside
   * the enabled one while its author decides to replace it — the count is of
   * enabled automations, not of documents.
   */
  assert.equal(
    rulesProblem([
      rule({ id: "a", trigger: { on: "email" } }),
      rule({ id: "b", enabled: false, trigger: { on: "email" } }),
    ]),
    null,
  );
});

test("ruleProblem names what would stop a run", () => {
  assert.equal(ruleProblem(rule()), null);
  assert.match(ruleProblem(rule({ instruction: "   " })) ?? "", /needs an instruction/);
  assert.equal(
    ruleProblem(rule({ capabilities: [] })),
    "the rule needs at least one capability to allow: with none it could do nothing",
  );
});

test("a trigger is what wakes an automation, and there is nothing else to it", () => {
  // The four triggers are the whole vocabulary, and an automation carries no
  // filter: the discrimination between one case and another is its prose's job
  // (ADR 0006), which is what makes the shape three choices and a paragraph.
  assert.deepEqual([...AGENT_TRIGGERS], ["email", "filenode", "chat", "schedule"]);
  for (const on of AGENT_TRIGGERS) {
    // A trigger that is not the clock states nothing else; the clock states how
    // often, because a schedule without an interval has no next instant.
    const trigger = on === "schedule" ? { on, everyMinutes: 60 } : { on };
    assert.equal(isAgentRule(rule({ trigger })), true, `${on} is a trigger`);
  }
  assert.equal(
    isAgentRule(rule({ trigger: { on: "webhook" } as unknown as AgentTrigger })),
    false,
  );
  // A scheduled automation states its interval, because the clock needs one.
  assert.equal(isAgentRule(rule({ trigger: { on: "schedule" } })), false);
  assert.equal(
    isAgentRule(rule({ trigger: { on: "schedule", everyMinutes: 60 } })),
    true,
  );
});

test("a scheduled automation reads one cadence, from one place", () => {
  /*
   * A document that states no interval runs at the default rather than at zero
   * or at whatever a caller guessed: one reader, so the schedule planner, the
   * prompt's own sentence and every surface that shows the cadence agree
   * (ADR 0006).
   */
  assert.equal(
    scheduleMinutesOf({ trigger: { on: "schedule" } }),
    AGENT_SCHEDULE_MINUTES_DEFAULT,
  );
  assert.equal(scheduleMinutesOf({ trigger: { on: "schedule", everyMinutes: 15 } }), 15);
  // The presets the editor offers are intervals the planner accepts.
  for (const minutes of AGENT_SCHEDULE_PRESETS) {
    assert.equal(Number.isInteger(minutes) && minutes >= 5, true);
  }
});

test("an automation is named by its trigger, in one place", () => {
  for (const on of AGENT_TRIGGERS) {
    assert.equal(automationLabel({ trigger: { on } }), AGENT_AUTOMATION_LABELS[on]);
  }
  /*
   * A run outlives the rule it was pinned to — a job keeps a version a person
   * may have deleted since — and the trail is read a year later. The honest
   * name for that is that there is nothing left to name, not a stand-in.
   */
  assert.equal(automationLabel({ trigger: undefined }), GONE_AUTOMATION_LABEL);
});

test("an area grants a group of actions and never a flagged one", () => {
  /*
   * The areas are the authoring surface's whole vocabulary for a grant, and
   * they are computed from the catalogue rather than listed beside it: an
   * action belongs to whichever area it names, and one that leaves the group
   * or cannot be undone is excluded from every area by the flags it carries.
   */
  const mail = areaActions("mail");
  assert.deepEqual(mail.sort(), [
    "keyword.add",
    "keyword.remove",
    "mail.draft",
    "mail.extract",
    "mail.move",
  ]);
  assert.equal(
    mail.includes("mail.send"),
    false,
    "sending is excluded from the area it belongs to, so ticking Mail can never grant it",
  );
  assert.deepEqual(areaActions("chat"), ["chat.post"]);
  assert.deepEqual(areaActions("files").sort(), [
    "document.extract",
    "document.merge",
    "document.read",
    "document.split",
    "file.write",
    "notebook.write",
  ]);
  /*
   * The exclusion is a rule about the catalogue, not a list of today's names:
   * pointed at a catalogue with a new flagged action, the same function leaves
   * it out.
   */
  const grown = [
    ...AGENT_ACTION_SPECS,
    {
      name: "mail.forward" as const,
      area: "mail" as const,
      label: "Forward",
      description: "",
      params: [],
      external: true,
    },
    {
      name: "file.delete" as const,
      area: "files" as const,
      label: "Delete a file",
      description: "",
      params: [],
      irreversible: true,
    },
  ];
  assert.equal(areaActions("mail", grown).includes("mail.forward"), false);
  assert.equal(areaActions("files", grown).includes("file.delete"), false);
  /*
   * Every action is accounted for: it is in exactly one area, or it is one of
   * the entries that stand beside them. Nothing falls between.
   */
  const granted = new Set(AGENT_AREAS.flatMap((area) => areaActions(area)));
  const standalone = standaloneActions();
  assert.deepEqual(standalone.sort(), ["mail.send", "noop"]);
  assert.equal(granted.size + standalone.length, AGENT_ACTION_SPECS.length);
});

test('"do nothing" is granted to every run and is not a permission', () => {
  // A run may only answer with an action its rule allows, and declining is not
  // a behaviour: the grant the executor checks is the rule's own plus this.
  assert.deepEqual(effectiveCapabilities({ capabilities: ["keyword.add"] }).sort(), [
    "keyword.add",
    "noop",
  ]);
  // An explicit `noop` is not written twice.
  assert.deepEqual(effectiveCapabilities({ capabilities: ["noop"] }), ["noop"]);
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
    "x-areas": Array<{ area: string; label: string; actions: string[] }>;
  };
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(schema.required.includes("instruction"));
  assert.ok(schema.required.includes("capabilities"));
  assert.deepEqual(schema.properties.trigger?.properties?.on?.enum, [...AGENT_TRIGGERS]);
  /*
   * The policy is not a field of a rule any more, and the schema says so by not
   * having one: who a run stops for is the group's own document (ADR 0006).
   */
  assert.equal(schema.properties.review, undefined);
  assert.equal(schema.required.includes("review"), false);
  const names = AGENT_ACTION_SPECS.map((spec) => spec.name);
  assert.deepEqual(
    schema.properties.capabilities?.items?.enum,
    names,
    "a rule may name exactly the catalogue's actions",
  );
  assert.deepEqual(
    schema["x-actions"].map((action) => action.name),
    names,
  );
  /*
   * The areas the editor paints are the schema's, computed from the same
   * catalogue the executor checks against — so an area cannot offer a grant the
   * executor does not have, and the editor needs no list of its own.
   */
  assert.deepEqual(
    schema["x-areas"].map((entry) => entry.area),
    [...AGENT_AREAS],
  );
  for (const entry of schema["x-areas"]) {
    assert.deepEqual(
      entry.actions,
      areaActions(entry.area as (typeof AGENT_AREAS)[number]),
    );
  }
  // The one cross-field half the schema can state: a schedule needs its
  // interval.
  assert.ok(Array.isArray(schema.properties.trigger?.allOf));
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

test("a value JSON cannot carry is refused as a document, never thrown", () => {
  /*
   * The editor validates the draft while it draws it, so a validator that threw
   * here unmounted the whole panel — the blank page a trigger change once
   * produced. A document is JSON: a property holding `undefined` is a property
   * JSON does not have, and the honest answer is the one problem it is.
   */
  const withUndefined = rule({
    trigger: { on: "chat", everyMinutes: undefined },
  });
  let problems: string[] = [];
  assert.doesNotThrow(() => {
    problems = schemaProblems(withUndefined);
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /not JSON/);
  // And the same door answers rather than throws, which is what a surface asks.
  assert.doesNotThrow(() => ruleProblems(withUndefined));
});

test("a group that carries two automations on one trigger is refused, not run twice", () => {
  /*
   * The refusal a save meets. It is a property of the list rather than of a
   * document — the shape of one automation is fine — so it is read here, the
   * same place the admin API reads it before writing, and it names the trigger
   * a person has to leave alone.
   */
  const doubled = [
    rule({ id: "a", trigger: { on: "filenode" } }),
    rule({ id: "b", trigger: { on: "filenode" } }),
  ];
  for (const single of doubled) assert.deepEqual(ruleProblems(single), []);
  assert.match(rulesProblem(doubled) ?? "", /filenode/);
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

test("a decision reads as the summary the run decided on, and nothing else", () => {
  // What a member answers is the output: the decision carries the summary and
  // the actions, and the deciding call is asked for nothing else (ADR 0003).
  const job: AgentJob = {
    ...newJob({
      id: "j1",
      accountId: "a1",
      rule: { id: "r1", version: 1 },
      trigger: { on: "chat", chatId: "c1", at: "2026-09-10T09:00:00Z" },
    }),
    proposal: {
      summary: "It would greet the group.",
      actions: [{ do: "chat.post", with: { text: "Hello all!" } }],
      confidence: 0.9,
    },
  };
  const decision = newDecision(job, "c1");
  assert.equal(decision.summary, "It would greet the group.");
  assert.deepEqual(decision.actions, [{ do: "chat.post", with: { text: "Hello all!" } }]);
});

test("an action's parameters read the same wherever it is shown", () => {
  // The approval prompt and the member's panel render one action through one
  // function, so "what would it do" cannot be one list to the approver and
  // another to the person who reads the run afterwards.
  assert.equal(
    actionParamsText({ with: { text: "Hello all!", folder: "Clients" } }),
    "text: Hello all!, folder: Clients",
  );
  assert.equal(actionParamsText({}), "");
});

test("a lookup is one of the group's own reads, and nothing else", () => {
  /*
   * ADR 0020: the model names a kind from a closed catalogue and the server
   * validates it. The catalogue is the group's whole state — its mail, its
   * folders, its labels, its Files and its chat — so a butler is not limited to
   * one label, and it never writes a query.
   */
  assert.deepEqual([...AGENT_LOOKUP_KINDS].sort(), [
    "chat",
    "file",
    "files",
    "labels",
    "mail",
    "mailboxes",
    "message",
  ]);
  assert.equal(isAgentLookup({ kind: "mail", query: "is:starred", limit: 5 }), true);
  assert.equal(
    isAgentLookup({ kind: "mail" }),
    true,
    "no query is the newest mail, which is what a butler asked for nothing means",
  );
  assert.equal(isAgentLookup({ kind: "mail", query: "" }), false);
  assert.equal(
    isAgentLookup({ kind: "mail", query: "x".repeat(AGENT_LOOKUP_QUERY_MAX + 1) }),
    false,
  );
  assert.equal(
    isAgentLookup({ kind: "mail", limit: AGENT_LOOKUP_MESSAGES_MAX + 1 }),
    false,
    "a listing past the ceiling is refused rather than clamped silently",
  );
  assert.equal(isAgentLookup({ kind: "mail", limit: 0 }), false);
  assert.equal(isAgentLookup({ kind: "message", id: "M1" }), true);
  assert.equal(isAgentLookup({ kind: "message", id: "" }), false);
  assert.equal(isAgentLookup({ kind: "file", path: "Clients/report.pdf" }), true);
  assert.equal(isAgentLookup({ kind: "file", path: "" }), false);
  assert.equal(isAgentLookup({ kind: "files", folder: "Clients" }), true);
  assert.equal(isAgentLookup({ kind: "files", name: "packing" }), true);
  assert.equal(
    isAgentLookup({ kind: "files", deep: true }),
    true,
    "a whole-tree listing is the same lookup with deep set",
  );
  assert.equal(isAgentLookup({ kind: "files", deep: "yes" }), false);
  assert.equal(isAgentLookup({ kind: "mailboxes" }), true);
  assert.equal(isAgentLookup({ kind: "labels" }), true);
  assert.equal(isAgentLookup({ kind: "chat", query: "invoice" }), true);
  assert.equal(isAgentLookup({ kind: "chat", text: "invoice" }), false);
  assert.equal(isAgentLookup({ kind: "everything" }), false);
  assert.equal(isAgentLookup("mail"), false);
  // One renderer, so the trail and the prompt name a read the same way.
  assert.equal(
    lookupLabel({ kind: "mail", query: "is:starred from:ada" }),
    "the mail matching “is:starred from:ada”",
  );
  assert.equal(lookupLabel({ kind: "mail" }), "the group's mail");
  assert.equal(
    lookupLabel({ kind: "files", deep: true, name: "packing" }),
    "the group's Files, the whole tree, matching “packing”",
  );
});
