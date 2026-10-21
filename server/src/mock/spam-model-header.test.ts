import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, jmapCall, responseOf } from "../testkit.js";

/**
 * What the spam filter's own model said, as the mock records it.
 *
 * The client reads `X-Spam-LLM` and shows it beside the filter's score
 * (`web/src/lib/spamScore.ts`): the spam filter's model, never the agent's, as
 * the agent vocabulary keeps the two apart. What a live Stalwart writes here is
 * an assumption this mock makes, so it is pinned next to the simulation: the two
 * shapes the client understands — a category with an explanation, and the
 * filter's own `LLM_<category>_<confidence>` tag — are both here, and mail this
 * account wrote carries neither.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const MAIL = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

type Message = {
  id: string;
  mailboxIds?: Record<string, boolean> | null;
  "header:X-Spam-LLM:asText"?: string | null;
  "header:X-Spam-Status:asText"?: string | null;
};

async function messages(): Promise<Message[]> {
  const responses = await jmapCall(BASE, AUTH, MAIL, [
    [
      "Email/get",
      {
        accountId: ACCOUNT,
        ids: null,
        properties: [
          "id",
          "mailboxIds",
          "header:X-Spam-LLM:asText",
          "header:X-Spam-Status:asText",
        ],
      },
      "g",
    ],
  ]);
  return responseOf(responses, "g")[1].list as Message[];
}

test("junk carries the model's category and its explanation", async () => {
  const junk = (await messages()).filter((m) => m.mailboxIds?.junk);
  assert.ok(junk.length, "the demo account should hold junk");
  for (const message of junk) {
    assert.match(
      String(message["header:X-Spam-LLM:asText"]),
      /^\p{L}+ \(.+\)$/u,
      "the header is the category, then the model's explanation in parentheses",
    );
  }
});

test("a verdict the filter liked carries its confidence as the filter's own tag", async () => {
  const inbox = (await messages()).filter(
    (m) => m.mailboxIds?.inbox && !m.mailboxIds?.sent,
  );
  const tagged = inbox.find((m) => /^LLM_/.test(String(m["header:X-Spam-LLM:asText"])));
  assert.ok(
    tagged,
    "one delivered message should carry the LLM_<category>_<confidence> form",
  );
  assert.match(
    String(tagged["header:X-Spam-LLM:asText"]),
    /^LLM_[\p{L}\p{N}_]+_(LOW|MEDIUM|HIGH) \(.+\)$/u,
  );
});

test("mail this account wrote carries no model verdict", async () => {
  const written = (await messages()).filter((m) => m.mailboxIds?.sent);
  assert.ok(written.length, "the demo account should hold mail it wrote");
  for (const message of written) {
    assert.equal(message["header:X-Spam-LLM:asText"], null);
    assert.equal(message["header:X-Spam-Status:asText"], null);
  }
});
