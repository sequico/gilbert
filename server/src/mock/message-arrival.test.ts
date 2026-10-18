import assert from "node:assert/strict";
import { after, test } from "node:test";
import { personWord, type ReceivedMessage } from "../agent/trust.js";
import { freePort, jmapCall, responseOf } from "../testkit.js";

/**
 * What the mock records about how a message arrived, and the one reading of it
 * (ADR 0033).
 *
 * The agent's mail channel rests on the receiving server's own account of the
 * arrival, and that account has two shapes: its authentication result on a
 * message another server handed over, and its record of the submission for a
 * message one of this installation's own accounts wrote — which never crossed a
 * boundary and so has nothing to verify. What a live Stalwart 0.16 writes is owed
 * a probe, unverified from inside this repository, so what the mock reproduces is
 * an **assumption**; an assumption nobody pins is a mock that agrees with the
 * code by accident. This reads messages back through the mock and hands them to
 * the reading that consumes them (`server/src/agent/trust.ts`), so a change to
 * either side fails here rather than on a live server.
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

/** The agent acts as an account of its own, never as the one that wrote these. */
const OWN = "agent@example.com";

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** What one message of the demo account carries, with the folder it sits in. */
type Message = ReceivedMessage & {
  mailboxIds?: Record<string, boolean> | null;
  /** The verdict the mock writes; the reading no longer takes one from outside. */
  "header:Authentication-Results:asText"?: string | null;
};

/** Every message of the demo account, with the properties this reading reads. */
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
          "from",
          "header:Received:asText:all",
          "header:Authentication-Results:asText",
        ],
      },
      "g",
    ],
  ]);
  return responseOf(responses, "g")[1].list as Message[];
}

/** The hop the receiving server wrote, which the message carries first. */
const hopOf = (message: Message): string =>
  message["header:Received:asText:all"]?.[0] ?? "";

/** Whether the reading takes this message as the sender's own word. */
const asWord = (message: Message): boolean => {
  const sender = message.from?.[0]?.email ?? "";
  return personWord(message, { own: OWN, known: [sender] }).word;
};

test("mail from outside carries the verdict, and the reading refuses it until the probe", async () => {
  const received = (await messages()).find(
    (message) => typeof message["header:Authentication-Results:asText"] === "string",
  );
  assert.ok(received, "a message the mock received should carry the server's verdict");
  assert.match(
    hopOf(received),
    /^\s*from\s+\S/,
    "the server's own hop names the host it was handed over by",
  );
  assert.match(
    String(received["header:Authentication-Results:asText"]),
    /^\S+;/,
    "the authserv-id names the server that wrote the verdict before anything else",
  );
  assert.equal(
    asWord(received),
    false,
    "no verdict is a person's word until a live server's own authserv-id is recorded",
  );
});

test("mail an account here submitted carries the submission record and no verdict", async () => {
  const written = (await messages()).filter((message) => message.mailboxIds?.sent);
  assert.ok(written.length, "the demo account should hold mail it wrote");
  for (const message of written) {
    assert.equal(
      message["header:Authentication-Results:asText"],
      null,
      "nothing was verified for mail that never crossed a boundary",
    );
    assert.match(
      hopOf(message),
      /\bESMTPSA\b/,
      "the server's own hop records a submission over an authenticated connection",
    );
    assert.match(
      hopOf(message),
      /\bAuthenticated sender: \S+@\S+/,
      "and names the account it authenticated, which is the address the reading compares",
    );
    assert.equal(
      asWord(message),
      true,
      "the submission is the sender's word on the server's own record of it",
    );
  }
});
