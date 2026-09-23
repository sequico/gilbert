#!/usr/bin/env node
/**

 * The live probe of group membership over Stalwart's registry (ADR 0005).
 *
 * The `@` picker beside a group's chat offers the group's members, and the
 * transcript greys a mention of somebody who is no longer one. The mock stands
 * in for a 0.16 server and proves nothing about one: it answers
 * `x:Account/query` with a `memberGroupIds` filter because that is the shape
 * the code assumes, and the assumption is recorded as owed in the mock — the
 * direction membership is readable in, the only filter that names it, and what
 * a credential without the permission sees. This script asks all of it.
 *
 * The questions, asked the way the code asks them:
 *
 *   1. does the session carry the registry capability (`urn:stalwart:jmap`)?
 *   2. is there no group-side object at all — `x:Group/get` and
 *      `x:Group/query` answering `unknownMethod`?
 *   3. does an account record carry `memberGroupIds`, and a **group** record
 *      carry no member list (so membership is readable in one direction)?
 *   4. does `x:Account/query` accept `filter: { memberGroupIds: <group id> }`
 *      and answer the group's members' ids?
 *   5. are `groupId` and `memberOf` refused with `unsupportedFilter` — i.e. is
 *      `memberGroupIds` the only membership filter?
 *   6. does `x:Account/get` with `ids: null` answer every account (true, and
 *      the reason the code pages the query instead)?
 *   7. (optional) given a second credential, what does the registry answer a
 *      principal that does not hold `sysAccountGet`/`sysAccountQuery` — the
 *      method-level `forbidden` the caller reads, or something else?
 *
 * Usage, against a real instance — the credential must be one that may read the
 * registry (a Stalwart administrator, or an account the server grants the
 * permission to; a plain member's is refused, which is the answer to 7):
 *
 *   STALWART_URL=https://stalwart.example:8080 \
 *   GILBERT_AGENT_ADDRESS=gilbert@example.com \
 *   GILBERT_AGENT_PASSWORD='…' \
 *   node scripts/probe-group-membership.mjs
 *
 * Optional:
 *
 *   GILBERT_PROBE_SESSION_URL      the session endpoint, when it is not
 *                                  `$STALWART_URL/.well-known/jmap`
 *   GILBERT_PROBE_GROUP_ACCOUNT    the group account to read a roster of; when
 *                                  absent the probe picks the first group the
 *                                  registry lists
 *   GILBERT_PROBE_PLAIN_USER       a credential the registry gate does not
 *   GILBERT_PROBE_PLAIN_PASSWORD   admit, for question 7
 *
 * It writes nothing to the server: every call is a read. It exits 0 when every
 * assumed behaviour holds, 1 when one does not or a question could not be
 * settled, and 2 when the environment does not say where to ask.
 */

import {
  answerOf,
  basic,
  note,
  record,
  report,
  requireProbeEnvironment,
  sessionUrlFor,
  jmap as sharedJmap,
  session as sharedSession,
} from "./lib/probeKit.mjs";

const base = (process.env.STALWART_URL ?? "").replace(/\/+$/, "");
const user = process.env.GILBERT_AGENT_ADDRESS ?? "";
const password = process.env.GILBERT_AGENT_PASSWORD ?? "";
const plainUser = process.env.GILBERT_PROBE_PLAIN_USER ?? "";
const plainPassword = process.env.GILBERT_PROBE_PLAIN_PASSWORD ?? "";

requireProbeEnvironment(
  [base, user, password],
  [
    "This probe asks a real server, so it needs the installation's own facts:",
    "  STALWART_URL             the instance, e.g. https://stalwart.example:8080",
    "  GILBERT_AGENT_ADDRESS    an account that may read the registry (a Stalwart",
    "                           administrator, or one the server grants",
    "                           sysAccountGet/sysAccountQuery to)",
    "  GILBERT_AGENT_PASSWORD   its password",
    "",
    "Optional: GILBERT_PROBE_SESSION_URL, GILBERT_PROBE_GROUP_ACCOUNT,",
    "GILBERT_PROBE_PLAIN_USER, GILBERT_PROBE_PLAIN_PASSWORD (see the header).",
  ],
);

const CORE = "urn:ietf:params:jmap:core";
const PRINCIPALS = "urn:ietf:params:jmap:principals";
const STALWART = "urn:stalwart:jmap";
const SESSION_URL = sessionUrlFor(base);

const session = (authorization) => sharedSession(SESSION_URL, authorization);

/** One JMAP request, over the registry the group questions need. */
const jmap = (apiUrl, authorization, methodCalls) =>
  sharedJmap(apiUrl, authorization, methodCalls, [CORE, STALWART, PRINCIPALS]);

const typeOf = (entry) => String(entry[1]?.type ?? "");

/**
 * Where the registry capability is advertised, asked the way
 * `hasStalwartRegistry` asks it: the session's top level, `primaryAccounts`,
 * or any account's own capabilities. A real 0.16 server advertises it on the
 * account rather than at the top level (live, 2026-09-13), which is why the
 * code checks all three.
 */
function registryCapability(held) {
  if (held.capabilities && STALWART in held.capabilities) return "session";
  if (held.primaryAccounts && STALWART in held.primaryAccounts) return "primaryAccounts";
  for (const account of Object.values(held.accounts ?? {}))
    if (account?.accountCapabilities && STALWART in account.accountCapabilities)
      return "account";
  return "";
}

