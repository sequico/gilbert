#!/usr/bin/env node
/**

 * The live probe of the directory read's paging (`server/src/upstream.ts`,
 * `fetchDirectoryPrincipals` and the two surfaces over it).
 *
 * The published installation policy fans out over exactly this read
 * (`/admin/policy`), and the Users surface lists what it returns. The mock
 * stands in for a 0.16 server and proves nothing about one: it serves the page
 * `position`/`limit` ask for and answers `total` when `calculateTotal` asks for
 * it because that is the shape the code assumes, and the assumption is
 * recorded as owed in `server/src/mock/directory-paging.test.ts` — a directory
 * of more than one page read with `position`/`limit` and again with
 * `calculateTotal` against a real server, a `limit` above what the server will
 * serve, and a closed directory gate. This script asks all of it.
 *
 * The questions, asked the way the code asks them:
 *
 *   1. is `Principal/query` accepted with `position`, `limit` and
 *      `calculateTotal` — the page size being the one `directoryBatch` works
 *      out from the session's own `maxObjectsInGet`?
 *   2. does the read reach the end of the directory: does the server report a
 *      `total` that stops it, or does the walk end on an empty page (one
 *      request later, and still complete)?
 *   3. is `position` honoured — is the page at position 2 not the page at
 *      position 0 again? A server that ignores it makes the read stop with
 *      `complete: false`, which the publish reports as an incomplete fan-out.
 *   4. does the walk at `limit: 2` gather the same ids as the walk at the
 *      code's own page size — the check that a reported `total` is the
 *      population and not the page, which is the answer that would otherwise
 *      make `complete: true` mean "the first page".
 *   5. is the page at the point the walk stops empty — the same question asked
 *      of the stop rule itself.
 *   6. does `Principal/get` answer the page's ids with the fields the read
 *      selects (`id`, `type`, `name`, `email`), and is `individual` the type a
 *      user account carries?
 *   7. (optional) what does a credential *outside* the directory gate get — the
 *      refusal the code reads as `denied`, or something it would not read as
 *      one? Give a second credential to settle it.
 *
 * Usage, against a real instance:
 *
 *   STALWART_URL=https://stalwart.example:8080 \
 *   GILBERT_AGENT_ADDRESS=gilbert@example.com \
 *   GILBERT_AGENT_PASSWORD='…' \
 *   node scripts/probe-directory-paging.mjs
 *
 * Optional:
 *
 *   GILBERT_PROBE_SESSION_URL    the session endpoint, when it is not
 *                                `$STALWART_URL/.well-known/jmap`
 *   GILBERT_PROBE_PLAIN_USER     a credential the directory gate does not
 *   GILBERT_PROBE_PLAIN_PASSWORD admit, for question 7
 *
 * It writes nothing to the server: every call is a read. It exits 0 when every
 * assumed behaviour holds, 1 when one does not or a question could not be
 * settled, and 2 when the environment does not say where to ask.
 */

import { basic, note, record, report } from "./lib/probeKit.mjs";

const base = (process.env.STALWART_URL ?? "").replace(/\/+$/, "");
const user = process.env.GILBERT_AGENT_ADDRESS ?? "";
const password = process.env.GILBERT_AGENT_PASSWORD ?? "";
const plainUser = process.env.GILBERT_PROBE_PLAIN_USER ?? "";
const plainPassword = process.env.GILBERT_PROBE_PLAIN_PASSWORD ?? "";

if (!base || !user || !password) {
  console.error(
    [
      "This probe asks a real server, so it needs the installation's own facts:",
      "  STALWART_URL             the instance, e.g. https://stalwart.example:8080",
      "  GILBERT_AGENT_ADDRESS    an account that may read the directory (a Stalwart",
      "                           administrator, or a principal the server grants",
      "                           allow_directory_query to)",
      "  GILBERT_AGENT_PASSWORD   its password",
      "",
      "Optional: GILBERT_PROBE_SESSION_URL, GILBERT_PROBE_PLAIN_USER,",
      "GILBERT_PROBE_PLAIN_PASSWORD (see the header of this file).",
    ].join("\n"),
  );
  process.exit(2);
}

