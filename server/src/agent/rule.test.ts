/**
 * The rule document's shape, and what it watches (ADR 0035).
 *
 * A rule says two things — the surfaces of the group's account it watches, and
 * in prose what should happen — and whether it declares that it sends. This is
 * the pure half: the parser refuses a document that is not the shape this build
 * writes, ignores keys it does not know, and the matcher wakes a rule on a
 * surface it named and on nothing else.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountEvent } from "./accountEvent.js";
import {
  parseRuleDocumentDetailed,
  RULE_SURFACES,
  RULE_VERSION,
  type RuleDoc,
  ruleApplies,
} from "./rule.js";

/** A rule this build writes, as JSON. */
function rulesJson(parts: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: RULE_VERSION,
    id: "shipper-answer",
    watches: ["mail", "chat"],
    instruction: "A shipper's message is answered within the day.",
    sends: false,
    ...parts,
  });
}

test("a rule this build writes parses back to itself", () => {
  const parsed = parseRuleDocumentDetailed(rulesJson());
  assert.ok("rule" in parsed, "a whole document parses");
  assert.deepEqual(parsed.rule, {
    v: RULE_VERSION,
    id: "shipper-answer",
    watches: ["mail", "chat"],
    instruction: "A shipper's message is answered within the day.",
    sends: false,
  });
});

test("a key this build does not know is ignored, not refused", () => {
  const parsed = parseRuleDocumentDetailed(
    rulesJson({ capabilities: ["mail.send"], budget: { steps: 4 } }),
  );
  assert.ok("rule" in parsed, "an unknown key decides nothing and does not refuse");
  assert.equal(
    "capabilities" in parsed.rule,
    false,
    "and it is dropped on the next write: a rule carries no list of permitted actions (ADR 0035)",
  );
});

test("a rule watches the five surfaces the record names, and no other", () => {
  assert.deepEqual(
    [...RULE_SURFACES].sort(),
    ["chat", "files", "knowledge", "mail", "workorder"],
    "the vocabulary is the record's five surfaces",
  );
  for (const surface of RULE_SURFACES) {
    const parsed = parseRuleDocumentDetailed(rulesJson({ watches: [surface] }));
    assert.ok("rule" in parsed, `"${surface}" is a surface a rule can watch`);
  }
});

test("a document that is not the shape this build writes is refused with the reason", () => {
  const cases: Array<[string, string]> = [
    ["not json at all", "Not valid JSON"],
    [JSON.stringify([1, 2]), "must be a JSON object"],
    [rulesJson({ v: 99 }), "this build reads version"],
    [rulesJson({ id: "" }), '"id" must be the rule\'s name'],
    [rulesJson({ watches: [] }), '"watches" must be a non-empty list'],
    [rulesJson({ watches: ["inbox"] }), '"watches" must be a non-empty list'],
    [rulesJson({ instruction: "   " }), '"instruction" must say what should happen'],
    [rulesJson({ sends: "yes" }), '"sends" must be true or false'],
  ];
  for (const [bad, expected] of cases) {
    const parsed = parseRuleDocumentDetailed(bad);
    assert.ok("problem" in parsed, `should refuse: ${bad.slice(0, 60)}`);
    assert.ok(
      parsed.problem.includes(expected),
      `should say: ${expected} — got: ${parsed.problem}`,
    );
  }
});

test("a rule is woken by a surface it names and by nothing else", () => {
  const rule: RuleDoc = {
    v: RULE_VERSION,
    id: "shipper-answer",
    watches: ["mail", "chat"],
    instruction: "Answer within the day.",
    sends: false,
  };
  const event = (source: AccountEvent["source"]): AccountEvent => ({
    source,
    change: "created",
    where: "x",
  });
  assert.equal(ruleApplies(rule, event("mail")), true);
  assert.equal(ruleApplies(rule, event("chat")), true);
  assert.equal(ruleApplies(rule, event("files")), false);
  assert.equal(ruleApplies(rule, event("knowledge")), false);
  assert.equal(ruleApplies(rule, event("workorder")), false);
});
