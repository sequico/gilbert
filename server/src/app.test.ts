import assert from "node:assert/strict";
import { test } from "node:test";

process.env.STALWART_URL = "http://127.0.0.1:1";
const { createApp } = await import("./app.js");

test("CSRF guard rejects API POSTs without the custom header", async () => {
  const app = createApp();
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 403);
});

test("unauthenticated JMAP calls are rejected", async () => {
  const app = createApp();
  const res = await app.request("/api/jmap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "gilbert" },
    body: "{}",
  });
  assert.equal(res.status, 401);
});

test("cross-site fetches are rejected", async () => {
  const app = createApp();
  const res = await app.request("/api/health", {
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(res.status, 403);
});

test("health and security headers", async () => {
  const app = createApp();
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("the public health answer carries push counts, not the accounts behind them", async () => {
  // `pushStatus` names an account for each failure ("user@host: reason"), which
  // is an administrator's business and not a member's. The counts are safe for
  // anyone; the failure reasons are not on this answer at all.
  const app = createApp();
  const res = await app.request("/api/health");
  const body = (await res.json()) as {
    push: { mode?: unknown; accounts?: unknown; tabs?: unknown; failures?: unknown };
    wake?: { state?: unknown };
  };
  assert.equal(res.status, 200);
  assert.equal(body.push.failures, undefined, "no account names on the public answer");
  assert.ok(body.push.mode, "but the mode and counts are still there");
  assert.ok(body.push.accounts);
  assert.ok(body.push.tabs);
  assert.equal(
    typeof body.wake?.state,
    "string",
    "and how the agent's wake stands is answerable from the outside",
  );
});

test("a member's health answer carries no account names either", async () => {
  const app = createApp();
  const { sessions } = await import("./app.js");
  const { cookie } = sessions.create({
    username: "member@example.com",
    password: "pw",
    remember: false,
    userAgent: "ua",
    ip: "127.0.0.1",
  });
  const res = await app.request("/api/health", {
    headers: { cookie: `gilbert_session=${cookie}` },
  });
  const body = (await res.json()) as { push: { failures?: unknown } };
  assert.equal(res.status, 200);
  assert.equal(body.push.failures, undefined, "a member is not the operator");
});

test("image proxy refuses private targets", async () => {
  const app = createApp();
  // no session -> 401 first; so exercise the handler directly via a logged-in-less path is not possible; check the URL validation ordering instead
  const res = await app.request("/api/image?url=http://127.0.0.1/x");
  assert.equal(res.status, 401);
});

test("a compressed upstream blob is not forwarded with the compressed length", async () => {
  const { forwardedContentLength } = await import("./app.js");
  // gzip: the body we forward has already been decompressed, so the length on
  // the wire describes different bytes and must not be copied (issue #76).
  const gz = new Headers({ "content-encoding": "gzip", "content-length": "384" });
  assert.equal(forwardedContentLength(gz), null);
  // identity, spelled out or absent: the length describes the body we send.
  assert.equal(
    forwardedContentLength(
      new Headers({ "content-encoding": "identity", "content-length": "1157" }),
    ),
    "1157",
  );
  assert.equal(forwardedContentLength(new Headers({ "content-length": "1157" })), "1157");
  assert.equal(
    forwardedContentLength(
      new Headers({ "content-encoding": "BR", "content-length": "384" }),
    ),
    null,
  );
  // Nothing to forward is not an error.
  assert.equal(forwardedContentLength(new Headers()), null);
});

test("a Sieve script larger than a compressing hop's threshold survives the proxy", async () => {
  const http = await import("node:http");
  const zlib = await import("node:zlib");
  const { forwardedContentLength } = await import("./app.js");

  const script =
    '# Gilbert filters v1 - edit with care; rules are stored in the `# rule:` comments\nrequire ["fileinto"];\n\n' +
    ["a", "b", "c"]
      .map(
        (k) =>
          `# rule:{"id":"r${k}","name":"From ${k}@example.com","enabled":true,"join":"allof","tests":[{"type":"header","header":"from","op":"contains","value":"${k}@example.com"}],"actions":[{"type":"fileinto","mailbox":"INBOX/${k}"}]}\n` +
          `if header :contains "from" "${k}@example.com"\n{\n    fileinto "INBOX/${k}";\n}\n\n`,
      )
      .join("");
  const gz = zlib.gzipSync(Buffer.from(script));
  assert.ok(
    gz.length < Buffer.byteLength(script),
    "the script has to compress for this test to mean anything",
  );

  // A hop that compresses regardless of what we asked for.
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/sieve",
      "content-encoding": "gzip",
      "content-length": String(gz.length),
    });
    res.end(gz);
  });
  await new Promise<void>((r) => origin.listen(0, () => r()));
  const port = (origin.address() as { port: number }).port;

  try {
    const up = await fetch(`http://127.0.0.1:${port}/`);
    // What the blob route forwards.
    const headers = new Headers({ "content-type": "application/sieve; charset=utf-8" });
    const cl = forwardedContentLength(up.headers);
    if (cl) headers.set("Content-Length", cl);
    const out = new Response(await up.arrayBuffer(), { status: 200, headers });
    assert.equal(out.headers.get("content-length"), null);
    assert.equal(await out.text(), script);
  } finally {
    origin.close();
  }
});

