import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort } from "../testkit.js";

/**
 * What a contact card's `media` may hold.
 *
 * Stalwart refuses a `blobId` inside a card's `media` -- "blobIds in media is
 * not supported", `invalidProperties` on `media`, and it fails the whole
 * `ContactCard/set` -- while the RFC 9553 `uri` form, a `data:` URI, is accepted
 * and returned unchanged. Confirmed live on 0.16.22 (2026-09-16), and the mock
 * here models it.
 *
 * The mock took anything before, which is exactly how a photo upload that never
 * worked against a real server shipped: every test passed, and the write only
 * failed once it reached one. This file is the assumption pinned next to the
 * simulation, so a mock that stopped refusing it fails here rather than letting
 * the editor look correct again.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const HEADERS = { authorization: AUTH, "content-type": "application/json" };

type MethodCall = [string, Record<string, unknown>, string];

async function jmap(methodCalls: unknown[]): Promise<MethodCall[]> {
  const res = await fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls,
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { methodResponses: MethodCall[] };
  return body.methodResponses;
}

const responseOf = (responses: MethodCall[], id: string): MethodCall => {
  const found = responses.find((r) => r[2] === id);
  assert.ok(found, `${id} should answer`);
  return found;
};

/** A book to write cards into, so nothing here depends on the seeded ones. */
async function mkBook(): Promise<string> {
  const responses = await jmap([
    [
      "AddressBook/set",
      { accountId: ACCOUNT, create: { b: { name: "Photo probe" } } },
      "b",
    ],
  ]);
  const created = responseOf(responses, "b")[1].created as Record<string, { id: string }>;
  return created.b!.id;
}

const card = (bookId: string, media: Record<string, unknown>) => ({
  "@type": "Card",
  version: "1.0",
  uid: `uid-${Math.random().toString(36).slice(2)}`,
  kind: "individual",
  name: { full: "Ada Lovelace" },
  addressBookIds: { [bookId]: true },
  media,
});

test("a photo given as a blob id is refused, and the refusal names media", async () => {
  const book = await mkBook();
  const responses = await jmap([
    [
      "ContactCard/set",
      {
        accountId: ACCOUNT,
        create: {
          c: card(book, { p: { "@type": "Media", kind: "photo", blobId: "b1" } }),
        },
      },
      "c",
    ],
  ]);
  const answer = responseOf(responses, "c")[1];
  assert.deepEqual(answer.created ?? {}, {}, "nothing was created");
  const notCreated = answer.notCreated as Record<
    string,
    { type: string; properties: string[]; description: string }
  >;
  assert.equal(notCreated.c?.type, "invalidProperties");
  assert.deepEqual(notCreated.c?.properties, ["media"]);
  assert.match(String(notCreated.c?.description), /blobIds in media/);
});

test("a photo given as a data URI is accepted, and comes back unchanged", async () => {
  const book = await mkBook();
  const dataUrl = "data:image/jpeg;base64,AAAA";
  const responses = await jmap([
    [
      "ContactCard/set",
      {
        accountId: ACCOUNT,
        create: {
          c: card(book, {
            p: { "@type": "Media", kind: "photo", uri: dataUrl, mediaType: "image/jpeg" },
          }),
        },
      },
      "c",
    ],
  ]);
  const created = responseOf(responses, "c")[1].created as Record<string, { id: string }>;
  const id = created.c!.id;

  const back = await jmap([["ContactCard/get", { accountId: ACCOUNT, ids: [id] }, "g"]]);
  const list = responseOf(back, "g")[1].list as Array<{
    media?: Record<string, { uri?: string; blobId?: string }>;
  }>;
  const photo = Object.values(list[0]?.media ?? {})[0];
  assert.equal(photo?.uri, dataUrl, "the data URI is returned as it was written");
  assert.equal(photo?.blobId, undefined);
});

test("one refused card does not hide the fate of the others", async () => {
  const book = await mkBook();
  const responses = await jmap([
    [
      "ContactCard/set",
      {
        accountId: ACCOUNT,
        create: {
          bad: card(book, { p: { kind: "photo", blobId: "b1" } }),
          good: card(book, {
            p: { kind: "photo", uri: "data:image/png;base64,BB" },
          }),
        },
      },
      "c",
    ],
  ]);
  const answer = responseOf(responses, "c")[1];
  const notCreated = answer.notCreated as Record<string, { type: string }>;
  const created = answer.created as Record<string, { id: string }>;
  assert.equal(notCreated.bad?.type, "invalidProperties", "the bad card is refused");
  assert.ok(created.good?.id, "and the good one is still created");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});
