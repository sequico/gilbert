#!/usr/bin/env node
/**
 * The live probe of a member's own subscription on a group's folders (ADR 0021).
 *
 * A group mailbox is reached by membership, and a subscription is not part of
 * the grant: `isSubscribed` is read state kept for one principal, and a newly
 * added member is handed every folder of the group unsubscribed. The client
 * writes it back for every folder that lacks it (`ensureSubscribed` in
 * `web/src/store/mail.ts`, on every read of the tree), and whether a member
 * **may** write that field is read rather than confirmed — the folder grants
 * them rename and delete, and the same tree has read the server refuse that
 * field on an address book shared read-only while accepting it on a shared
 * calendar. So this is the question ADR 0021 leaves owed, asked the way the
 * code asks it:
 *
 *   1. does a member's own credential reach the group account, and does
 *      `Mailbox/get` answer its folder tree?
 *   2. is there a folder of it the member is not subscribed to — the state the
 *      write exists for?
 *   3. does `Mailbox/set` with `update: {<folder id>: {isSubscribed: true}}`
 *      answer `updated`, and does a read back report the folder subscribed?
 *   4. when it does not: what does a refusal look like — a method-level error
 *      inside a 200, an HTTP status, an `invalidProperties`?
 *   5. (`GILBERT_PROBE_MOVE=1`) does a folder moved inside the group keep the
 *      subscription its member held? That decides what a dated sentence in
 *      `gilbertstalwart` may claim about a move the client did not make.
 *
 * Usage, against a real instance — the credential is a **member's**, never an
 * administrator's, because a member is who the code writes as:
 *
 *   STALWART_URL=https://stalwart.example:8080 \
 *   GILBERT_MEMBER_ADDRESS=someone@example.com \
 *   GILBERT_MEMBER_PASSWORD='…' \
 *   GILBERT_PROBE_GROUP_ADDRESS=team@example.com \
 *   node scripts/probe-group-subscriptions.mjs
 *
 * What it writes is one field, `isSubscribed: true`, on a folder that lacks it
 * — `false` is never written, because unsubscribing somebody's folder is not
 * this probe's business — and with `GILBERT_PROBE_MOVE=1` it moves that folder
 * into the group's Inbox and back to where it was. Run it on a group you can
 * afford to touch with a member's own credential; it reports every write it
 * made. It exits 0 when every assumed behaviour holds, 1 when one does not and
 * 2 when the environment does not say where to ask.
 */

import {
  basic,
  note,
  record,
  report,
  requireProbeEnvironment,
  sessionUrlFor,
} from "./lib/probeKit.mjs";

const base = (process.env.STALWART_URL ?? "").replace(/\/+$/, "");
const user = process.env.GILBERT_MEMBER_ADDRESS ?? "";
const password = process.env.GILBERT_MEMBER_PASSWORD ?? "";
const groupAddress = (process.env.GILBERT_PROBE_GROUP_ADDRESS ?? "").toLowerCase();
const move = (process.env.GILBERT_PROBE_MOVE ?? "") === "1";

requireProbeEnvironment(
  [base, user, password, groupAddress],
  [
    "This probe asks a real server as one of its members, so it needs:",
    "  STALWART_URL                 the instance, e.g. https://stalwart.example:8080",
    "  GILBERT_MEMBER_ADDRESS       a member of the group, not an administrator",
    "  GILBERT_MEMBER_PASSWORD      that member's password",
    "  GILBERT_PROBE_GROUP_ADDRESS  the group mailbox to ask about, by its address",
    "",
    "Optional: GILBERT_PROBE_SESSION_URL, GILBERT_PROBE_MOVE=1 (see the header).",
  ],
);

const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";
const TIMEOUT = 30_000;

async function session(authorization) {
  const res = await fetch(sessionUrlFor(base), {
    headers: { authorization, accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`the session endpoint answered ${res.status}`);
  return res.json();
}

/** One JMAP request; status and batch both come back, refusal or not. */
async function jmap(apiUrl, authorization, methodCalls) {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ using: [CORE, MAIL], methodCalls }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, responses: body.methodResponses ?? [] };
}

/** The `["name", body, id]` tuple for a call id, error or not. */
const answerOf = (responses, callId) =>
  responses.find(([, , id]) => id === callId) ?? [
    "missingResponse",
    { type: "missingResponse", description: `no response for ${callId}` },
    callId,
  ];

/** Whether a `Mailbox/set` answer applied the one update it was given. */
const appliedUpdate = (entry, id) =>
  entry[0] === "Mailbox/set" && Object.hasOwn(entry[1]?.updated ?? {}, id);

