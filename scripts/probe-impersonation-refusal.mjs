#!/usr/bin/env node
/**

 * The live probe of a refused impersonation (`server/src/agentAdmin.ts`,
 * `impersonateAs`, and `server/src/app.ts`'s `/admin/users` acting-check).
 *
 * Everything the admin surfaces do to somebody else's account rests on one
 * premise: that the server answering "no" to a composite credential
 * `{target}%{master}` answers it with a status the code reads as a refusal. The
 * code reads exactly two — `fetchUpstreamSession` turns 401 and 403 into
 * `UpstreamError(401)`, which `impersonateAs` reports as "no such account, or it
 * cannot be administered by you" (a 404 at the surface) — and reads everything
 * else the opposite way: another status becomes an upstream failure (502, "the
 * server is broken"), and a **200** becomes a working session as the target,
 * which is not a refusal at all. Nothing in the tree proves which of the three
 * a real server sends; the mock decides it for itself (`resolveIdentity`), and
 * the assumption is written down in its comment as owed.
 *
 * The questions, asked the way the code asks them:
 *
 *   1. does the master's own credential open a session? (Without this nothing
 *      else means anything: a refused composite is only a refusal if the
 *      credential itself works.)
 *   2. is a composite naming an address the master may not act as refused with
 *      401 or 403 — the answer `impersonateAs` turns into "no such account"?
 *   3. (given `GILBERT_PROBE_TARGET`) does a composite naming an account the
 *      master *may* act as open a session as that account? This is the control
 *      that tells a refusal apart from the composite shape being wrong: without
 *      it, "refused" is consistent with "every composite fails".
 *   4. (given `GILBERT_PROBE_GROUP_ADDRESS`) is a group mailbox refused? The
 *      group surfaces are built on the server having no credential for one.
 *
 * Usage, against a real instance:
 *
 *   STALWART_URL=https://stalwart.example:8080 \
 *   GILBERT_AGENT_ADDRESS=admin@example.com \
 *   GILBERT_AGENT_PASSWORD='…' \
 *   [GILBERT_PROBE_TARGET=someone@example.com] \
 *   [GILBERT_PROBE_GROUP_ADDRESS=team@example.com] \
 *   node scripts/probe-impersonation-refusal.mjs
 *
 * The master must be a principal the server lets impersonate (in Gilbert, a
 * Stalwart administrator: ADR 0001). Optional: `GILBERT_PROBE_REFUSED_ADDRESS`
 * to name the address that must be refused instead of a fresh one this run
 * invents, and `GILBERT_PROBE_SESSION_URL` when the session endpoint is not
 * `$STALWART_URL/.well-known/jmap`.
 *
 * It writes nothing to the server: every call is a read. It exits 0 when every
 * assumed behaviour holds, 1 when one does not or a question could not be
 * settled, and 2 when the environment does not say where to ask. The password
 * is never printed, and neither is the Authorization header it builds.
 */

import { basic, note, record, report } from "./lib/probeKit.mjs";

const base = (process.env.STALWART_URL ?? "").replace(/\/+$/, "");
const master = process.env.GILBERT_AGENT_ADDRESS ?? "";
const password = process.env.GILBERT_AGENT_PASSWORD ?? "";
const target = process.env.GILBERT_PROBE_TARGET ?? "";
const group = process.env.GILBERT_PROBE_GROUP_ADDRESS ?? "";

if (!base || !master || !password) {
  console.error(
    [
      "This probe asks a real server, so it needs the installation's own facts:",
      "  STALWART_URL            the instance, e.g. https://stalwart.example:8080",
      "  GILBERT_AGENT_ADDRESS   the principal that will impersonate (a Stalwart",
      "                          administrator, ADR 0001)",
      "  GILBERT_AGENT_PASSWORD  its password",
      "",
      "Optional: GILBERT_PROBE_TARGET (an account it may act as — the control that",
      "makes a refusal mean something), GILBERT_PROBE_GROUP_ADDRESS,",
      "GILBERT_PROBE_REFUSED_ADDRESS, GILBERT_PROBE_SESSION_URL.",
    ].join("\n"),
  );
  process.exit(2);
}

const SESSION_URL = process.env.GILBERT_PROBE_SESSION_URL || `${base}/.well-known/jmap`;
const TIMEOUT = 30_000;
/** An address nothing can hold: fresh each run, so it cannot have appeared. */
const absent =
  process.env.GILBERT_PROBE_REFUSED_ADDRESS ??
  `no-such-account-${Date.now()}@${master.includes("@") ? master.slice(master.lastIndexOf("@") + 1) : "example.com"}`;

/**
 * The composite credential the code builds (`impersonationAuthorization` in
 * sessions.ts): `{target}%{master}`, authenticated with the master's password.
 * Nothing else about the header is ours to choose — the target comes first.
 */
const composite = (address) => basic(`${address}%${master}`, password);

