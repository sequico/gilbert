import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { at, freePort, jsonCall, postWith } from "./testkit.js";

/**
 * Outbound calling (ADR 0040), end to end against the mock.
 *
 * A campaign is the group's, not the caller's: it is written into the group's
 * own account, and the door that reaches it is the caller's own live membership.
 * A pasted list is read into rows, and what the paste lost is counted rather than
 * dropped. A row is taken before it is dialled, and settling it writes the call
 * into the row's own window.
 *
 * The do-not-call list is the group's, in the same account as the campaigns, so a
 * group the installation's agent holds no grant on is not a group Today cannot
 * work: nothing in this area reaches that agent at all.
 * Each test fails if the mechanism it names is removed.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-outbound";
process.env.LOGIN_RATE_LIMIT = "10000";
process.env.GILBERT_AGENT_ADDRESS = "gilbert@example.com";
process.env.GILBERT_AGENT_PASSWORD = "gilbert-password";

/** The group the demo user belongs to, and the one the door is about. */
const GROUP = "team@example.org";

const mock = await import("./mock/index.js");
const { createApp, useDurableSessions } = await import("./app.js");
const { JMAP_CONTACTS, JmapClient } = await import("./jmap.js");
const { fetchUpstreamSession } = await import("./upstream.js");

await useDurableSessions(
  { read: async () => null, write: async () => {} },
  { ttlSeconds: 3600, rememberTtlSeconds: 86_400 },
);

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

const call = jsonCall(app, HEADERS);
const post = postWith(call);

