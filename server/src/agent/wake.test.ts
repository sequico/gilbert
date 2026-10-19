import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startAgentWake } from "./wake.js";

/** Wait for a condition, up to a deadline; the stream is real async I/O. */
async function until(what: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out waiting for the wake stream");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the agent's own stream wakes it, ignores pings, and reopens when it drops", async (t) => {
  /*
   * The wake is one connection from this server to Stalwart — no browser, no
   * callback origin. A `state` frame is a pass; a ping is not; a stream that
   * ends is opened again.
   */
  let connections = 0;
  const seen: URL[] = [];
  let endsFirst: (() => void) | null = null;
  const server: Server = createServer((req, res) => {
    connections += 1;
    seen.push(new URL(req.url ?? "/", "http://127.0.0.1"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: ping\ndata: {"interval": 30}\n\n');
    res.write('event: state\ndata: {"@type":"StateChange"}\n\n');
    if (connections === 1) {
      // The first stream ends: the client has to come back.
      setTimeout(() => res.end(), 20);
    } else {
      endsFirst = () => res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => {
    endsFirst?.();
    server.close();
  });

  let wakes = 0;
  const stop = startAgentWake(
    {
      eventSourceUrl: `http://127.0.0.1:${port}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
      baseUrl: `http://127.0.0.1:${port}`,
      authorization: "Basic test",
    },
    () => {
      wakes += 1;
    },
    { retryMs: 20 },
  );
  t.after(stop);

  await until(() => wakes >= 2);
  assert.ok(connections >= 2, "the stream was re-opened after it ended");
  // Let a ping-only frame arrive; it must not add a wake.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(wakes, 2, "one pass per state frame, and a ping is not one");

  const first = seen[0];
  assert.equal(first?.searchParams.get("types"), "Email,FileNode");
  assert.equal(first?.searchParams.get("closeafter"), "no");
  assert.equal(first?.searchParams.get("ping"), "30");
});

test("a frame that never ends is dropped rather than buffered for ever", async (t) => {
  let connections = 0;
  const server = createServer((_req, res) => {
    connections += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    // More than the cap, with no blank line: not a frame, and not an excuse to
    // grow the buffer.
    res.write("x".repeat((1 << 20) + 1_024));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => server.close());

  let wakes = 0;
  const stop = startAgentWake(
    {
      eventSourceUrl: `http://127.0.0.1:${port}/events`,
      baseUrl: `http://127.0.0.1:${port}`,
      authorization: "Basic test",
    },
    () => {
      wakes += 1;
    },
    { retryMs: 20 },
  );
  t.after(stop);

  await until(() => connections >= 2);
  assert.equal(wakes, 0, "a frame that never ends is not a pass");
});

test("a connect that never answers gives up and tries again", async (t) => {
  let connections = 0;
  const server = createServer(() => {
    connections += 1;
    // Headers never arrive: the stream is not open.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => server.close());

  const stop = startAgentWake(
    {
      eventSourceUrl: `http://127.0.0.1:${port}/events`,
      baseUrl: `http://127.0.0.1:${port}`,
      authorization: "Basic test",
    },
    () => {},
    { retryMs: 20, connectMs: 20 },
  );
  t.after(stop);

  await until(() => connections >= 2);
  assert.ok(connections >= 2, "the connect timed out and the stream was opened again");
});