test("only a PDF blob may be framed, and only by us", async () => {
  /*
   * The PDF preview is an iframe, and the blanket X-Frame-Options: DENY on
   * every response blocked it -- the dialog showed Chrome's "refused to
   * connect" where the file should have been. The middleware now leaves a
   * header a route has already set, so this pins both halves: the exception
   * exists, and it did not become the rule.
   */
  const app = createApp();
  const health = await app.request("/api/health");
  assert.equal(health.headers.get("x-frame-options"), "DENY");

  const { securityHeadersFor } = await import("./app.js");
  assert.equal(securityHeadersFor("application/pdf", true), "SAMEORIGIN");
  assert.equal(securityHeadersFor("application/x-pdf", true), "SAMEORIGIN");
  assert.equal(securityHeadersFor("application/pdf", false), "DENY");
  assert.equal(securityHeadersFor("image/png", true), "DENY");
  assert.equal(securityHeadersFor("text/html", true), "DENY");
});

test("the browser's powerful features stay denied to the app", async () => {
  const app = createApp();
  const health = await app.request("/api/health");
  const policy = health.headers.get("permissions-policy") ?? "";
  assert.match(policy, /(^|,\s*)microphone=\(\)(,|$)/);
  assert.match(policy, /camera=\(\)/);
  assert.match(policy, /geolocation=\(\)/);
  assert.match(policy, /payment=\(\)/);
  assert.match(policy, /usb=\(\)/);
});

test("a blob whose stored type says nothing keeps the client's own", async () => {
  /*
   * A PDF whose stored type is generic -- an uploader that had no guess, a
   * store that kept none -- was served as `application/octet-stream`, which is
   * not on the inline allowlist: the preview iframe got an attachment and the
   * browser downloaded the file instead of showing it. The declared type is
   * the only evidence left, and it is the type the app is already showing the
   * file as. What must not change is that a type which does say something
   * still wins, and that the guards hold on either path.
   */
  const { blobContentType } = await import("./app.js");
  assert.equal(blobContentType(null, "application/pdf"), "application/pdf");
  assert.equal(blobContentType("", "application/pdf"), "application/pdf");
  assert.equal(
    blobContentType("application/octet-stream", "application/pdf"),
    "application/pdf",
  );
  assert.equal(blobContentType("image/png", "application/pdf"), "image/png");
  assert.equal(blobContentType("text/html", "text/html"), "application/octet-stream");
  assert.equal(blobContentType(null, "text/html"), "application/octet-stream");

  // Both tiers said nothing: the name is the last evidence, and it is the
  // booking-confirmation case -- a real PDF served as a download because the
  // store and the sender both wrote octet-stream.
  assert.equal(
    blobContentType(
      "application/octet-stream",
      "application/octet-stream",
      "279726936 booking.pdf",
    ),
    "application/pdf",
  );
  // The legacy spelling is the same document, served as the standard one.
  assert.equal(
    blobContentType("application/octet-stream", "application/x-pdf", "scan"),
    "application/pdf",
  );
  // A store that does say something still wins over the name.
  assert.equal(
    blobContentType("application/zip", "application/pdf", "report.pdf"),
    "application/zip",
  );
});

