import assert from "node:assert/strict";
import { test } from "node:test";

process.env.STALWART_URL = "http://127.0.0.1:1";
// Short enough to reach inside a mocked clock; the sweep's own cadence is 60 s.
process.env.SESSION_TTL = "60";
const { createApp, sessions } = await import("./app.js");

/**
 * The in-memory store a process with no Master serves from is initialised
 * where it is bound (`bindSessions`), so the sweep runs as well as the store.
 *
 * Without that, an expired record was removed only when its cookie was
 * presented again — and `onDestroy`, which releases the upstream session and
 * info caches, never ran for the records nobody came back with. The sweep is
 * the only thing that removes them, so this drives its interval rather than
 * calling it.
 */
test("the in-memory store's expiry sweep runs with no cookie presented", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  // Where a process that names no Master binds the in-memory store.
  createApp();
  const { session } = sessions.create({
    username: "sweep@example.com",
    password: "secret",
    remember: false,
    userAgent: "",
    ip: "127.0.0.1",
  });
  assert.equal(sessions.listForUser(session.account).length, 1);

  t.mock.timers.tick(61_000);

  assert.equal(
    sessions.listForUser(session.account).length,
    0,
    "the sweep removed the record without its cookie ever being presented again",
  );
  t.mock.timers.reset();
});
