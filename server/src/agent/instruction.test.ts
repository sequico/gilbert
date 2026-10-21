/**
 * A group's standing instruction, against the mock Stalwart (ADR 0031).
 *
 * What is pinned here is the one mechanism the design rests on: the document a
 * group wrote is read from its own account and carried as the middle of the
 * three levels, and a document this build cannot read is refused with its path
 * rather than read as an instruction that says nothing.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  type Ctx,
  destroyAppNode,
  filesAccountId,
  readAppFileAt,
  writeAppBytesAt,
  writeAppFileAt,
} from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-instruction";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const {
  INSTRUCTION_FILE,
  INSTRUCTION_VERSION,
  InstructionError,
  parseInstructionDocumentDetailed,
  readInstruction,
} = await import("./instruction.js");

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;

let ctx: Ctx;
let accountId: string;

before(async () => {
  await waitForPort(BASE, AUTH);
  const session = await fetchUpstreamSession(AUTH, BASE);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  accountId = filesAccountId(ctx);
  assert.ok(accountId, "the demo account owns Files");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** The stored document taken out again, so a test leaves the account as it found it. */
async function removeStored(): Promise<void> {
  const found = await readAppFileAt(ctx, accountId, INSTRUCTION_FILE);
  const id = found?.file.id;
  if (typeof id === "string") await destroyAppNode(ctx, accountId, id, {});
}

test("a group's instruction is read from its own account, and no document is no level", async () => {
  await removeStored();
  assert.equal(
    await readInstruction(ctx, accountId),
    null,
    "a group that has written no instruction carries no middle level",
  );

  await writeAppFileAt(ctx, accountId, INSTRUCTION_FILE, {
    v: INSTRUCTION_VERSION,
    instruction: "Answer the shipper in the group's own words.",
    areas: ["mail", "files"],
  });
  assert.deepEqual(
    await readInstruction(ctx, accountId),
    {
      v: INSTRUCTION_VERSION,
      instruction: "Answer the shipper in the group's own words.",
      areas: ["mail", "files"],
    },
    "and one it wrote is read whole, with the areas it works",
  );
  await removeStored();
});

test("an instruction written before the areas existed is still read, with none declared", async () => {
  await writeAppFileAt(ctx, accountId, INSTRUCTION_FILE, {
    v: 1,
    instruction: "Answer the shipper in the group's own words.",
  });
  assert.deepEqual(
    await readInstruction(ctx, accountId),
    {
      v: INSTRUCTION_VERSION,
      instruction: "Answer the shipper in the group's own words.",
      areas: [],
    },
    "the prose it wrote is the instruction it was, and no area is invented for it",
  );
  await removeStored();
});

test("an instruction this build cannot read is refused with its path, never carried as silence", async () => {
  for (const unreadable of [
    "{ not json",
    JSON.stringify({ v: 99, instruction: "anything" }),
    JSON.stringify({ v: INSTRUCTION_VERSION, instruction: "   " }),
  ]) {
    await writeAppBytesAt(
      ctx,
      accountId,
      INSTRUCTION_FILE,
      new TextEncoder().encode(unreadable),
      "application/json",
    );
    await assert.rejects(
      () => readInstruction(ctx, accountId),
      (err: unknown) =>
        err instanceof InstructionError &&
        err.code === "instruction_unreadable" &&
        err.message.includes(INSTRUCTION_FILE),
      `a document that is ${unreadable} is refused as unreadable`,
    );
  }
  await removeStored();
});

test("the parser takes the version this build writes and refuses every other shape", () => {
  assert.deepEqual(
    parseInstructionDocumentDetailed(
      JSON.stringify({
        v: INSTRUCTION_VERSION,
        instruction: "Work by these words.",
        areas: ["mail"],
      }),
    ),
    {
      instruction: {
        v: INSTRUCTION_VERSION,
        instruction: "Work by these words.",
        areas: ["mail"],
      },
    },
    "the shape this build writes parses whole",
  );
  assert.deepEqual(
    parseInstructionDocumentDetailed(
      JSON.stringify({
        v: INSTRUCTION_VERSION,
        instruction: "Work by these words.",
        areas: ["mail"],
        retired: true,
      }),
    ),
    {
      instruction: {
        v: INSTRUCTION_VERSION,
        instruction: "Work by these words.",
        areas: ["mail"],
      },
    },
    "a key this build does not know decides nothing and is dropped",
  );
  assert.deepEqual(
    parseInstructionDocumentDetailed(
      JSON.stringify({ v: 1, instruction: "Work by these words." }),
    ),
    {
      instruction: {
        v: INSTRUCTION_VERSION,
        instruction: "Work by these words.",
        areas: [],
      },
    },
    "a document written before the areas existed is the prose it was, with none declared",
  );
  for (const raw of [
    "[]",
    JSON.stringify({ v: 2, instruction: "x" }),
    JSON.stringify({ v: INSTRUCTION_VERSION }),
    JSON.stringify({ v: INSTRUCTION_VERSION, instruction: 7 }),
    JSON.stringify({ v: INSTRUCTION_VERSION, instruction: "x", areas: "mail" }),
    JSON.stringify({ v: INSTRUCTION_VERSION, instruction: "x", areas: ["invoices"] }),
    JSON.stringify({
      v: INSTRUCTION_VERSION,
      instruction: "x",
      areas: ["mail", "files", "calendar", "workorders"],
    }),
  ]) {
    const parsed = parseInstructionDocumentDetailed(raw);
    assert.ok("problem" in parsed, `${raw} is refused`);
  }
});