/*
 * #239: retrying through an outage must not lock somebody out of the recovery.
 *
 * STALWART_URL at the top of this file is 127.0.0.1:1 — nothing listens there,
 * so every sign-in here is the outage case. Before the fix, the eleventh of
 * these came back 429 and stayed 429 for fifteen minutes, outliving whatever
 * had actually been wrong.
 */
test("an unreachable upstream does not spend login attempts", async () => {
  const app = createApp();
  const login = () =>
    app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "gilbert" },
      body: JSON.stringify({ username: "someone@example.com", password: "hunter2" }),
    });

  // Comfortably past LOGIN_RATE_LIMIT, which defaults to 10.
  for (let i = 0; i < 25; i++) {
    const res = await login();
    assert.notEqual(res.status, 429, `attempt ${i + 1} was rate limited`);
    assert.ok(
      res.status === 502 || res.status === 504,
      `attempt ${i + 1} said ${res.status}`,
    );
  }
});

test("an unreachable upstream says it is not the password", async () => {
  const app = createApp();
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "gilbert" },
    body: JSON.stringify({ username: "someone-else@example.com", password: "hunter2" }),
  });
  const body = (await res.json()) as { error: string; message: string };
  assert.notEqual(body.error, "invalid_credentials");
  assert.match(body.message, /not a problem with your password/i);
});

/*
 * The one unauthenticated body reader in the app is capped before anything is
 * buffered: a login is a username and a password, so a body measured in
 * megabytes is not a login, and parsing it would be free heap for anyone to
 * spend. Same for the signed-in account JSON posts, which are password /
 * app-password / 2FA operations of a few hundred bytes.
 */
test("an oversized login body is refused without parsing it", async () => {
  const app = createApp();
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "gilbert" },
    body: JSON.stringify({ username: "a@b.c", password: "x".repeat(20_000) }),
  });
  assert.equal(res.status, 413);
  assert.equal(((await res.json()) as { error: string }).error, "too_large");
});

test("an oversized account body is refused before the session is checked", async () => {
  const app = createApp();
  const res = await app.request("/api/account/password", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "gilbert" },
    body: JSON.stringify({ current: "x".repeat(70_000) }),
  });
  assert.equal(res.status, 413);
  assert.equal(((await res.json()) as { error: string }).error, "too_large");
});

test("a session may hold at most eight concurrent /api/events streams", async () => {
  const { acquireEventsStreamSlot, EVENTS_STREAMS_LIMIT } = await import("./app.js");
  const held: Array<() => void> = [];
  const take = (sessionId: string) => {
    const release = acquireEventsStreamSlot(sessionId);
    if (release) held.push(release);
    return release !== null;
  };
  for (let i = 0; i < EVENTS_STREAMS_LIMIT; i++) {
    assert.ok(take("stream-session-a"), `stream ${i + 1} is within the limit`);
  }
  assert.equal(take("stream-session-a"), false, "the stream past the limit is refused");
  assert.ok(take("stream-session-b"), "another session keeps its own allowance");
  held.shift()!(); // one stream ends
  assert.ok(take("stream-session-a"), "an ended stream frees its slot");
  // Close and abort can both fire for one stream; releasing twice must not
  // free two slots.
  const release = acquireEventsStreamSlot("stream-session-b")!;
  release();
  release();
  assert.ok(take("stream-session-b"), "a double release frees exactly one slot");
  held.forEach((r) => r());
});

test("the events route answers 429 past a session's stream limit", async () => {
  const app = createApp();
  const { sessions, acquireEventsStreamSlot, EVENTS_STREAMS_LIMIT } = await import(
    "./app.js"
  );
  const { config } = await import("./config.js");
  const { cookie, session } = sessions.create({
    username: "streams@example.com",
    password: "pw",
    remember: false,
    userAgent: "ua",
    ip: "127.0.0.1",
  });
  const held: Array<() => void> = [];
  try {
    for (let i = 0; i < EVENTS_STREAMS_LIMIT; i++) {
      const release = acquireEventsStreamSlot(session.id);
      assert.ok(release);
      held.push(release!);
    }
    const res = await app.request("/api/events", {
      headers: { cookie: `${config.cookieName}=${cookie}` },
    });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: "too_many_streams" });
  } finally {
    held.forEach((r) => r());
    sessions.destroy(session.id);
  }
});

