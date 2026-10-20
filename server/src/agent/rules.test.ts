/**
 * The rule store against the mock Stalwart (ADR 0035).
 *
 * A rule is one document under `rules/` in the group's own account, and these
 * tests are the facts the design rests on: it is addressed by its own name and
 * nothing else, a member's read sees it from a process that never wrote it, a
 * create does not write over a rule a group already wrote, and a replace lands
 * only under the state its read saw. A rule that is there but unreadable is
 * reported, never guessed at.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Ctx, filesAccountId, readAppFileAt, writeAppFileAt } from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";
import type { RuleDoc } from "./rule.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-rules";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { isStateMismatch } = await import("../jmap.js");
const { RULE_VERSION } = await import("./rule.js");
const { createRule, listRules, readRule, replaceRule, RULES_DIR, RuleError, rulePath } =
  await import("./rules.js");

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;

let ctx: Ctx;
let accountId: string;

before(async () => {
  await waitForPort(BASE, AUTH);
  const session = await fetchUpstreamSession(AUTH, BASE);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  accountId = filesAccountId(ctx);
  assert.ok(accountId, "the demo account owns Files");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** A `Ctx` of its own, standing in for a process that has just started. */
async function restarted(): Promise<Ctx> {
  return {
    authorization: AUTH,
    session: await fetchUpstreamSession(AUTH, BASE),
    username: "demo@example.com",
  };
}

function ruleOf(id: string, parts: Partial<RuleDoc> = {}): RuleDoc {
  return {
    v: RULE_VERSION,
    id,
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
  };
}

test("a rule is one document under rules/, and a process that never wrote it reads it", async () => {
  const rule = ruleOf("shipper-answer");
  await createRule(ctx, accountId, rule);

  // Addressed the way an app-folder document is: `rules/<id>.json` in the
  // group's own `gilbert` app folder, and nowhere else.
  const stored = await readAppFileAt(ctx, accountId, "rules/shipper-answer.json");
  assert.ok(stored, "the document is where the store says it is");
  assert.equal(JSON.parse(stored.text).instruction, rule.instruction);

  const record = await readRule(await restarted(), accountId, "shipper-answer");
  assert.ok(record, "a rule is there for a process that never wrote it");
  assert.equal(record.rule.id, "shipper-answer");
  assert.equal(record.rule.sends, false, "and it carries the prose and the send");
  assert.ok(record.state, "with the token a replace of it needs");

  const listed = await listRules(ctx, accountId);
  assert.deepEqual(
    listed.map((one) => one.rule.id),
    ["shipper-answer"],
    "and the group's listing is its own rules",
  );
});

test("a rule is created once and replaced under the state it was read at", async () => {
  const rule = ruleOf("cas-rule");
  await createRule(ctx, accountId, rule);
  await assert.rejects(
    () => createRule(ctx, accountId, rule),
    (err: unknown) => err instanceof RuleError && err.code === "rule_exists",
    "a rule's id names one rule, and a create does not write over it",
  );

  const record = await readRule(ctx, accountId, "cas-rule");
  assert.ok(record, "the rule reads back");
  const changed: RuleDoc = { ...record.rule, instruction: "Answer the same day." };
  await replaceRule(ctx, accountId, changed, { ifInState: record.state });
  assert.equal(
    (await readRule(ctx, accountId, "cas-rule"))?.rule.instruction,
    "Answer the same day.",
  );

  // The token the first read carried is stale now: a copy that read the rule
  // before this write is refused rather than overwriting it.
  await assert.rejects(
    () => replaceRule(ctx, accountId, rule, { ifInState: record.state }),
    (err: unknown) => isStateMismatch(err),
    "a stale token does not land",
  );
  assert.equal(
    (await readRule(ctx, accountId, "cas-rule"))?.rule.instruction,
    "Answer the same day.",
    "and the rule it would have overwritten is untouched",
  );
});

test("a rule is named by one file name, and a path is refused", () => {
  assert.equal(rulePath("shipper-answer"), `${RULES_DIR}/shipper-answer.json`);
  for (const bad of ["", ".", "..", "a/b", "../escape", "with space"])
    assert.throws(
      () => rulePath(bad),
      (err: unknown) => err instanceof RuleError && err.code === "rule_id_invalid",
      `"${bad}" is not a rule name`,
    );
});

test("an unreadable rule is reported, never guessed at", async () => {
  // A document of the right JSON that is not the shape this build writes.
  await writeAppFileAt(ctx, accountId, "rules/other.json", {
    v: RULE_VERSION,
    id: "other",
  });
  await assert.rejects(
    () => readRule(ctx, accountId, "other"),
    /"surfaces" must give every surface a mode/,
    "a rule whose shape is wrong is refused with the reason",
  );
  await assert.rejects(() => listRules(ctx, accountId), /The rule at rules\/other\.json/);

  // A document whose bytes do not parse at all.
  await writeAppFileAt(ctx, accountId, "rules/doc.json", {
    v: RULE_VERSION,
    id: "somebody-elses-name",
    surfaces: {
      chat: "watch",
      mail: "watch",
      files: "ondemand",
      knowledge: "ondemand",
      workorder: "ondemand",
      calendar: "ondemand",
    },
    instruction: "x",
    sends: false,
  });
  await assert.rejects(
    () => readRule(ctx, accountId, "doc"),
    /it names the rule "somebody-elses-name"/,
    "a rule filed under a name it does not carry is refused",
  );

  // A rule that is not there is absent, and that is not the same answer.
  assert.equal(await readRule(ctx, accountId, "no-such-rule"), null);
});
