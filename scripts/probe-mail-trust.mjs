#!/usr/bin/env node
/**
 * The live probe of the mail-trust reading (ADR 0033).
 *
 * `personWord` (`server/src/agent/trust.ts`) decides whether a message is the
 * sender's own word from the **first `Received` hop** the receiving server
 * wrote: the submission marker, the account it authenticated, and (for an
 * outside message) the `authserv-id` of its `Authentication-Results`. What a
 * live Stalwart actually writes there is the one thing the repository cannot
 * know from inside, and the reading is built on it.
 *
 * This script reads the newest messages of one account and prints, for each,
 * the first hop, whether the reading would call it a submission, which account
 * it would read, and the authentication result's own name — the facts the note
 * in `trust.ts` is owed. Nothing is written, and nothing is created: it is a
 * reader.
 *
 * Credentials come from the environment and are never written anywhere.
 *
 *   GILBERT_PROBE_URL=https://stalwart.example:8080 \
 *   GILBERT_PROBE_USER=someone@example.com \
 *   GILBERT_PROBE_PASS='…' \
 *   GILBERT_PROBE_MAIL_COUNT=5 \
 *   node scripts/probe-mail-trust.mjs
 *
 * A message the institution submitted itself (a send from the web client) and
 * one that arrived from outside are both useful answers; read both and record
 * what the server wrote in `trust.ts`'s OWED note.
 */

import {
  basic,
  note,
  report,
  requireProbeEnvironment,
  sessionUrlFor,
} from "./lib/probeKit.mjs";

const base = (process.env.GILBERT_PROBE_URL ?? "").replace(/\/+$/, "");
const user = process.env.GILBERT_PROBE_USER ?? "";
const password = process.env.GILBERT_PROBE_PASS ?? "";

requireProbeEnvironment(
  [base, user, password],
  [
    "This probe asks a real server, so it needs credentials in the environment:",
    "  GILBERT_PROBE_URL   the instance, e.g. https://stalwart.example:8080",
    "  GILBERT_PROBE_USER  an account with a mailbox",
    "  GILBERT_PROBE_PASS  its password",
    "",
    "It only reads the newest messages; it writes nothing.",
  ],
);

const CORE_CAP = "urn:ietf:params:jmap:core";
const MAIL_CAP = "urn:ietf:params:jmap:mail";
const auth = basic(user, password);
const headers = { authorization: auth, "content-type": "application/json" };

const sessionRes = await fetch(sessionUrlFor(base), { headers: { authorization: auth } });
if (!sessionRes.ok) {
  console.error(`the session could not be read: HTTP ${sessionRes.status}`);
  process.exit(1);
}
const session = await sessionRes.json();
const accountId =
  session.primaryAccounts?.[MAIL_CAP] ??
  Object.entries(session.accounts ?? {}).find(
    ([, account]) => account?.accountCapabilities?.[MAIL_CAP],
  )?.[0];
if (!accountId) {
  console.error("the session lists no mail account to read");
  process.exit(1);
}

const count = Math.min(
  Math.max(Number.parseInt(process.env.GILBERT_PROBE_MAIL_COUNT ?? "5", 10) || 5, 1),
  50,
);

async function jmap(methodCalls) {
  const res = await fetch(session.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ using: [CORE_CAP, MAIL_CAP], methodCalls }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).methodResponses ?? [];
}

/* The two readings the code makes, copied here so the probe says what it sees. */
const SUBMISSION = /\bESMTPS?A\b|\bauthenticated\b/i;
const AUTH_SENDER =
  /\(\s*authenticated(?:\s+(?:sender|as))?\s*(?:as\b|:)?\s*<?([^\s<>()[\]"',;]+@[^\s<>()[\]"',;]+)>?\s*\)/i;

const [query] = await jmap([
  [
    "Email/query",
    { accountId, sort: [{ property: "receivedAt", isAscending: false }], limit: count },
    "q",
  ],
]);
const ids = query?.[1]?.ids ?? [];
if (!ids.length) {
  note("the mailbox", "holds no message to read");
  report({ where: "the OWED note in server/src/agent/trust.ts" });
  process.exit(0);
}

const [got] = await jmap([
  [
    "Email/get",
    {
      accountId,
      ids,
      properties: [
        "from",
        "subject",
        "receivedAt",
        "header:Received:asText:all",
        "header:Authentication-Results:asText",
      ],
    },
    "g",
  ],
]);
for (const message of got?.[1]?.list ?? []) {
  const hops = Array.isArray(message["header:Received:asText:all"])
    ? message["header:Received:asText:all"]
    : [];
  const hop = typeof hops[0] === "string" ? hops[0] : "";
  const results =
    typeof message["header:Authentication-Results:asText"] === "string"
      ? message["header:Authentication-Results:asText"]
      : "";
  note(
    `${message.receivedAt ?? ""} · ${message.subject ?? ""}`,
    JSON.stringify({
      from: message.from?.[0]?.email ?? null,
      submission: SUBMISSION.test(hop),
      authenticated: AUTH_SENDER.exec(hop)?.[1] ?? null,
      authservId: results.split(";")[0] ?? "",
      firstHop: hop,
    }),
  );
}
report({ where: "the OWED note in server/src/agent/trust.ts" });