/* The two capabilities the read names, and the page size it works out. */
const CORE = "urn:ietf:params:jmap:core";
const PRINCIPALS = "urn:ietf:params:jmap:principals";
/** `DIRECTORY_PAGE` in upstream.ts: the read's own ceiling on one page. */
const CODE_PAGE = 1000;
/** `DIRECTORY_MAX_PAGES` in upstream.ts: the read's own ceiling on one walk. */
const CODE_MAX_PAGES = 100;
/** How many pages the two-at-a-time cross-check may ask for (100 ids). */
const SMALL_LIMIT = 2;
const SMALL_MAX_PAGES = 50;
const TIMEOUT = 30_000;

const SESSION_URL = process.env.GILBERT_PROBE_SESSION_URL || `${base}/.well-known/jmap`;

/**
 * A refusal the code reads as `denied`: HTTP 400 or 403 on the whole request,
 * or a first method response that is not `Principal/query` (upstream.ts, `post`
 * and `method`). `shape` keeps the two apart for the report, since which one a
 * server sends is exactly what the mock cannot know.
 */
class DirectoryRefused extends Error {
  constructor(shape, detail) {
    super(detail);
    this.shape = shape;
  }
}

/** A failure the code does not read as a refusal: the read fails instead. */
class DirectoryFailed extends Error {}

