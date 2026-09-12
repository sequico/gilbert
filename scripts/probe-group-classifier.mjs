#!/usr/bin/env node
/**
 * The live probe of the group classifier (ADR 0005, "What counts as a group").
 *
 * What the whole product means by "a group" rests on one premise: that a folder,
 * calendar or address-book share which carries an address answers `Mailbox/get`
 * with **no mailboxes**, while a group mailbox answers with a folder tree. The
 * session cannot tell them apart on its own — Stalwart advertises the same
 * capabilities on every account it lists — so the mail store's probe is the
 * classifier, on the server (`server/src/agent/actions.ts`, `groupAccounts`) and
 * in the client alike. The mock simulates the answer (a share in the demo's
 * session carries none); until a real instance is asked, the tests prove the
 * client's logic against a simulation and not the server's behaviour.
 *
 * Three questions, asked the way the code asks them:
 *
 *   1. does a group mailbox answer `Mailbox/get` with a folder tree?
 *   2. does an account somebody shared answer with **none**, so the probe is
 *      what separates it from a group?
 *   3. does the answer differ per session — a member's session and the agent's
 *      own — which is what the daemon's serving list is built from?
 *
 * Usage:
 *
 *   GILBERT_PROBE_URL=https://mail.example.com \
 *   GILBERT_PROBE_USER=someone@example.com GILBERT_PROBE_PASS=… \
 *   [GILBERT_PROBE_AGENT=gilbert@example.com GILBERT_PROBE_AGENT_PASS=…] \
 *   node scripts/probe-group-classifier.mjs
 *
 * It writes nothing to the server: every call is a read.
 */

const url = (process.env.GILBERT_PROBE_URL ?? "").replace(/\/$/, "");
const user = process.env.GILBERT_PROBE_USER ?? "";
const pass = process.env.GILBERT_PROBE_PASS ?? "";
const agent = process.env.GILBERT_PROBE_AGENT ?? "";
const agentPass = process.env.GILBERT_PROBE_AGENT_PASS ?? "";

if (!url || !user || !pass) {
  console.error("set GILBERT_PROBE_URL, GILBERT_PROBE_USER and GILBERT_PROBE_PASS");
  process.exit(2);
}

const basic = (address, password) =>
  `Basic ${Buffer.from(`${address}:${password}`, "utf8").toString("base64")}`;

/** The session, and what the account list says about each account. */
async function session(authorization) {
  const res = await fetch(`${url}/.well-known/jmap`, {
    headers: { authorization, accept: "application/json" },
  });
  if (!res.ok)
    throw new Error(`the session call answered ${res.status} ${res.statusText}`);
  const body = await res.json();
  return {
    apiUrl: body.apiUrl,
    capabilities: Object.keys(body.capabilities ?? {}),
    accounts: body.accounts ?? {},
    primaryAccounts: body.primaryAccounts ?? {},
  };
}

/** `Mailbox/get` for one account, the way `hasMailStore` asks it. */
async function mailboxes(apiUrl, authorization, accountId) {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Mailbox/get",
          { accountId, ids: null, properties: ["id", "name", "role"] },
          "m",
        ],
      ],
    }),
  });
  if (!res.ok) return { error: `${res.status} ${res.statusText}` };
  const body = await res.json();
  const call = (body.methodResponses ?? [])[0];
  if (!call) return { error: "no method response" };
  if (call[0] === "error") return { error: JSON.stringify(call[1]) };
  const list = (call[1]?.list ?? []).map(
    (m) => `${m.name}${m.role ? ` (${m.role})` : ""}`,
  );
  return { list };
}

/** One session's accounts, each asked as the classifier asks them. */
async function probe(label, authorization) {
  const s = await session(authorization);
  console.log(`\n== ${label} ==`);
  console.log(`   accounts the session lists: ${Object.keys(s.accounts).length}`);
  for (const [accountId, raw] of Object.entries(s.accounts)) {
    const account = raw;
    const kind =
      account.isPersonal === true
        ? "personal"
        : typeof account.name === "string" && account.name.includes("@")
          ? "candidate (non-personal, with an address)"
          : "non-personal, no address";
    if (kind === "personal") {
      console.log(`   ${accountId} ${account.name}: ${kind} — not a candidate`);
      continue;
    }
    if (kind.startsWith("non-personal, no address")) {
      console.log(`   ${accountId} ${account.name}: ${kind} — not a candidate`);
      continue;
    }
    const result = await mailboxes(s.apiUrl, authorization, accountId);
    const verdict = result.error
      ? `could not be asked (${result.error}) — not treated as a group`
      : result.list.length > 0
        ? "GROUP (answers with a folder tree)"
        : "not a group (answers with no mailboxes) — a share";
    console.log(`   ${accountId} ${account.name}: ${verdict}`);
    if (result.list?.length)
      console.log(
        `      ${result.list.slice(0, 6).join(", ")}${result.list.length > 6 ? ", …" : ""}`,
      );
  }
}

try {
  await probe(`as ${user}`, basic(user, pass));
  if (agent && agentPass) await probe(`as the agent (${agent})`, basic(agent, agentPass));
  else
    console.log(
      "\n(no agent pair given: set GILBERT_PROBE_AGENT and GILBERT_PROBE_AGENT_PASS to ask the agent's own session, which is what the daemon serves from)",
    );
  console.log(
    "\nWhat to write down: for each account the session lists, whether it answered as a mail store — and the date and server version, in ADR 0005's classifier section.",
  );
} catch (err) {
  console.error(`the probe failed: ${err.message}`);
  process.exit(1);
}