/** A refusal, as the log line the client would write is composed from it. */
const refusalOf = ({ status, entry }) =>
  entry[0] === "Mailbox/set"
    ? `notUpdated ${JSON.stringify(entry[1]?.notUpdated ?? {})}`
    : `HTTP ${status} / ${entry[0]} ${JSON.stringify(entry[1]).slice(0, 200)}`;

const authorization = basic(user, password);
const held = await session(authorization);

const group = Object.entries(held.accounts ?? {}).find(
  ([, account]) =>
    account?.isPersonal === false &&
    String(account.name ?? "").toLowerCase() === groupAddress,
);
record(
  "the member's session lists the group as a non-personal account",
  group ? "yes" : "no",
  "yes",
);
if (!group) {
  note(
    "the accounts the session lists",
    Object.entries(held.accounts ?? {})
      .map(([id, a]) => `${id} ${a?.name}${a?.isPersonal ? "" : " (shared)"}`)
      .join(", "),
  );
  process.exit(report({ where: "the owed note in the gilbert-stalwart skill" }));
}
const [accountId] = group;

const foldersAnswer = await jmap(held.apiUrl, authorization, [
  [
    "Mailbox/get",
    { accountId, ids: null, properties: ["id", "name", "parentId", "isSubscribed"] },
    "folders",
  ],
]);
const folders = answerOf(foldersAnswer.responses, "folders")[1]?.list ?? [];
record("Mailbox/get answers the group's folders", folders.length ? "yes" : "no", "yes");
const unsubscribed = folders.filter((f) => f.isSubscribed === false);
note(
  "the group's folders",
  folders
    .map((f) => `${f.name}${f.isSubscribed === false ? "" : " (subscribed)"}`)
    .join(", "),
);
record(
  "a folder of it is unsubscribed, as a member's are",
  unsubscribed.length ? "yes" : "no",
  "yes",
);

/* The Inbox is the only folder whose subscription the mock and a real server
   both always report, so it is not a candidate for the write. */
const target = unsubscribed.find((f) => f.role !== "inbox") ?? unsubscribed[0];

if (target) {
  const written = await jmap(held.apiUrl, authorization, [
    [
      "Mailbox/set",
      { accountId, update: { [target.id]: { isSubscribed: true } } },
      "subscribe",
    ],
  ]);
  const entry = answerOf(written.responses, "subscribe");
  const applied = appliedUpdate(entry, target.id);
  record(
    "a member may subscribe a folder of their group",
    applied ? "updated" : "refused",
    "updated",
  );
  if (!applied)
    note("what the refusal wears", refusalOf({ status: written.status, entry }));

  const back = await jmap(held.apiUrl, authorization, [
    [
      "Mailbox/get",
      { accountId, ids: [target.id], properties: ["id", "name", "isSubscribed"] },
      "back",
    ],
  ]);
  const readBack = answerOf(back.responses, "back")[1]?.list?.[0];
  record(
    "the subscription is there when it is read back",
    readBack?.isSubscribed === true ? "yes" : "no",
    "yes",
  );

  if (move && target.parentId !== null) {
    const inbox = folders.find((f) => f.role === "inbox");
    const moved =
      inbox && inbox.id !== target.id
        ? await jmap(held.apiUrl, authorization, [
            [
              "Mailbox/set",
              { accountId, update: { [target.id]: { parentId: inbox.id } } },
              "move",
            ],
          ])
        : null;
    const movedEntry = moved ? answerOf(moved.responses, "move") : null;
    if (movedEntry && appliedUpdate(movedEntry, target.id)) {
      const after = await jmap(held.apiUrl, authorization, [
        [
          "Mailbox/get",
          { accountId, ids: [target.id], properties: ["id", "name", "isSubscribed"] },
          "after",
        ],
      ]);
      const afterRead = answerOf(after.responses, "after")[1]?.list?.[0];
      record(
        "a folder moved inside the group keeps the member's subscription",
        afterRead?.isSubscribed === true ? "yes" : "no",
        "yes",
      );
      /* Put it back, so the probe leaves the tree where it found it. */
      await jmap(held.apiUrl, authorization, [
        [
          "Mailbox/set",
          { accountId, update: { [target.id]: { parentId: target.parentId } } },
          "restore",
        ],
      ]);
      note("the folder moved and put back", `${target.name} (${target.id})`);
    } else if (movedEntry) {
      note(
        "the move was refused",
        refusalOf({ status: moved.status, entry: movedEntry }),
      );
    }
  }
}

process.exit(report({ where: "the owed note in the gilbert-stalwart skill" }));
