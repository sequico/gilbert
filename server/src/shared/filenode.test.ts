/**
 * The FileNode boundary between Stalwart 1.0 and this tree (ADR 0038).
 *
 * The wire names a node's kind `@type` (`File`/`Directory`/`SymLink`) and its
 * MIME `mediaType`; the tree keeps `nodeType` in lower case and `type`. One
 * function each way is the whole of the translation, and it is pinned here so a
 * renamed key fails loudly instead of sending a create the server refuses.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileNodeRequestArguments, fileNodeResponseArguments } from "./filenode.js";

test("a FileNode request goes out with @type, mediaType and capitalised values", () => {
  const created = fileNodeRequestArguments("FileNode/set", {
    create: { d: { parentId: null, name: "gilbert", nodeType: "directory" } },
    update: { f: { name: "renamed", type: "text/plain", nodeType: "file" } },
  });
  assert.deepEqual(created.create, {
    d: { parentId: null, name: "gilbert", "@type": "Directory" },
  });
  assert.deepEqual(created.update, {
    f: { name: "renamed", mediaType: "text/plain", "@type": "File" },
  });

  const got = fileNodeRequestArguments("FileNode/get", {
    ids: null,
    properties: ["id", "name", "nodeType", "type", "parentId"],
  });
  assert.deepEqual(got.properties, ["id", "name", "@type", "mediaType", "parentId"]);

  const queried = fileNodeRequestArguments("FileNode/query", {
    filter: {
      operator: "AND",
      conditions: [{ nodeType: "directory" }, { isTopLevel: true }],
    },
  });
  assert.deepEqual(queried.filter, {
    operator: "AND",
    conditions: [{ nodeType: "Directory" }, { isTopLevel: true }],
  });
});

test("a get answer comes back in the tree's own names", () => {
  const answer = fileNodeResponseArguments("FileNode/get", {
    list: [
      {
        id: "d",
        "@type": "File",
        mediaType: "application/json",
        name: "config.json",
      },
      { id: "e", "@type": "Directory", name: "Documents" },
    ],
    notFound: [],
  });
  assert.deepEqual(answer.list, [
    { id: "d", nodeType: "file", type: "application/json", name: "config.json" },
    { id: "e", nodeType: "directory", name: "Documents" },
  ]);
});

test("a set answer carries no node, so it is left exactly as the server sent it", () => {
  // Live-verified on 1.0: `FileNode/set` returns `id`, the timestamps and, for
  // a file, `size`/`executable` — no kind, no MIME. Nothing to translate.
  const args = { created: { d: { id: "d" } }, updated: { e: { changed: "x" } } };
  assert.equal(fileNodeResponseArguments("FileNode/set", args), args);
});

test("a method that is not a FileNode one is left exactly as it came", () => {
  const args = { create: { e: { subject: "hello", type: "text/plain" } } };
  assert.equal(fileNodeRequestArguments("Email/set", args), args);
  const answer = { list: [{ id: "e", "@type": "Email", mediaType: "text/plain" }] };
  assert.equal(fileNodeResponseArguments("Email/get", answer), answer);
});
