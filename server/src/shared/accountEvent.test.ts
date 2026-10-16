/**
 * Which surface a node's path belongs to (ADR 0035).
 *
 * The classifier is what makes "its Files, its chat, and the writes to its own
 * workorders" three answers rather than one, and it is pure, so the whole of it
 * is asked here: the two folders that are their own surface, the plain Files
 * node, and the near miss — `chat-state` sits beside `chat` and is a read
 * marker, not a message.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { eventSourceOf } from "./accountEvent.js";
import { APP_FOLDER_NAME } from "./appFolder.js";
import { CHAT_FOLDER } from "./chat.js";
import { WORKORDER_FOLDER, workorderClosedPath } from "./workorder.js";

test("a chat message, a workorder and a plain node are told apart by the folder they sit in", () => {
  assert.equal(eventSourceOf(`${APP_FOLDER_NAME}/${CHAT_FOLDER}/a.json`), "chat");
  assert.equal(
    eventSourceOf(`${APP_FOLDER_NAME}/${WORKORDER_FOLDER}/wo.json`),
    "workorder",
  );
  assert.equal(
    eventSourceOf(`${APP_FOLDER_NAME}/${workorderClosedPath()}/wo.json`),
    "workorder",
  );
  assert.equal(eventSourceOf(`${APP_FOLDER_NAME}/runs/r.json`), "files");
  assert.equal(eventSourceOf(APP_FOLDER_NAME), "files");
  assert.equal(eventSourceOf("Documents/order.pdf"), "files");
});

test("a chat read marker is not a chat node", () => {
  assert.equal(eventSourceOf(`${APP_FOLDER_NAME}/chat-state/a.json`), "files");
});