before(async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "demo@example.com", password: "demo-password" }),
  });
  assert.equal(res.status, 200, "the member signs in against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** A second identity that is in no group, so the door can be shown refusing one. */
const outsiderCall = jsonCall(app, HEADERS);

interface Campaign {
  uid: string;
  purpose: string;
  outcomes: { id: string; label: string }[];
  window: { from: string | null; to: string | null };
  state: string;
}

interface Row {
  uid: string;
  campaignUid: string;
  e164: string;
  extension: string | null;
  context: string | null;
  cardUid: string | null;
  state: string;
  claim: { by: string; until: string } | null;
  calls: { outcome: string; note: string | null; by: string }[];
}

const OUTCOMES = [
  { id: "spoke", label: "Spoke" },
  { id: "no_answer", label: "No answer" },
];

/** A campaign the demo user owns, as the route echoes it. */
async function newCampaign(purpose: string): Promise<Campaign> {
  const res = await post("/api/outbound/campaigns", {
    group: GROUP,
    purpose,
    outcomes: OUTCOMES,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const campaign = res.body?.campaign as Campaign | undefined;
  assert.ok(campaign, "the route answers with the campaign it wrote");
  return campaign;
}

/** The rows Today offers, with the campaign each belongs to. */
async function today(): Promise<Row[]> {
  const res = await call(`/api/outbound/today?group=${encodeURIComponent(GROUP)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body?.queue ?? []) as Row[];
}

test("a campaign is written into the group's account and read back by a member", async () => {
  const campaign = await newCampaign("Renewals, October");
  assert.equal(campaign.state, "running");
  assert.deepEqual(
    campaign.outcomes.map((outcome) => outcome.id),
    ["spoke", "no_answer"],
  );

  const listed = await call(`/api/outbound/campaigns?group=${encodeURIComponent(GROUP)}`);
  assert.equal(listed.status, 200);
  const campaigns = (listed.body?.campaigns ?? []) as Campaign[];
  assert.ok(
    campaigns.some((entry) => entry.uid === campaign.uid),
    "the campaign is in the group's list",
  );
  // What cannot be read is reported by Today, the screen the reader can act on.
  const queue = await call(`/api/outbound/today?group=${encodeURIComponent(GROUP)}`);
  assert.deepEqual(
    queue.body?.problems,
    [],
    "the group's folder holds no unreadable document",
  );
});

test("a campaign is refused when its vocabulary repeats or its window runs backwards", async () => {
  const repeated = await post("/api/outbound/campaigns", {
    group: GROUP,
    purpose: "Two meanings for one word",
    outcomes: [
      { id: "spoke", label: "Spoke" },
      { id: "spoke", label: "Spoke again" },
    ],
  });
  assert.equal(repeated.status, 400, "one id cannot name two outcomes");
  assert.equal(repeated.body?.error, "bad_request");

  const backwards = await post("/api/outbound/campaigns", {
    group: GROUP,
    purpose: "Ends before it starts",
    outcomes: OUTCOMES,
    window: { from: "2026-11-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
  });
  assert.equal(backwards.status, 400, JSON.stringify(backwards.body));

  const ordered = await post("/api/outbound/campaigns", {
    group: GROUP,
    purpose: "A window that closes",
    outcomes: OUTCOMES,
    window: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" },
  });
  assert.equal(ordered.status, 200, JSON.stringify(ordered.body));
  assert.equal(
    (ordered.body?.campaign as Campaign | undefined)?.window?.to,
    "2026-11-01T00:00:00Z",
    "the window is stored as the caller stated it",
  );
});

test("a caller outside the group reaches neither the list nor a write", async () => {
  const signedIn = await outsiderCall("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "bob@example.com", password: "bob-password" }),
  });
  assert.equal(signedIn.status, 200, "the second identity signs in against the mock");

  const listed = await outsiderCall(
    `/api/outbound/campaigns?group=${encodeURIComponent(GROUP)}`,
  );
  assert.equal(listed.status, 403, "a group is not reached by naming it");

  const written = await outsiderCall("/api/outbound/campaigns", {
    method: "POST",
    body: JSON.stringify({ group: GROUP, purpose: "Not mine", outcomes: OUTCOMES }),
  });
  assert.equal(written.status, 403);
});

test("a number on the group's do-not-call list is written there, and bad ones are refused", async () => {
  const added = await post("/api/outbound/do-not-call", {
    group: GROUP,
    number: "+39 333 123 4567",
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body?.numbers, ["+393331234567"]);

  const read = await call(`/api/outbound/do-not-call?group=${encodeURIComponent(GROUP)}`);
  assert.deepEqual(read.body?.numbers, ["+393331234567"]);

  const bad = await post("/api/outbound/do-not-call", {
    group: GROUP,
    number: "02 1234567",
  });
  assert.equal(
    bad.status,
    400,
    "a number with no country is refused, not written as typed",
  );
  assert.equal(bad.body?.error, "no_country");
  const after = await call(
    `/api/outbound/do-not-call?group=${encodeURIComponent(GROUP)}`,
  );
  assert.deepEqual(after.body?.numbers, ["+393331234567"], "a refusal writes nothing");
});

test("an import writes the rows it kept and counts every line it lost", async () => {
  const campaign = await newCampaign("Import counts");
  const res = await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: [
      "ACME, chiedi di Tizio, +39 02 1234567 int. 24",
      "+39 333 1234567", // on the group's do-not-call list
      "+39 02 1234567", // the same number as the first line
      "Milano, nessun numero",
    ].join("\n"),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body?.added, 1);
  assert.equal(res.body?.duplicate, 1);
  assert.equal(
    res.body?.blocked,
    1,
    "the group's do-not-call list is read by the import",
  );
  assert.deepEqual(res.body?.refused, [
    { line: "Milano, nessun numero", reason: "no_number" },
  ]);

  const rows = (await today()).filter((row) => row.campaignUid === campaign.uid);
  assert.equal(rows.length, 1);
  assert.equal(at(rows, 0).e164, "+39021234567");
  assert.equal(at(rows, 0).extension, "24");
  assert.equal(at(rows, 0).context, "ACME, chiedi di Tizio");

  // The list the campaign already holds is part of what a paste is read against: a
  // sheet imported twice adds nothing the second time.
  const again = await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: "+39 02 1234567",
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body?.added, 0);
  assert.equal(again.body?.duplicate, 1, "the number is already a row of this list");
});

test("a row is taken before it is dialled, and settling it records the call", async () => {
  const campaign = await newCampaign("One call");
  await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: "+39 06 1234567",
  });
  const [row] = (await today()).filter((entry) => entry.campaignUid === campaign.uid);
  assert.ok(row, "the imported row is in Today");

  const taken = await post(
    `/api/outbound/campaigns/${campaign.uid}/rows/${row.uid}/take`,
    {
      group: GROUP,
    },
  );
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  const claim = (taken.body?.row as Row | undefined)?.claim;
  assert.equal(claim?.by, "demo@example.com");
  assert.ok(
    claim && Date.parse(claim.until) > Date.now(),
    "the claim carries its own lapse",
  );

  const unknown = await post(
    `/api/outbound/campaigns/${campaign.uid}/rows/${row.uid}/settle`,
    {
      group: GROUP,
      outcome: "not-in-this-campaign",
    },
  );
  assert.equal(unknown.status, 400, "an outcome the campaign never named is refused");
  assert.equal(unknown.body?.error, "unknown_outcome", JSON.stringify(unknown.body));

  const settled = await post(
    `/api/outbound/campaigns/${campaign.uid}/rows/${row.uid}/settle`,
    {
      group: GROUP,
      outcome: "spoke",
      note: "Chiede un preventivo",
    },
  );
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  const done = settled.body?.row as Row;
  assert.equal(done.state, "done");
  assert.equal(done.claim, null, "settling releases the row");
  assert.deepEqual(
    done.calls.map(({ outcome, note, by }) => ({ outcome, note, by })),
    [{ outcome: "spoke", note: "Chiede un preventivo", by: "demo@example.com" }],
  );

  const after = (await today()).filter((entry) => entry.campaignUid === campaign.uid);
  assert.equal(after.length, 0, "a settled row leaves Today");
});

test("a caller holds one row of a list at a time", async () => {
  const campaign = await newCampaign("One in hand");
  await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: "+39 071 123456\n+39 071 654321",
  });
  const rows = (await today()).filter((entry) => entry.campaignUid === campaign.uid);
  assert.equal(rows.length, 2, "both lines are rows of this campaign");
  const [one, two] = [at(rows, 0), at(rows, 1)];

  const first = await post(
    `/api/outbound/campaigns/${campaign.uid}/rows/${one.uid}/take`,
    { group: GROUP },
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const second = await post(
    `/api/outbound/campaigns/${campaign.uid}/rows/${two.uid}/take`,
    { group: GROUP },
  );
  assert.equal(second.status, 409, "the second row waits until the first is settled");
  assert.equal(second.body?.error, "row_in_hand", JSON.stringify(second.body));

  // The row already in my hand is not a second hand: asking for it again is the
  // same claim renewed, which is what a refreshed screen does.
  const again = await post(
    `/api/outbound/campaigns/${campaign.uid}/rows/${one.uid}/take`,
    { group: GROUP },
  );
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test("a row taken by mistake goes back to the list", async () => {
  const campaign = await newCampaign("Taken by mistake");
  await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: "+39 0721 123456",
  });
  const [row] = (await today()).filter((entry) => entry.campaignUid === campaign.uid);
  assert.ok(row);

  const taken = await post(
    `/api/outbound/campaigns/${campaign.uid}/rows/${row.uid}/take`,
    { group: GROUP },
  );
  assert.equal(taken.status, 200, JSON.stringify(taken.body));

  const released = await post(
    `/api/outbound/campaigns/${campaign.uid}/rows/${row.uid}/release`,
    { group: GROUP },
  );
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(
    (released.body?.row as Row | undefined)?.claim,
    null,
    "the row is nobody's again",
  );

  const back = (await today()).filter((entry) => entry.campaignUid === campaign.uid);
  assert.equal(back.length, 1, "and it is offered to whoever is calling");
  assert.equal(at(back, 0).claim, null);

  // A second release has nothing to give back.
  const again = await post(
    `/api/outbound/campaigns/${campaign.uid}/rows/${row.uid}/release`,
    { group: GROUP },
  );
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body?.error, "row_not_held");
});

test("a number taken off the list is one the import may write again", async () => {
  const removed = await post("/api/outbound/do-not-call", {
    group: GROUP,
    number: "+39 333 123 4567",
    blocked: false,
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body?.numbers, []);

  const campaign = await newCampaign("After the promise was lifted");
  const res = await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: "+39 333 1234567",
  });
  assert.equal(res.body?.added, 1);
  assert.equal(res.body?.blocked, 0);
});

test("a number a group's card already carries is matched at the import", async () => {
  // The card is written the way the client writes one: a member's own JMAP
  // session, in the group's own address book.
  const authorization = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
  const session = await fetchUpstreamSession(authorization, `http://127.0.0.1:${PORT}`);
  const ctx = { authorization, session, username: "demo@example.com" };
  const accountId = Object.entries(session.accounts).find(
    ([, account]) => (account as { name?: string }).name === GROUP,
  )?.[0];
  assert.ok(accountId, "the member's session holds the group's account");

  const client = new JmapClient(ctx);
  const book = await client.call<{ created?: Record<string, { id?: unknown }> }>(
    "AddressBook/set",
    { accountId, create: { b: { name: "Outbound" } } },
    [JMAP_CONTACTS],
  );
  const bookId = book.created?.b?.id as string | undefined;
  assert.ok(bookId, "the group's address book is created");
  await client.call(
    "ContactCard/set",
    {
      accountId,
      create: {
        c: {
          "@type": "Card",
          version: "1.0",
          addressBookIds: { [bookId]: true },
          phones: { p1: { "@type": "Phone", number: "+39 02 7654321" } },
        },
      },
    },
    [JMAP_CONTACTS],
  );

  const campaign = await newCampaign("Matched to a card");
  const res = await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: "+39 02 7654321\n+39 06 12345678",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body?.added, 2);
  assert.equal(res.body?.matched, 1, "the index is built from the group's cards");

  const rows = (await today()).filter((row) => row.campaignUid === campaign.uid);
  const matched = rows.find((row) => row.e164 === "+39027654321");
  assert.ok(matched, "the known number is a row");
  assert.ok(matched.cardUid, "and it is pointed at the card that carries it");
  assert.equal(
    rows.find((row) => row.e164 === "+390612345678")?.cardUid,
    null,
    "a number no card carries stays a row with no card",
  );
});

test("a card carrying a listed number blocks its other numbers too", async () => {
  const authorization = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
  const session = await fetchUpstreamSession(authorization, `http://127.0.0.1:${PORT}`);
  const ctx = { authorization, session, username: "demo@example.com" };
  const accountId = Object.entries(session.accounts).find(
    ([, account]) => (account as { name?: string }).name === GROUP,
  )?.[0];
  assert.ok(accountId, "the member's session holds the group's account");
  const client = new JmapClient(ctx);

  const books = await client.call<{ list?: Array<{ id?: unknown }> }>(
    "AddressBook/get",
    { accountId, ids: null, properties: ["id"] },
    [JMAP_CONTACTS],
  );
  const bookId = (books.list ?? []).find((book) => typeof book.id === "string")?.id as
    | string
    | undefined;
  assert.ok(bookId, "the group has an address book by now");
  await client.call(
    "ContactCard/set",
    {
      accountId,
      create: {
        c: {
          "@type": "Card",
          version: "1.0",
          addressBookIds: { [bookId]: true },
          phones: {
            p1: { "@type": "Phone", number: "+39 06 555 1010" },
            p2: { "@type": "Phone", number: "+39 06 555 2020" },
          },
        },
      },
    },
    [JMAP_CONTACTS],
  );

  // One of the person's two numbers is on the list.
  const listed = await post("/api/outbound/do-not-call", {
    group: GROUP,
    number: "+39 06 555 1010",
  });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));

  // The other one is the same person, so the paste is refused and counted.
  const campaign = await newCampaign("The same person, another line");
  const refusedNumber = await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: "+39 06 555 2020",
  });
  assert.equal(refusedNumber.status, 200, JSON.stringify(refusedNumber.body));
  assert.equal(refusedNumber.body?.added, 0);
  assert.equal(
    refusedNumber.body?.blocked,
    1,
    "the promise is about the person, not the string pasted",
  );

  // Lifting the promise lets both back in.
  await post("/api/outbound/do-not-call", {
    group: GROUP,
    number: "+39 06 555 1010",
    blocked: false,
  });
  const allowed = await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: "+39 06 555 2020",
  });
  assert.equal(allowed.body?.added, 1);
});