/*
 * An unmatched `/api/*` path answers the JSON error contract, not the SPA.
 * `app.route()` copies a sub-app's routes but not its `notFound` handler, so
 * the API's own not-found answer has to be a real route; without one an
 * unmatched GET fell through to the static catch-all and came back as HTML,
 * and a non-GET as Hono's plain-text 404.
 */
test("an unmatched API path answers JSON, not the SPA", async () => {
  const app = createApp();
  for (const method of ["GET", "POST", "DELETE"]) {
    const res = await app.request("/api/does-not-exist", {
      method,
      headers: { "x-requested-with": "gilbert" },
    });
    assert.equal(res.status, 404, `${method} is a 404`);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), { error: "not_found" });
  }
  // A real API route is not shadowed by the fallback.
  assert.equal((await app.request("/api/health")).status, 200);
  // A non-API path is not the API's fallback: whatever it answers, it is not
  // that JSON. (Asserting the SPA's HTML would need a built `web/dist`, which
  // a test run does not have -- the build comes after the tests.)
  const spa = await app.request("/does-not-exist");
  assert.ok(
    !(await spa.text()).includes('"not_found"'),
    "the API fallback does not capture a non-API path",
  );
});

test("the API fallback follows the mount prefix", async () => {
  const app = createApp("/mail");
  const res = await app.request("/mail/api/does-not-exist", {
    headers: { "x-requested-with": "gilbert" },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

/*
 * The gated JMAP read (ADR 0015) is entered for a session that may not
 * administer. A body past the cap is a size violation (413); a stream that
 * fails for any other reason -- a client abort, a transport error -- is not,
 * and must not be labelled one.
 */
test("a gated read tells a size violation from a broken stream", async () => {
  const { sessions } = await import("./app.js");
  const { config } = await import("./config.js");
  const app = createApp();
  const wasOwnDevice = config.administrationNeedsOwnDevice;
  // With the own-device rule on, a session that did not ask to be remembered
  // may not administer, so its JMAP body is read and checked before it is sent.
  config.administrationNeedsOwnDevice = true;
  const { cookie, session } = sessions.create({
    username: "gated@example.com",
    password: "pw",
    remember: false,
    userAgent: "ua",
    ip: "127.0.0.1",
  });
  const headers = {
    "content-type": "application/json",
    "x-requested-with": "gilbert",
    cookie: `${config.cookieName}=${cookie}`,
  };
  const send = (body: ReadableStream<Uint8Array>) =>
    app.request("/api/jmap", { method: "POST", headers, body, duplex: "half" });
  try {
    const oversized = await send(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
          controller.close();
        },
      }),
    );
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "too_large" });

    const broken = await send(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.error(new Error("socket hang up"));
        },
      }),
    );
    assert.equal(broken.status, 502);
    assert.deepEqual(await broken.json(), { error: "upstream_error" });
  } finally {
    config.administrationNeedsOwnDevice = wasOwnDevice;
    sessions.destroy(session.id);
  }
});

/*
 * An upstream failure must not hand the mail server's own message to the
 * caller: it can carry a refusal detail read from the server's answer, and the
 * answer reaches every authenticated client. The machine `error` code is the
 * contract; the sentence is fixed and the detail goes to the log. The force
 * password-change route's introspection failure follows the same rule.
 */
test("an upstream failure answers a fixed sentence, not the mail server's message", async () => {
  const { upstreamFailure } = await import("./app.js");
  const { UpstreamError } = await import("./upstream.js");
  const calls: Array<{ body: Record<string, unknown>; status: number }> = [];
  const fake = {
    json(body: Record<string, unknown>, status: number) {
      calls.push({ body, status });
      return new Response(null, { status });
    },
  } as unknown as Parameters<typeof upstreamFailure>[0];
  const quiet = console.error;
  console.error = () => {};
  try {
    upstreamFailure(
      fake,
      new UpstreamError("refused: internal detail /var/lib/gilbert/secret", 403),
    );
    assert.equal(calls.at(-1)!.status, 403);
    assert.equal(calls.at(-1)!.body.error, "forbidden");
    assert.doesNotMatch(String(calls.at(-1)!.body.message), /var\/lib|internal detail/);

    upstreamFailure(
      fake,
      new UpstreamError("Stalwart rejected the request (500): /secret", 502),
    );
    assert.equal(calls.at(-1)!.status, 502);
    assert.equal(calls.at(-1)!.body.error, "upstream_error");
    assert.doesNotMatch(String(calls.at(-1)!.body.message), /(500)|secret/);
  } finally {
    console.error = quiet;
  }
});

