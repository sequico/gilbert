import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort, jsonCall, postWith } from "./testkit.js";

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
  assert.deepEqual(
    listed.body?.problems,
    [],
    "the group's folder holds no unreadable document",
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
  assert.equal(rows[0].e164, "+39021234567");
  assert.equal(rows[0].extension, "24");
  assert.equal(rows[0].context, "ACME, chiedi di Tizio");
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

test("a campaign that was never created is refused by every act on it", async () => {
  const res = await post("/api/outbound/campaigns/missing/rows", {
    group: GROUP,
    text: "+39 02 1234567",
  });
  assert.equal(res.status, 404);
  assert.equal(res.body?.error, "outbound_not_found");
});
