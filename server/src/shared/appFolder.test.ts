import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_FOLDER_NAME,
  appFolderCreate,
  ensureAppFolderId,
  findAppFolderId,
  isAppFolder,
} from "./appFolder.js";

/**
 * The folder's rule, and the reason it is one rule.
 *
 * The server looks this folder up and ensures it exists; the client does the
 * same from its own side and hides the folder from the Files listing. Each tier
 * used to carry the predicate and the find-then-create, and the client's copy
 * read `!n.parentId` where the server's read `n.parentId == null` — the same
 * answer for the shapes a server sends, and two answers to keep in step by hand
 * for the ones it does not. The tests below are the rule's own, so a tier that
 * stops asking it is a failure here rather than a folder nobody finds.
 */

test("a top-level directory by that name is the app folder", () => {
  assert.equal(
    isAppFolder({ name: APP_FOLDER_NAME, parentId: null, nodeType: "directory" }),
    true,
  );
});

test("nothing else is, however close it comes", () => {
  const no = (node: Parameters<typeof isAppFolder>[0]) =>
    assert.equal(isAppFolder(node), false);

  no({ name: APP_FOLDER_NAME, parentId: "n1", nodeType: "directory" }); // nested
  no({ name: APP_FOLDER_NAME, parentId: null, nodeType: "file" }); // a file
  no({ name: "Work", parentId: null, nodeType: "directory" }); // another folder
  no({}); // a node that says nothing
});

test("the create-arguments name the folder the predicate looks for", () => {
  const create = appFolderCreate();
  assert.deepEqual(create, {
    parentId: null,
    name: APP_FOLDER_NAME,
    nodeType: "directory",
  });
  // The half that matters: what one tier creates is what the other finds.
  assert.equal(isAppFolder({ ...create, id: "n1" }), true);
});

test("finding the folder asks once, at the top level", async () => {
  const asked: Array<string | null> = [];
  const id = await findAppFolderId(async (parentId) => {
    asked.push(parentId);
    return [
      { id: "n1", name: "Work", parentId: null, nodeType: "directory" },
      { id: "n2", name: APP_FOLDER_NAME, parentId: null, nodeType: "directory" },
    ];
  });

  assert.equal(id, "n2");
  assert.deepEqual(asked, [null]);
});

test("an account with no app folder has no id for one", async () => {
  const id = await findAppFolderId(async () => [
    { id: "n1", name: "Work", parentId: null, nodeType: "directory" },
  ]);
  assert.equal(id, null);
});

test("ensuring creates the folder when it is missing, and only then", async () => {
  let created = 0;
  const create = async () => {
    created++;
    return "new";
  };

  const existing = await ensureAppFolderId(
    async () => [
      { id: "n2", name: APP_FOLDER_NAME, parentId: null, nodeType: "directory" },
    ],
    create,
  );
  assert.equal(existing, "n2");
  assert.equal(created, 0, "a folder that is already there is not created again");

  const fresh = await ensureAppFolderId(async () => [], create);
  assert.equal(fresh, "new");
  assert.equal(created, 1);
});