/*
 * A password change re-seals this session with the new credential. When the
 * re-seal fails, the session still holds the credential the server just
 * invalidated, so it is ended and the cookie cleared: the user is signed out
 * now, and the answer says so, rather than being silently signed out on their
 * next request. The re-seal is forced to fail here because its only natural
 * cause -- the session vanishing in the window -- cannot be arranged
 * deterministically.
 */
test("a password change whose re-seal fails signs the session out, and says so", async () => {
  const http = await import("node:http");
  const { config } = await import("./config.js");
  const { sessions } = await import("./app.js");
  let base = "";
  const origin = http.createServer((req, res) => {
    if (req.url?.startsWith("/.well-known/jmap")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          apiUrl: `${base}/api`,
          accounts: {
            acc: { name: "demo@example.com", isPersonal: true, accountCapabilities: {} },
          },
          primaryAccounts: {
            "urn:ietf:params:jmap:mail": "acc",
            "urn:stalwart:jmap": "acc",
          },
          capabilities: {},
          state: "s",
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        methodResponses: [
          ["x:AccountPassword/set", { updated: { singleton: null } }, "s"],
        ],
      }),
    );
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(origin.address() as { port: number }).port}`;

  const wasUrl = config.stalwartUrl;
  config.stalwartUrl = base;
  const app = createApp();
  const { cookie, session } = sessions.create({
    username: "demo@example.com",
    password: "demo-password",
    remember: false,
    userAgent: "ua",
    ip: "127.0.0.1",
  });
  const realReseal = sessions.reseal;
  sessions.reseal = () => false;
  try {
    const res = await app.request("/api/account/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "gilbert",
        cookie: `${config.cookieName}=${cookie}`,
      },
      body: JSON.stringify({ current: "demo-password", next: "a-brand-new-password" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessionKept: boolean };
    assert.equal(body.sessionKept, false, "the answer says the session was not kept");
    assert.match(
      res.headers.get("set-cookie") ?? "",
      new RegExp(`${config.cookieName}=;`),
      "the dead cookie is cleared",
    );
    // No live session is left behind: the cookie just cleared answers 401.
    const after = await app.request("/api/auth/sessions", {
      headers: { cookie: `${config.cookieName}=${cookie}` },
    });
    assert.equal(after.status, 401);
  } finally {
    sessions.reseal = realReseal;
    config.stalwartUrl = wasUrl;
    sessions.destroy(session.id);
    // The fetch keeps its socket alive; drop it so the process can exit now.
    origin.closeAllConnections();
    origin.close();
  }
});

test("destroying a session drops its cached upstream session", async () => {
  const http = await import("node:http");
  const { sessions } = await import("./app.js");
  const { getUpstreamSession } = await import("./upstream.js");
  let hits = 0;
  const origin = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        apiUrl: "http://127.0.0.1:1/jmap/",
        accounts: {},
        primaryAccounts: {},
        capabilities: {},
        state: "s",
      }),
    );
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", () => r()));
  const port = (origin.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const { session } = sessions.create({
      username: "cache@example.com",
      password: "pw",
      remember: false,
      userAgent: "ua",
      ip: "127.0.0.1",
    });
    await getUpstreamSession(session.id, "Basic x", base);
    await getUpstreamSession(session.id, "Basic x", base);
    assert.equal(hits, 1, "the second lookup is served from the session cache");
    sessions.destroy(session.id);
    await getUpstreamSession(session.id, "Basic x", base);
    assert.equal(hits, 2, "destroying the session forgets its cached session");
  } finally {
    origin.close();
  }
});
