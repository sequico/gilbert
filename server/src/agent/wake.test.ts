import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * Push as the wake-up and polling as the fallback (ADR 0003 §3).
 *
 * `parseSseChunk` is pure, so the framing is tested directly — including the
 * case that matters most, a chunk boundary landing in the middle of a frame.
 * The stream itself is opened against the mock's own EventSource, which
 * announces FileNode state changes the way a real 0.16 server does; the mock
 * pings only after a whole interval, so the test keeps writing until the
 * connection is provably up rather than guessing when it opened.
 */

const PORT = 18848;
process.env.MOCK_PORT = String(PORT);

const mock = await import("../mock/index.js");
const { writeAppFileAt } = await import("../appFolder.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { openEventStream, parseSseChunk, pollLoop } = await import("./wake.js");

const BASE = `http://127.0.0.1:${PORT}`;
const GROUP = "a3";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;

const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a complete frame is an event and leaves no tail", () => {
  const parsed = parseSseChunk('event: state\ndata: {"@type":"StateChange"}\n\n');
  assert.deepEqual(parsed.events, [{ event: "state", data: '{"@type":"StateChange"}' }]);
  assert.equal(parsed.rest, "");
});

test("a frame split across chunks is completed by the next one", () => {
  const first = parseSseChunk('event: state\ndata: {"@type":"Sta');
  assert.deepEqual(first.events, [], "no event until the frame is whole");
  assert.equal(first.rest, 'event: state\ndata: {"@type":"Sta');
  const second = parseSseChunk(`${first.rest}teChange"}\n\n`);
  assert.deepEqual(second.events, [{ event: "state", data: '{"@type":"StateChange"}' }]);
  assert.equal(second.rest, "");
});

test("several frames in one chunk all come out, and CRLF is accepted", () => {
  const parsed = parseSseChunk(
    'event: ping\r\ndata: {"interval": 30}\r\n\r\nevent: state\r\ndata: {"a":1}\r\n\r\n',
  );
  assert.deepEqual(parsed.events, [
    { event: "ping", data: '{"interval": 30}' },
    { event: "state", data: '{"a":1}' },
  ]);
});

test("a comment, a nameless frame and multi-line data follow the spec", () => {
  const parsed = parseSseChunk(": keep-alive\ndata: one\ndata: two\n\ndata: three\n\n");
  assert.deepEqual(parsed.events, [
    { event: "message", data: "one\ntwo" },
    { event: "message", data: "three" },
  ]);
});

test("the agent's stream reports the account and type a change names", async () => {
  const events: string[] = [];
  const errors: string[] = [];
  const stop = openEventStream(
    session,
    AUTH,
    ["FileNode"],
    (accountId, type) => events.push(`${accountId}:${type}`),
    (err) => errors.push(err.message),
  );
  // The connection is up when a write made after it is announced: keep writing
  // distinct nodes until one comes back through the stream.
  const deadline = Date.now() + 5_000;
  while (!events.length && Date.now() < deadline) {
    await writeAppFileAt(ctx, GROUP, `probe-${Date.now()}.json`, { at: Date.now() });
    await sleep(60);
  }
  stop();
  assert.ok(
    events.includes(`${GROUP}:FileNode`),
    `a FileNode change woke the stream (errors: ${errors.join("; ") || "none"})`,
  );
});

test("the poll loop ticks, keeps going through a failing tick, and stops", async () => {
  let ticks = 0;
  const stop = pollLoop(15, async () => {
    ticks += 1;
    if (ticks === 1) throw new Error("a tick that failed");
  });
  await sleep(100);
  stop();
  const seen = ticks;
  assert.ok(seen >= 2, `the loop carries on after a failing tick (${seen} ticks)`);
  await sleep(60);
  assert.equal(ticks, seen, "the disposer stops the loop");
});

test("a tick slower than the interval never overlaps itself", async () => {
  let running = 0;
  let most = 0;
  const stop = pollLoop(5, async () => {
    running += 1;
    most = Math.max(most, running);
    await sleep(30);
    running -= 1;
  });
  await sleep(120);
  stop();
  assert.equal(most, 1, "one pass at a time, whatever the interval says");
});

test("a tick that throws is reported, not swallowed", async () => {
  // The loop keeps its interval after a failed tick — and says what happened.
  // A loop that swallows is how one unreadable document ends the round for
  // every account behind it without a line in the log (resolution 18).
  const seen: unknown[] = [];
  const stop = pollLoop(
    5,
    async () => {
      throw new Error("the claim document could not be read");
    },
    { onError: (err) => seen.push(err) },
  );
  await sleep(120);
  stop();
  assert.ok(seen.length > 0, "the caller heard about it");
  assert.match(String((seen[0] as Error).message), /could not be read/);
});