/** The session call, classified the way `fetchUpstreamSession` classifies it. */
async function session(url, authorization) {
  const res = await fetch(url, {
    headers: { authorization, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 401 || res.status === 403)
    throw new DirectoryRefused(
      `HTTP ${res.status}`,
      "the session call refused this credential",
    );
  if (!res.ok) throw new DirectoryFailed(`the session call answered HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body.apiUrl !== "string")
    throw new DirectoryFailed("the session carries no apiUrl");
  return body;
}

/** The account the read asks, chosen the way `fetchDirectoryPrincipals` does. */
function principalsAccount(sessionBody) {
  const accounts = Object.entries(sessionBody.accounts ?? {});
  const withCap = accounts.filter(([, a]) => !!a?.accountCapabilities?.[PRINCIPALS]);
  const chosen = withCap.find(([, a]) => a?.isPersonal === true) ?? withCap[0];
  return { id: chosen?.[0] ?? accounts[0]?.[0] ?? null, advertising: withCap.length };
}

/** The page size the read asks with — `directoryBatch` in upstream.ts. */
function batchOf(sessionBody) {
  const core = sessionBody.capabilities?.[CORE] ?? {};
  const advertised = core.maxObjectsInGet;
  return typeof advertised === "number" && advertised > 0
    ? Math.min(CODE_PAGE, Math.trunc(advertised))
    : CODE_PAGE;
}

/**
 * The advertised apiUrl asked the way `absoluteUpstream` asks it: the path and
 * the query of the session's own URL, the scheme, host and port of the one the
 * operator configured.
 */
function pinned(url) {
  try {
    const advertised = new URL(url, base);
    const configured = new URL(base);
    configured.pathname = advertised.pathname;
    configured.search = advertised.search;
    configured.hash = "";
    return configured.toString();
  } catch {
    return url;
  }
}

/** One `Principal/query`, classified the way upstream.ts classifies the answer. */
async function query(apiUrl, authorization, accountId, params) {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      using: [CORE, PRINCIPALS],
      methodCalls: [["Principal/query", { accountId, ...params }, "q"]],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  const detail = `${text.slice(0, 300).replace(/\s+/g, " ")}`.trim();
  if (res.status === 400 || res.status === 403)
    throw new DirectoryRefused(`HTTP ${res.status}`, detail || "(an empty body)");
  if (!res.ok) throw new DirectoryFailed(`HTTP ${res.status}: ${detail}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new DirectoryFailed(`HTTP 200 that is not JSON: ${detail}`);
  }
  const call = (body.methodResponses ?? [])[0];
  if (!call) throw new DirectoryFailed("the answer carries no method response");
  if (call[0] !== "Principal/query")
    throw new DirectoryRefused(
      `a method call (${String(call[1]?.type ?? call[0])})`,
      detail || "(a refused method call)",
    );
  return call[1];
}

/**
 * The read itself: the loop `fetchDirectoryPrincipals` runs, with its own stop
 * rules — a reported total, an empty page, a page that does not advance, a page
 * budget. `at` is the position the read would ask next, so the check that the
 * page there is empty can be asked of the stop rule rather than of a guess.
 */
async function walk(apiUrl, authorization, accountId, limit, maxPages) {
  const ids = [];
  const seen = new Set();
  let position = 0;
  let total = null;
  let pages = 0;
  let stop = "the probe's own page budget";
  let at = null;
  let strings = true;
  let echoesPosition = null;
  for (let page = 0; page < maxPages; page++) {
    const body = await query(apiUrl, authorization, accountId, {
      position,
      limit,
      ...(page === 0 ? { calculateTotal: true } : {}),
    });
    pages++;
    if (page === 0) echoesPosition = typeof body.position === "number";
    if (!Array.isArray(body.ids))
      throw new DirectoryFailed("the answer carries no ids array");
    const pageIds = body.ids.filter((id) => typeof id === "string");
    if (pageIds.length !== body.ids.length) strings = false;
    if (typeof body.total === "number") total = body.total;
    for (const id of pageIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (!pageIds.length) {
      stop = "an empty page";
      at = position;
      break;
    }
    // Where the next page starts, exactly as the read works it out: the offset
    // the server says this page began at, plus the ids it sent.
    const next =
      (typeof body.position === "number" ? body.position : position) + pageIds.length;
    if (total !== null && ids.length >= total) {
      stop = "the total it reports";
      at = next;
      break;
    }
    if (next <= position) {
      stop = "a page that did not advance";
      break;
    }
    position = next;
    at = next;
  }
  return { ids, seen, total, pages, stop, at, strings, echoesPosition };
}

/** `Principal/get` for a page of ids, the way the read asks it. */
async function principalGet(apiUrl, authorization, accountId, ids, batch) {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      using: [CORE, PRINCIPALS],
      methodCalls: [
        [
          "Principal/get",
          {
            accountId,
            ids: ids.slice(0, batch),
            properties: ["id", "type", "name", "email"],
          },
          "g",
        ],
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  if (res.status === 400 || res.status === 403)
    throw new DirectoryRefused(
      `HTTP ${res.status}`,
      text.slice(0, 300).replace(/\s+/g, " "),
    );
  if (!res.ok) throw new DirectoryFailed(`Principal/get answered HTTP ${res.status}`);
  const call = (JSON.parse(text).methodResponses ?? [])[0];
  if (call?.[0] !== "Principal/get")
    throw new DirectoryRefused(
      `a method call (${String(call?.[1]?.type ?? call?.[0] ?? "none")})`,
      "Principal/get was refused",
    );
  return Array.isArray(call[1]?.list) ? call[1].list : [];
}

const run = async () => {
  const authorization = basic(user, password);
  const sessionBody = await session(SESSION_URL, authorization);
  const apiUrl = pinned(sessionBody.apiUrl);
  const account = principalsAccount(sessionBody);
  const batch = batchOf(sessionBody);
  const advertised = sessionBody.capabilities?.[CORE]?.maxObjectsInGet;

  console.log(`server:            ${base}`);
  console.log(`session:           ${SESSION_URL}`);
  console.log(`credential:        ${user}`);
  console.log(`apiUrl asked:      ${apiUrl}`);
  console.log(
    `directory account: ${account.id ?? "(none)"} — ${account.advertising} account(s) ` +
      `advertise ${PRINCIPALS}`,
  );
  console.log(
    `page size:         ${batch} (directoryBatch)${
      advertised === undefined
        ? " — the session advertises no maxObjectsInGet"
        : `, from maxObjectsInGet ${advertised}`
    }`,
  );
  console.log("");

  if (!account.id) {
    console.log(
      "No account advertises the principals capability, so the read asks nothing and\n" +
        "the question is not the server's: it is this session's. Ask with a credential\n" +
        "that carries it — the paging is still owed.",
    );
    return 1;
  }

  let read;
  try {
    read = await walk(apiUrl, authorization, account.id, batch, CODE_MAX_PAGES);
  } catch (err) {
    if (err instanceof DirectoryRefused) {
      record(
        "Principal/query is accepted with position, limit and calculateTotal",
        `refused with ${err.shape}`,
        "accepted",
      );
      note("what the refusal said", err.message || "(nothing)");
      report({ where: "in server/src/upstream.ts beside `fetchDirectoryPrincipals`" });
      console.log(
        "\nThe read is refused for this credential, so nothing about paging is settled.\n" +
          "Stalwart gates Principal/query behind `allow_directory_query` or the\n" +
          "JmapPrincipalQuery permission; ask again with a credential that has one of them.",
      );
      return 1;
    }
    throw err;
  }

  record(
    "Principal/query is accepted with position, limit and calculateTotal",
    "accepted",
    "accepted",
  );
  record("the read reaches the end of the directory", read.stop, [
    "the total it reports",
    "an empty page",
  ]);
  record(
    "the ids the query answers are strings",
    read.strings ? "strings" : "not all of them are strings",
    "strings",
  );
  note(
    "total (calculateTotal)",
    read.total === null ? "not reported" : `reported ${read.total}`,
  );
  note(
    "the walk",
    `${read.ids.length} id(s) over ${read.pages} page(s), stopped on ${read.stop}`,
  );
  note(
    "position echoed in the answer",
    read.echoesPosition === false
      ? "no"
      : read.echoesPosition === true
        ? "yes"
        : "not read",
  );

  // Question 3: is `position` honoured? Two pages at the same small limit say
  // so on any directory that holds anything at all: a server that ignores the
  // offset answers the first page twice.
  const firstSmall = await query(apiUrl, authorization, account.id, {
    position: 0,
    limit: SMALL_LIMIT,
  });
  const firstIds = Array.isArray(firstSmall.ids) ? firstSmall.ids : [];
  let smallWalk = null;
  if (!firstIds.length) {
    note("the server honours position", "the directory is empty: nothing to page");
  } else {
    const secondSmall = await query(apiUrl, authorization, account.id, {
      position: firstIds.length,
      limit: SMALL_LIMIT,
    });
    const secondIds = Array.isArray(secondSmall.ids) ? secondSmall.ids : [];
    const repeats = secondIds.length > 0 && secondIds.join(",") === firstIds.join(",");
    record(
      "the page at the next position is not the first page again",
      repeats ? "it repeats the first page" : "it advances",
      "it advances",
    );
    // Questions 2 and 4 via the small walk: the same directory at a different
    // page size, which is the only way to see whether a reported `total` is the
    // population and not the size of the page it was reported with.
    try {
      smallWalk = await walk(
        apiUrl,
        authorization,
        account.id,
        SMALL_LIMIT,
        SMALL_MAX_PAGES,
      );
    } catch (err) {
      if (!(err instanceof DirectoryRefused)) throw err;
      smallWalk = null;
      note("the walk at limit 2", `refused with ${err.shape} — the cross-check is owed`);
    }
  }
  if (smallWalk) {
    const sameIds =
      smallWalk.ids.length === read.ids.length &&
      smallWalk.ids.every((id, i) => id === read.ids[i]);
    if (smallWalk.stop === "the probe's own page budget") {
      note(
        `the walk at limit ${SMALL_LIMIT} reaching the end`,
        `no: ${SMALL_MAX_PAGES} pages returned ${smallWalk.ids.length} id(s), so the same-ids ` +
          "cross-check is owed on a directory this size",
      );
    } else {
      record(
        `the walk at limit ${SMALL_LIMIT} gathers the same ids as the walk at ${batch}`,
        sameIds ? "the same ids" : "different ids",
        "the same ids",
      );
      note(
        "the two walks",
        `limit ${SMALL_LIMIT}: ${smallWalk.ids.length} id(s) over ${smallWalk.pages} page(s), ` +
          `stopped on ${smallWalk.stop}; limit ${batch}: ${read.ids.length} id(s) over ` +
          `${read.pages} page(s), stopped on ${read.stop}`,
      );
    }
  }

  // Question 5: the page at the point the walk stopped is empty. This is the
  // invariant `complete: true` stands on. A directory that changes between the
  // two requests can make this report one extra account; reading the numbers is
  // what says whether that is what happened.
  if (read.at !== null) {
    const after = await query(apiUrl, authorization, account.id, {
      position: read.at,
      limit: batch,
    });
    const afterIds = Array.isArray(after.ids) ? after.ids : [];
    const unseen = afterIds.filter((id) => !read.seen.has(id));
    record(
      "the page at the point the walk stops is empty",
      afterIds.length === 0
        ? "empty"
        : `${afterIds.length} more id(s), ${unseen.length} of them id(s) the walk had not seen`,
      "empty",
    );
  } else {
    note(
      "the page at the point the walk stops",
      "not asked: the walk stopped on a page that did not advance (see question 2)",
    );
  }

  // Question 6: what the read selects on. `type: "individual"` is the claim
  // (source-checked against Stalwart's principal get), and the credential's own
  // account is the one principal whose type can be checked against something
  // known rather than assumed.
  let list = null;
  if (read.ids.length) {
    try {
      list = await principalGet(apiUrl, authorization, account.id, read.ids, batch);
      record("Principal/get answers the page's ids with a list", "answers", "answers");
    } catch (err) {
      if (!(err instanceof DirectoryRefused)) throw err;
      record(
        "Principal/get answers the page's ids with a list",
        `refused with ${err.shape}`,
        "answers",
      );
      note("what the refusal said", err.message || "(nothing)");
    }
  } else {
    note("Principal/get", "not asked: the directory answered no ids");
  }
  if (list) {
    const kinds = new Map();
    for (const principal of list) {
      const type = String(principal.type);
      kinds.set(type, (kinds.get(type) ?? 0) + 1);
    }
    const self = list.find(
      (p) =>
        String(p.email ?? "")
          .trim()
          .toLowerCase() === user.trim().toLowerCase(),
    );
    record(
      "the credential's own account is an individual in the directory",
      self
        ? self.type === "individual"
          ? "it is an individual"
          : `it is a ${String(self.type)}`
        : "it is not listed",
      "it is an individual",
    );
    note(
      "the types Principal/get answered",
      [...kinds].map(([type, count]) => `${type} ${count}`).join(", ") ||
        "(no principals)",
    );
  }

  // The `limit` above what the server will serve: it decides whether
  // `directoryBatch`'s ceiling (the advertised `maxObjectsInGet`) is enough.
  try {
    const large = await query(apiUrl, authorization, account.id, {
      position: 0,
      limit: batch * 10,
    });
    note(
      `a limit of ${batch * 10} (the read's own page size × 10)`,
      `${Array.isArray(large.ids) ? large.ids.length : 0} id(s) — the page was served`,
    );
  } catch (err) {
    if (!(err instanceof DirectoryRefused)) throw err;
    note(
      `a limit of ${batch * 10} (the read's own page size × 10)`,
      `refused with ${err.shape} — the read is safe only while the session advertises ` +
        "a maxObjectsInGet at or below what the server serves",
    );
  }

  // Question 7, the optional one: what a credential outside the gate gets. The
  // code reads HTTP 400/403 and a refused method call alike as `denied`; an
  // empty answer would be read as a directory with nobody in it.
  if (plainUser && plainPassword) {
    try {
      const plainSession = await session(SESSION_URL, basic(plainUser, plainPassword));
      const plainAccount = principalsAccount(plainSession);
      if (!plainAccount.id) {
        note(
          "a credential outside the gate",
          "its session advertises no principals account, so the read never asks: the " +
            "gate is not what stops it",
        );
      } else {
        try {
          const body = await query(
            pinned(plainSession.apiUrl),
            basic(plainUser, plainPassword),
            plainAccount.id,
            { position: 0, limit: batch, calculateTotal: true },
          );
          const ids = Array.isArray(body.ids) ? body.ids.length : 0;
          record(
            "a credential outside the directory gate is refused as the code reads a refusal",
            ids === 0
              ? "answered as if the directory were empty"
              : `the gate is open for it too (${ids} id(s))`,
            [
              "refused with HTTP 400",
              "refused with HTTP 403",
              "refused with a method call",
            ],
          );
          note(
            "what it answered",
            `${ids} id(s), total ${body.total ?? "not reported"}` +
              (ids === 0
                ? " — an empty answer is read as a directory with nobody in it, not as a refusal"
                : " — this credential is inside the gate as well, so give one the server does " +
                  "not admit to settle what a closed gate answers"),
          );
        } catch (err) {
          if (!(err instanceof DirectoryRefused)) throw err;
          record(
            "a credential outside the directory gate is refused as the code reads a refusal",
            `refused with ${err.shape}`,
            [
              "refused with HTTP 400",
              "refused with HTTP 403",
              "refused with a method call",
            ],
          );
          note("what the refusal said", err.message || "(nothing)");
        }
      }
    } catch (err) {
      if (!(err instanceof DirectoryRefused)) throw err;
      note(
        "a credential outside the gate",
        `it cannot open a session at all (refused with ${err.shape}), so the gate is not ` +
          "what the probe measured",
      );
    }
  } else {
    note(
      "a credential outside the directory gate",
      "not given (GILBERT_PROBE_PLAIN_USER, GILBERT_PROBE_PLAIN_PASSWORD): whether a " +
        "closed gate answers 400, 403, or one refused method call is still owed — " +
        "server/src/mock/index.ts, `directoryGate`",
    );
  }

  return report({
    where:
      "in the comment beside `fetchDirectoryPrincipals` in server/src/upstream.ts and in\n" +
      "server/src/mock/directory-paging.test.ts",
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