const answers = [];
const notes = [];

/** Record one question's answer and whether the code depends on it. */
function record(question, answer, assumed) {
  const wanted = Array.isArray(assumed) ? assumed : [assumed];
  answers.push({
    question,
    answer,
    assumed: wanted.join(" | "),
    ok: wanted.includes(answer),
  });
}

/** Something the code survives either way, or that settles none of it. Read. */
function note(question, answer) {
  notes.push({ question, answer });
}

/**
 * One session call, classified the way `fetchUpstreamSession` classifies it:
 * 200 with an `apiUrl` is a session (the code refuses one without), 401/403 is
 * the refusal, and anything else — including a 200 that is not a session
 * document — is the failure the code does not read as a refusal.
 */
async function open(authorization) {
  const res = await fetch(SESSION_URL, {
    headers: { authorization, accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  let username = null;
  let session = false;
  try {
    const body = JSON.parse(text);
    username = typeof body.username === "string" ? body.username : null;
    session = typeof body.apiUrl === "string";
  } catch {
    /* not a session document: the status and the body are the answer */
  }
  return {
    status: res.status,
    username,
    session,
    detail: text.slice(0, 300).replace(/\s+/g, " ").trim() || "(an empty body)",
  };
}

/** What one answer is, in the code's own words. */
function classify(answer) {
  if (answer.status === 401 || answer.status === 403)
    return `refused with HTTP ${answer.status}`;
  if (answer.status === 200 && answer.session) return "opened a session";
  if (answer.status === 200) return "answered HTTP 200 without a session";
  return `answered HTTP ${answer.status}`;
}

const run = async () => {
  console.log(`server:      ${base}`);
  console.log(`session:     ${SESSION_URL}`);
  console.log(`master:      ${master} (its password, in the header only)`);
  console.log(`composite:   {target}%{master}, authenticated with the master's password`);
  console.log(`absent:      ${absent}`);
  if (target) console.log(`may act as:  ${target}`);
  if (group) console.log(`group:       ${group}`);
  console.log("");

  // 1. The control: the credential itself works. A refusal below means nothing
  //    until this one holds.
  const own = await open(basic(master, password));
  record(
    "the master's own credential opens a session",
    classify(own),
    "opened a session",
  );
  note("the session's username", own.username ?? "(absent)");
  if (classify(own) !== "opened a session") {
    note("why nothing else was asked", `the session call answered: ${own.detail}`);
    return report({
    where:
      "in the owed note in the `gilbert-stalwart` skill and beside `impersonateAs` in\n" +
      "server/src/agentAdmin.ts",
  });
  }

  // 2. The refusal the code depends on.
  const refused = await open(composite(absent));
  record(`a composite naming ${absent} is refused`, classify(refused), [
    "refused with HTTP 401",
    "refused with HTTP 403",
  ]);
  note("what the refusal answered", `${refused.status}: ${refused.detail}`);

  // 3. The control that makes question 2 a refusal rather than a broken shape.
  if (target) {
    const acting = await open(composite(target));
    const same = (a, b) =>
      typeof a === "string" &&
      typeof b === "string" &&
      a.trim().toLowerCase() === b.trim().toLowerCase();
    record(
      "a composite naming an account the master may act as opens a session as it",
      same(acting.username, target)
        ? "opened as the target"
        : acting.session
          ? `opened as ${acting.username ?? "(an unnamed principal)"}`
          : classify(acting),
      "opened as the target",
    );
  } else {
    note(
      "a composite naming an account the master may act as",
      "not asked (GILBERT_PROBE_TARGET is unset): a refusal in the question above " +
        "cannot be told apart from a master that holds no impersonation right, or " +
        "from a composite shape the server does not accept at all",
    );
  }

  // 4. Groups have no credential of their own, so a group target is refused.
  if (group) {
    const asGroup = await open(composite(group));
    record(`a composite naming the group ${group} is refused`, classify(asGroup), [
      "refused with HTTP 401",
      "refused with HTTP 403",
    ]);
  } else {
    note(
      "a group mailbox target",
      "not asked (GILBERT_PROBE_GROUP_ADDRESS is unset): that a group has no " +
        "impersonation credential is assumed live-verified 2026-09-09 and is exactly " +
        "what a group report keeps its refusal in reach with — probe it before " +
        "trusting the group surfaces to a new server version",
    );
  }

  // A composite whose target is the master itself: the code never builds one,
  // and Stalwart drops the master rather than refusing — recorded so a reader
  // reading "refused" above knows which shape it is a refusal *of*.
  const self = await open(composite(master));
  note("a composite naming the master as its own target", classify(self));

  return report({
    where:
      "in the owed note in the `gilbert-stalwart` skill and beside `impersonateAs` in\n" +
      "server/src/agentAdmin.ts",
  });
};

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      `the probe could not finish: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
