import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { JmapClient, JmapResult } from "./jmap.js";
import { UpstreamError, type UpstreamSession } from "./upstream.js";

/**
 * The server tier's JMAP reader: what it answers when a response is absent, and
 * what a refused download says.
 *
 * Two things callers depend on, and both were once answered the same as an
 * empty or credential-shaped result: a `/get` whose response is **absent** must
 * not read as "the account holds nothing" (the caller is usually about to
 * create what it could not find), and a download refused for **permission**
 * must not read as bad credentials -- the browser turns a 401 into a sign-out.
 * The downloads answer from a bare http server of this file's own making, so
 * the status is the question rather than a fixture's.
 */

test("a list whose response is absent throws rather than reading as empty", () => {
  const result = new JmapResult([["FileNode/get", { list: [] }, "other"]]);
  assert.throws(
    () => result.list("g"),
    (err: unknown) => err instanceof Error && /no response for g/.test(err.message),
  );
});

test("a list whose response errored is not an empty list", () => {
  const result = new JmapResult([
    ["error", { type: "serverFail", description: "no" }, "g"],
  ]);
  assert.throws(() => result.list("g"), /refused the call/);
});

let server: Server;
let origin = "";

before(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/forbidden")) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (req.url?.startsWith("/denied")) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

/** A session whose download path lands on the route this file serves. */
function sessionAt(path: string): UpstreamSession {
  return {
    capabilities: {},
    accounts: {},
    primaryAccounts: {},
    username: "demo@example.com",
    apiUrl: `${origin}/jmap`,
    downloadUrl: `${origin}${path}/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${origin}/upload/{accountId}`,
    eventSourceUrl: `${origin}/events`,
    state: "0",
    baseUrl: origin,
  };
}

test("a download refused for permission is a 403, not 'invalid credentials'", async () => {
  const client = new JmapClient({
    authorization: "Basic x",
    session: sessionAt("/forbidden"),
  });
  await assert.rejects(
    () => client.downloadBlob("a1", "b1", "f.txt", "text/plain"),
    (err: unknown) =>
      err instanceof UpstreamError &&
      err.status === 403 &&
      /refused this download/.test(err.message),
  );
});

test("a download refused for credentials stays a 401", async () => {
  const client = new JmapClient({
    authorization: "Basic x",
    session: sessionAt("/denied"),
  });
  await assert.rejects(
    () => client.downloadBlob("a1", "b1", "f.txt", "text/plain"),
    (err: unknown) => err instanceof UpstreamError && err.status === 401,
  );
});