async function run() {
  const authorization = basic(user, password);
  const held = await session(authorization);
  const apiUrl = held.apiUrl;
  const accountId =
    held.primaryAccounts?.[STALWART] ??
    held.primaryAccounts?.["urn:ietf:params:jmap:mail"] ??
    Object.keys(held.accounts ?? {})[0];
  if (!apiUrl || !accountId) {
    console.error("the session named no apiUrl or account to ask");
    return 1;
  }

  const where = registryCapability(held);
  record("the session advertises the registry capability", where || "nowhere", [
    "session",
    "primaryAccounts",
    "account",
  ]);
  note("where the registry capability is advertised", where || "nowhere");

  // 2 and 3: no group-side object, and membership on the account side.
  const shape = await jmap(apiUrl, authorization, [
    ["x:Group/get", { accountId, ids: ["x"] }, "g1"],
    ["x:Group/query", { accountId, limit: 1 }, "g2"],
    [
      "x:Account/get",
      {
        accountId,
        ids: null,
        properties: ["id", "@type", "emailAddress", "memberGroupIds"],
      },
      "a1",
    ],
  ]);
  record(
    "x:Group/get is unknownMethod",
    typeOf(answerOf(shape.responses, "g1")) || "answered",
    "unknownMethod",
  );
  record(
    "x:Group/query is unknownMethod",
    typeOf(answerOf(shape.responses, "g2")) || "answered",
    "unknownMethod",
  );

  const accounts = (answerOf(shape.responses, "a1")[1]?.list ?? []).filter(
    (record_) => record_ && typeof record_ === "object",
  );
  const users = accounts.filter((a) => a["@type"] === "User");
  const groups = accounts.filter((a) => a["@type"] === "Group");
  note("accounts the registry answered with `ids: null`", String(accounts.length));
  note(
    "user accounts carrying memberGroupIds",
    String(
      users.filter((a) => a.memberGroupIds && Object.keys(a.memberGroupIds).length)
        .length,
    ),
  );
  record(
    "a group record carries no member list",
    groups.some((g) => "memberGroupIds" in g || "members" in g) ? "yes" : "no",
    "no",
  );

  const groupAccountId =
    process.env.GILBERT_PROBE_GROUP_ACCOUNT || String(groups[0]?.id ?? "");
  /* The group is named as the registry answered it rather than as the
     environment spelled it: `emailAddress` is what the operator recognises,
     and asking about an account the directory does not list is worth saying
     outright, since every question below it answers empty. */
  const groupRecord = groups.find((g) => g.id === groupAccountId);
  const groupLabel = groupRecord
    ? String(groupRecord.emailAddress ?? groupRecord.name ?? "an unnamed group")
    : "the group named by GILBERT_PROBE_GROUP_ACCOUNT";
  if (!groupAccountId) {
    note(
      "a group's roster",
      "the registry listed no group, so questions 4 and 5 were not asked",
    );
  } else {
    const roster = await jmap(apiUrl, authorization, [
      [
        "x:Account/query",
        { accountId, filter: { memberGroupIds: groupAccountId }, limit: 100 },
        "q1",
      ],
      [
        "x:Account/query",
        { accountId, filter: { groupId: groupAccountId }, limit: 100 },
        "q2",
      ],
      [
        "x:Account/query",
        { accountId, filter: { memberOf: groupAccountId }, limit: 100 },
        "q3",
      ],
    ]);
    const ids = answerOf(roster.responses, "q1")[1]?.ids;
    record(
      "the roster query answers ids",
      Array.isArray(ids) ? "list" : typeOf(answerOf(roster.responses, "q1")) || "other",
      "list",
    );
    record(
      "a `groupId` filter is refused",
      typeOf(answerOf(roster.responses, "q2")) || "accepted",
      "unsupportedFilter",
    );
    record(
      "a `memberOf` filter is refused",
      typeOf(answerOf(roster.responses, "q3")) || "accepted",
      "unsupportedFilter",
    );
    if (Array.isArray(ids) && ids.length) {
      const read = await jmap(apiUrl, authorization, [
        [
          "x:Account/get",
          { accountId, ids, properties: ["id", "@type", "emailAddress"] },
          "m1",
        ],
      ]);
      const list = answerOf(read.responses, "m1")[1]?.list ?? [];
      note(
        `the roster of ${groupLabel}`,
        `${list.length} member(s): ${list
          .filter((a) => a["@type"] === "User")
          .map((a) => a.emailAddress)
          .join(", ")}`,
      );
    }
  }

  // 7: what a credential without the permission sees. Optional.
  if (plainUser && plainPassword) {
    const plain = basic(plainUser, plainPassword);
    const plainHeld = await session(plain);
    const refused = await jmap(plainHeld.apiUrl ?? apiUrl, plain, [
      [
        "x:Account/query",
        { accountId, filter: { memberGroupIds: groupAccountId || "x" }, limit: 1 },
        "p1",
      ],
      ["x:Account/get", { accountId, ids: null }, "p2"],
    ]);
    record(
      "a credential without the permission is refused at the method level",
      typeOf(answerOf(refused.responses, "p1")) || "accepted",
      "forbidden",
    );
    record(
      "and the same for the get",
      typeOf(answerOf(refused.responses, "p2")) || "accepted",
      "forbidden",
    );
    note("the refusal arrives inside HTTP", String(refused.status));
  } else {
    note(
      "a credential without the permission",
      "not asked: give GILBERT_PROBE_PLAIN_USER and GILBERT_PROBE_PLAIN_PASSWORD",
    );
  }

  return report({
    where:
      "in the membership note in the `gilbert-stalwart` skill and in server/src/agentAdmin.ts",
  });
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      `the probe could not finish: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