test("the first call creates the card, and the call stays on it", async () => {
  const campaign = await newCampaign("A number nobody knows");
  await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: "+39 055 1234567",
  });
  const [row] = (await today()).filter((entry) => entry.campaignUid === campaign.uid);
  assert.ok(row);
  assert.equal(
    row.cardUid,
    null,
    "a number with no card stays a row until it is dialled",
  );

  await post(`/api/outbound/campaigns/${campaign.uid}/rows/${row.uid}/take`, {
    group: GROUP,
  });
  const settled = await post(
    `/api/outbound/campaigns/${campaign.uid}/rows/${row.uid}/settle`,
    { group: GROUP, outcome: "no_answer" },
  );
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  const cardUid = (settled.body?.row as Row | undefined)?.cardUid;
  assert.ok(cardUid, "the first call is what creates the card");

  const log = await call(
    `/api/outbound/card-calls?group=${encodeURIComponent(GROUP)}&card=${encodeURIComponent(cardUid)}`,
  );
  assert.equal(log.status, 200, JSON.stringify(log.body));
  const calls = (log.body?.calls ?? []) as Array<{ outcome: string; by: string }>;
  assert.equal(calls.length, 1, "the call is on the card, not only on the row");
  assert.equal(at(calls, 0).outcome, "no_answer");
  assert.equal(at(calls, 0).by, "demo@example.com");

  // The card exists in the group's address book, which is what the index reads: a
  // second paste of the same number is matched without anything else being written.
  const again = await newCampaign("The same number, later");
  const matched = await post(`/api/outbound/campaigns/${again.uid}/rows`, {
    group: GROUP,
    text: "+39 055 1234567",
  });
  assert.equal(matched.body?.matched, 1);
});

