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
  AGENT_TIERS,
  AGENT_TRIGGERS,
  type AgentAction,
  type AgentEmailView,
  type AgentRule,
  agentRuleJsonSchema,
  CHAT_CONTEXT_DEFAULT,
  CHAT_CONTEXT_MAX,
  clampChatContext,
  consentRequired,
  irreversible,
  isAgentAction,
  isAgentJob,
  isAgentRule,
  isAgentRulesDoc,
  matchEmailFilter,
  missingActionParams,
  newJob,
  nextRunAfter,
  reviewOutcome,
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
    area: "mail",
    trigger: { on: "email", filter: { subject: "invoice" } },
    tier: "T0",
    review: { mode: "never" },
    actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
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

test("an area is one of the five the fleet divides its work into", () => {
  assert.equal(AGENT_AREAS.length, 5);
  assert.ok(AGENT_AREAS.includes("mail"));
});

test("a rule needs the material its tier runs on", () => {
  assert.equal(isAgentRule(rule()), true);
  // T0 without actions, T1 without categories, T2 without an instruction would
  // each match and then do nothing at all, which is the failure this refuses.
  const { actions: _a, ...noActions } = rule();
  assert.equal(isAgentRule(noActions), false);
  assert.equal(isAgentRule(rule({ tier: "T1" })), false);
  assert.equal(isAgentRule(rule({ tier: "T2", capabilities: ["noop"] })), false);
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
  assert.match(
    ruleProblem(rule({ capabilities: [] })) ?? "",
    /does not list it in its capabilities/,
  );
  assert.match(
    ruleProblem(
      rule({ actions: [{ do: "mail.move", with: {} }], capabilities: ["mail.move"] }),
    ) ?? "",
    /missing mailbox/,
  );
  assert.equal(
    ruleProblem(rule({ tier: "T2", instruction: "sort it", capabilities: [] })),
    "a T2 rule needs at least one capability to allow",
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
    area: "mail",
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
    tier: "T0",
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
  // the test that fails if somebody adds an area, a tier, a trigger or an
  // action to one and not the other (ADR 0003 resolution 2).
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
  assert.deepEqual(schema.properties.area?.enum, [...AGENT_AREAS]);
  assert.deepEqual(schema.properties.tier?.enum, [...AGENT_TIERS]);
  assert.deepEqual(schema.properties.trigger?.properties?.on?.enum, [...AGENT_TRIGGERS]);
  assert.deepEqual(schema.properties.review?.properties?.mode?.enum, [
    "always",
    "threshold",
    "never",
  ]);
  const names = AGENT_ACTION_SPECS.map((spec) => spec.name);
  assert.deepEqual(
    schema.properties.actions?.items?.properties?.do?.enum,
    names,
    "a rule may name exactly the catalogue's actions",
  );
  assert.deepEqual(schema.properties.capabilities?.items?.enum, names);
  assert.deepEqual(schema["x-filterKeys"], [...SUPPORTED_FILTER_KEYS]);
  assert.deepEqual(
    schema["x-actions"].map((action) => action.name),
    names,
  );
  assert.ok(schema.required.includes("tier"));
  assert.ok(schema.required.includes("review"));
  // The cross-field halves the schema can state: a schedule needs its
  // interval, a threshold needs its number.
  assert.ok(Array.isArray(schema.properties.trigger?.allOf));
  assert.ok(Array.isArray(schema.properties.review?.allOf));
});

test("the published schema is what a save is refused against", () => {
  // One validator, from the one document: the editor in the browser and the
  // save path on the server run the same check.
  assert.deepEqual(schemaProblems(rule()), []);
  assert.deepEqual(ruleProblems(rule()), []);

  const badArea = schemaProblems(rule({ area: "gardening" as never }));
  assert.ok(badArea.length >= 1, "an area outside the enum is refused");
  assert.match(badArea.join(" "), /Property "area"/, "and says which property");

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

test("the material each tier runs on is checked for being there, not just typed", () => {
  // `""` is a string, so the schema is satisfied and the model is asked
  // nothing; the emptiness is a rule the document cannot state.
  assert.ok(
    ruleProblems(rule({ tier: "T2", instruction: "" })).some((problem) =>
      /instruction/.test(problem),
    ),
  );
  assert.ok(
    ruleProblems(rule({ tier: "T0", actions: [] })).some((problem) =>
      /nothing/.test(problem),
    ),
  );
});
