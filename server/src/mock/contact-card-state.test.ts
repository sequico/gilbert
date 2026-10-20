import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, jmapCall, responseOf } from "../testkit.js";

/**
 * Reading a ContactCard state with an empty id list.
 *
 * `globalContactsAdmin.ts` reads the account's `ContactCard`
 * compare-and-set token with `ContactCard/get { ids: [] }` — a get that names no
 * card, so it carries no list but still the account's `state`. Whether a real
 * 0.16 server answers a `state` for an empty id list, rather than refusing the
 * call, is an assumption the product rests on and the live probe it owes is
 * written down at the read. The mock answering it is pinned here, next to the
 * simulation, so a mock that stopped answering it fails here instead of letting
 * the directory's guarded writes look correct again.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

const jmap = (methodCalls: unknown[]) => jmapCall(BASE, AUTH, USING, methodCalls);

/** The state an empty-id get answers — the token `globalContactsAdmin` reads. */
async function contactCardState(): Promise<string> {
  const answer = responseOf(
    await jmap([["ContactCard/get", { accountId: ACCOUNT, ids: [] }, "g"]]),
    "g",
  )[1] as { state?: unknown; list?: unknown };
  assert.ok(Array.isArray(answer.list), "an empty-id get still answers a list");
  assert.equal((answer.list as unknown[]).length, 0, "naming no id answers no card");
  assert.equal(typeof answer.state, "string", "an empty-id get answers the state");
  const state = answer.state as string;
  assert.ok(state.length > 0, "the state is a real token, not an empty string");
  return state;
}

test("ContactCard/get with an empty id list answers the account's state", async () => {
  assert.ok(await contactCardState());
});

test("the state an empty-id get answers is the ContactCard compare-and-set token", async () => {
  const book = responseOf(
    await jmap([
      [
        "AddressBook/set",
        { accountId: ACCOUNT, create: { b: { name: "State probe" } } },
        "b",
      ],
    ]),
    "b",
  )[1];
  const bookId = (book.created as Record<string, { id: string }>).b!.id;

  const before = await contactCardState();
  const created = responseOf(
    await jmap([
      [
        "ContactCard/set",
        {
          accountId: ACCOUNT,
          ifInState: before,
          create: {
            c: {
              "@type": "Card",
              version: "1.0",
              uid: "uid-state-probe",
              kind: "individual",
              name: { full: "Ada Lovelace" },
              addressBookIds: { [bookId]: true },
            },
          },
        },
        "c",
      ],
    ]),
    "c",
  )[1];
  assert.ok(
    (created.created as Record<string, { id: string }>).c?.id,
    "the state read by an empty-id get is accepted as ifInState",
  );
  const after = await contactCardState();
  assert.notEqual(after, before, "writing a card moves the state");

  const stale = responseOf(
    await jmap([
      ["ContactCard/set", { accountId: ACCOUNT, ifInState: before, create: {} }, "s"],
    ]),
    "s",
  );
  assert.equal(stale[0], "error", "the pre-write state is now stale");
  assert.equal((stale[1] as { type: string }).type, "stateMismatch");
});

/**
 * An Email created from `bodyValues` reads back with a body and a preview.
 *
 * The mock walked `bodyStructure` collecting only the parts that had a
 * `bodyValues` entry, so every part of a body named by `blobId` was dropped from
 * `textBody`/`htmlBody` — a body with no parts being a message the view renders
 * empty. And the preview was read from a part id literally called `text`, which
 * no real `bodyStructure` carries, so it was always empty: the sent-mail view
 * rendered plain text with no preview in dev and the composed HTML with one in
 * production, which is exactly the divergence that keeps a regression in that
 * path invisible until deploy.
 */
test("a created Email reads back with its text body and a preview", async () => {
  const text = "The figures are agreed, and the schedule slips by a week.";
  const created = responseOf(
    await jmap([
      [
        "Email/set",
        {
          accountId: ACCOUNT,
          create: {
            p: {
              mailboxIds: { inbox: true },
              subject: "Preview",
              from: [{ email: "ada@example.org" }],
              to: [{ email: "bob@example.org" }],
              bodyStructure: { partId: "1", type: "text/plain", subParts: [] },
              bodyValues: {
                "1": { value: text, isEncodingProblem: false, isTruncated: false },
              },
            },
          },
        },
        "s",
      ],
    ]),
    "s",
  )[1];
  const emailId = (created.created as Record<string, { id: string }>).p?.id;
  assert.ok(emailId, "the message was created");

  const got = responseOf(
    await jmap([["Email/get", { accountId: ACCOUNT, ids: [emailId] }, "g"]]),
    "g",
  )[1];
  const email = (got.list as Array<Record<string, unknown>>)[0]!;
  assert.ok(
    (email.textBody as unknown[]).length > 0,
    "the body a caller supplied is in textBody",
  );
  assert.equal(email.preview, text.slice(0, 100), "and the preview opens the message");
});

/**
 * A change names the account it happened in.
 *
 * These handlers computed the account from the request and then answered with
 * the demo account's id beside the answer — so a change to the group's mail was
 * reported as a change in `a1`, and a reader that trusts the field attributed it
 * to the wrong account.
 */
test("Email/changes and Email/query name the account they were asked about", async () => {
  for (const call of [
    ["Email/changes", { accountId: "a3", sinceState: "0" }, "c"],
    ["Email/query", { accountId: "a3" }, "q"],
  ] as const) {
    const body = responseOf(await jmap([call]), call[2])[1] as { accountId: string };
    assert.equal(body.accountId, "a3", `${call[0]} answers with the account it read`);
  }
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});
