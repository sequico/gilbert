/**
 * The rule document's shape, and its surface matrix (ADR 0035).
 *
 * A rule says what wakes it and what it may touch — one mode per surface — in
 * prose what should happen, and whether it declares that it sends. This is the
 * pure half: the parser refuses a document that is not the shape this build
 * writes, reads a v1 rule as the matrix it means, ignores keys it does not know,
 * and the matcher wakes a rule on a `watch` surface and on nothing else.
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
  type RuleSurfaces,
} from "./rule.js";

/** A v2 rule this build writes, as JSON. */
function rulesJson(parts: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: RULE_VERSION,
    id: "shipper-answer",
    surfaces: {
      chat: "watch",
      mail: "watch",
      files: "ondemand",
      knowledge: "ondemand",
      workorder: "ondemand",
      calendar: "ondemand",
    },
    instruction: "A shipper's message is answered within the day.",
    sends: false,
    ...parts,
  });
}

/** A v1 rule, for the migration. */
function oldRulesJson(parts: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    id: "shipper-answer",
    watches: ["mail", "chat"],
    instruction: "A shipper's message is answered within the day.",
    sends: false,
    ...parts,
  });
}

const matrix = (parts: Partial<RuleSurfaces> = {}): RuleSurfaces => ({
  chat: "watch",
  mail: "watch",
  files: "ondemand",
  knowledge: "ondemand",
  workorder: "ondemand",
  calendar: "ondemand",
  ...parts,
});

test("a rule this build writes parses back to itself", () => {
  const parsed = parseRuleDocumentDetailed(rulesJson());
  assert.ok("rule" in parsed, "a whole document parses");
  assert.deepEqual(parsed.rule, {
    v: RULE_VERSION,
    id: "shipper-answer",
    surfaces: matrix(),
    instruction: "A shipper's message is answered within the day.",
    sends: false,
  });
});

test("a v1 rule becomes the matrix it means, and nothing is turned off", () => {
  const parsed = parseRuleDocumentDetailed(oldRulesJson());
  assert.ok("rule" in parsed, "a v1 document is read, not refused");
  assert.equal(parsed.rule.v, RULE_VERSION, "and it is written as v2 next time");
  assert.deepEqual(
    parsed.rule.surfaces,
    matrix(),
    "mail and chat watch; every other surface is on demand, as the v1 guard allowed",
  );

  const mailOnly = parseRuleDocumentDetailed(oldRulesJson({ watches: ["mail"] }));
  assert.ok("rule" in mailOnly);
  assert.equal(
    mailOnly.rule.surfaces.chat,
    "watch",
    "chat is watch even for a v1 rule that did not watch it: every rule now has it",
  );
  assert.equal(mailOnly.rule.surfaces.files, "ondemand", "and no write is narrowed");
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

  const extraSurface = parseRuleDocumentDetailed(
    rulesJson({ surfaces: { ...matrix(), labels: "watch" } }),
  );
  assert.ok("rule" in extraSurface, "a surface a later build added does not refuse it");
  assert.equal(
    "labels" in extraSurface.rule.surfaces,
    false,
    "and the matrix written back names only the six surfaces this build knows",
  );
});

test("a rule's matrix names six surfaces, chat always watched", () => {
  assert.deepEqual(
    [...RULE_SURFACES],
    ["chat", "mail", "files", "knowledge", "workorder", "calendar"],
    "the matrix's surfaces, in the editor's order",
  );
  for (const surface of RULE_SURFACES) {
    const parsed = parseRuleDocumentDetailed(
      rulesJson({
        surfaces: matrix({
          [surface as keyof RuleSurfaces]: surface === "chat" ? "watch" : "watch",
        }),
      }),
    );
    assert.ok("rule" in parsed, `"${surface}" is a surface a rule can name`);
  }
});

test("a document that is not the shape this build writes is refused with the reason", () => {
  const cases: Array<[string, string]> = [
    ["not json at all", "Not valid JSON"],
    [JSON.stringify([1, 2]), "must be a JSON object"],
    [rulesJson({ v: 99 }), "this build reads versions 1 and"],
    [rulesJson({ id: "" }), '"id" must be the rule\'s name'],
    [rulesJson({ surfaces: { ...matrix(), chat: "off" } }), 'keep chat at "watch"'],
    [
      rulesJson({ surfaces: { ...matrix(), files: "sometimes" } }),
      "every surface a mode",
    ],
    [rulesJson({ surfaces: { chat: "watch", mail: "watch" } }), "every surface a mode"],
    [rulesJson({ instruction: "   " }), '"instruction" must say what should happen'],
    [rulesJson({ sends: "yes" }), '"sends" must be true or false'],
    [oldRulesJson({ watches: [] }), '"watches" must be a non-empty list'],
    [oldRulesJson({ watches: ["inbox"] }), '"watches" must be a non-empty list'],
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

test("a rule is woken by a watch surface and by nothing else", () => {
  const rule: RuleDoc = {
    v: RULE_VERSION,
    id: "shipper-answer",
    surfaces: matrix({ files: "watch", mail: "ondemand" }),
    instruction: "Answer within the day.",
    sends: false,
  };
  const event = (source: AccountEvent["source"]): AccountEvent => ({
    source,
    change: "created",
    where: "x",
  });
  assert.equal(ruleApplies(rule, event("files")), true, "a watch surface wakes it");
  assert.equal(
    ruleApplies(rule, event("mail")),
    false,
    "an on-demand surface never wakes it",
  );
  assert.equal(ruleApplies(rule, event("chat")), true);
  assert.equal(ruleApplies(rule, event("knowledge")), false);
  assert.equal(ruleApplies(rule, event("workorder")), false);
});