test("closing a campaign keeps it, and carrying moves the rows still open", async () => {
  const campaign = await newCampaign("Ends in October");
  await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: "+39 011 1234567\n+39 051 1234567",
  });
  const closed = await post(`/api/outbound/campaigns/${campaign.uid}/close`, {
    group: GROUP,
    carry: true,
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const successor = closed.body?.successor as Campaign | null;
  assert.ok(successor, "the open rows have somewhere to go");
  assert.equal(closed.body?.carried, 2);
  assert.equal((closed.body?.campaign as Campaign | undefined)?.state, "closed");

  const listed = await call(`/api/outbound/campaigns?group=${encodeURIComponent(GROUP)}`);
  const campaigns = (listed.body?.campaigns ?? []) as Campaign[];
  assert.equal(campaigns.find((entry) => entry.uid === campaign.uid)?.state, "closed");
  assert.ok(campaigns.some((entry) => entry.uid === successor.uid));

  const carried = (await today()).filter((row) => row.campaignUid === successor.uid);
  assert.equal(carried.length, 2, "the rows still open work in the new campaign");
  assert.deepEqual(
    at(carried, 0).calls,
    [],
    "and start with an empty window of their own",
  );

  const refused = await post(`/api/outbound/campaigns/${campaign.uid}/rows`, {
    group: GROUP,
    text: "+39 06 12345678",
  });
  assert.equal(refused.status, 409, "a closed campaign takes no new rows");
});

test("a campaign that was never created is refused by every act on it", async () => {
  const imported = await post("/api/outbound/campaigns/missing/rows", {
    group: GROUP,
    text: "+39 02 1234567",
  });
  assert.equal(imported.status, 404);
  assert.equal(imported.body?.error, "outbound_not_found");

  const taken = await post("/api/outbound/campaigns/missing/rows/row/take", {
    group: GROUP,
  });
  assert.equal(taken.status, 404, JSON.stringify(taken.body));
  assert.equal(taken.body?.error, "outbound_not_found");

  const settled = await post("/api/outbound/campaigns/missing/rows/row/settle", {
    group: GROUP,
    outcome: "spoke",
  });
  assert.equal(settled.status, 404, JSON.stringify(settled.body));
  assert.equal(settled.body?.error, "outbound_not_found");

  const closed = await post("/api/outbound/campaigns/missing/close", {
    group: GROUP,
    carry: false,
  });
  assert.equal(closed.status, 404, JSON.stringify(closed.body));
  assert.equal(closed.body?.error, "outbound_not_found");
});
