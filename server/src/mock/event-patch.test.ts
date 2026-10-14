import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, jmapCall, responseOf } from "../testkit.js";

/**
 * A `CalendarEvent/set` update carries a JMAP patch whose keys are paths
 * (RFC 8620 §5.3), and the calendar store really sends a nested one for a
 * series: `participants/me/participationStatus` is how an invitation is
 * answered (see `web/src/store/calendar.ts`).
 *
 * A mock that kept the path as one literal key produced a shape a server never
 * does -- `{ participants: { "me/participationStatus": "accepted" } }` -- so a
 * client that only ever ran here looked correct and nothing else would. The
 * patch is applied through the same `applyPatch` every set uses, so this pins
 * the walk beside the simulation.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"];

const jmap = (methodCalls: unknown[]) => jmapCall(BASE, AUTH, USING, methodCalls);

/** Create one event whose `me` participant carries a status. */
async function createEvent(): Promise<string> {
  const created = await jmap([
    [
      "CalendarEvent/set",
      {
        accountId: ACCOUNT,
        create: {
          e: {
            "@type": "Event",
            uid: `patch-${Date.now()}`,
            title: "Standup",
            start: "2026-09-07T09:00:00",
            duration: "PT30M",
            participants: {
              me: {
                calendarAddress: "mailto:demo@example.com",
                roles: { attendee: true, required: true },
                participationStatus: "needs-action",
              },
            },
          },
        },
      },
      "c",
    ],
  ]);
  return (responseOf(created, "c")[1].created as Record<string, { id: string }>).e!.id;
}

async function readEvent(id: string): Promise<Record<string, unknown>> {
  const read = await jmap([
    ["CalendarEvent/get", { accountId: ACCOUNT, ids: [id] }, "g"],
  ]);
  return (responseOf(read, "g")[1].list as Array<Record<string, unknown>>)[0]!;
}

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a nested participant patch lands inside participants, not as one literal key", async () => {
  const id = await createEvent();

  const updated = await jmap([
    [
      "CalendarEvent/set",
      {
        accountId: ACCOUNT,
        update: { [id]: { "participants/me/participationStatus": "accepted" } },
      },
      "u",
    ],
  ]);
  assert.equal(responseOf(updated, "u")[0], "CalendarEvent/set");
  assert.deepEqual(responseOf(updated, "u")[1].updated, { [id]: null });

  const participants = (await readEvent(id)).participants as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(
    participants.me!.participationStatus,
    "accepted",
    "the nested status is set where a real server keeps it",
  );
  assert.equal(
    "me/participationStatus" in participants,
    false,
    "and not under a single flattened key",
  );
});

test("a null at a nested path removes the property there", async () => {
  const id = await createEvent();

  await jmap([
    [
      "CalendarEvent/set",
      {
        accountId: ACCOUNT,
        update: { [id]: { "participants/me/participationStatus": null } },
      },
      "u",
    ],
  ]);

  const participants = (await readEvent(id)).participants as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(
    "participationStatus" in participants.me!,
    false,
    "a null removes the nested property",
  );
});
