/**
 * The tools over the account's own Files.
 *
 * Listing a level and reading a document, making a folder of a path, moving and
 * renaming a node. Every write here goes through one conditional write of the
 * account's FileNode state, so a race lost is retried once and then refused.
 */

import {
  appFolderState,
  type Ctx,
  documentType,
  ensureRootFolderPath,
  type FileNodeLike,
  fileChildren,
  findVisibleFolder,
  nodeStamp,
  pathSegments,
  readVisibleFileBytes,
  updateAppNode,
} from "../../appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../../jmap.js";
import { APP_FOLDER_NAME, FILE_PROPS } from "../../shared/appFolder.js";
import { refusalOf } from "../../shared/jmap.js";
import { argsRecord, notFound, optionalTextArg, textArg } from "./args.js";
import { readFileText } from "./content.js";
import { defineTool, ToolError } from "./define.js";

export const listFiles = defineTool({
  name: "files.list",
  description:
    "List a folder of this account's Files. Name no folder for the top level; " +
    "a folder's path lists the level inside it.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ folder: optionalTextArg(argsRecord(raw), "folder") ?? "" }),
  run: async ({ ctx, accountId }, { folder }) => {
    const folderId = await findVisibleFolder(ctx, accountId, folder);
    if (folderId === undefined)
      throw notFound(`folder "${folder}" in this account's Files`);
    // The stamps are what a reader sorts a level by, and they are not in the set
    // a tree walk asks for; asking for them widens that set (`readProps`).
    const children = await fileChildren(ctx, accountId, folderId, [
      ...FILE_PROPS,
      "created",
      "modified",
    ]);
    return {
      nodes: children.flatMap((node: FileNodeLike) => {
        if (typeof node.name !== "string" || !node.name) return [];
        /*
         * The app folder is Gilbert's own: chat, the knowledge base, workorders
         * and the agent's documents have their own tools, and a browse of the
         * Files root must not show it -- naming it was a read the account
         * refused, and the whole decision died on it.
         */
        if (!folder && node.name === APP_FOLDER_NAME) return [];
        return [
          {
            path: folder ? `${folder}/${node.name}` : node.name,
            nodeType: node.nodeType === "directory" ? "directory" : "file",
            size: typeof node.size === "number" ? node.size : null,
            modified: nodeStamp(node),
          },
        ];
      }),
    };
  },
});

export const readNode = defineTool({
  name: "files.read",
  description:
    "Read one document of this account's Files, by the path a listing answered " +
    "with: its text. A PDF, a Word file, a spreadsheet or an OpenDocument is " +
    "read inside, so what you get is what the document says; a format this " +
    "build cannot read says so rather than answering bytes.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ path: textArg(argsRecord(raw), "path") }),
  run: async ({ ctx, accountId, readImage }, { path }) => {
    const found = await readVisibleFileBytes(ctx, accountId, path);
    if (!found) throw notFound(`file "${path}" in this account's Files`);
    const type = documentType(found.file);
    /*
     * A picture is read by the installation's model and a document by the
     * format readers; both answer the same three things — the text, a reason it
     * could not be read, or "this is not a format I read".
     *
     * shortcut: the vision call is not on the run's tally (a tool's spend is a
     * constant), so a run that reads many images under-reports its calls; give
     * `spend` a function when the tally must be exact to the call.
     */
    const document = await readFileText(
      { type, name: found.name, bytes: found.bytes },
      readImage,
    );
    return {
      name: found.name,
      type,
      size: typeof found.file.size === "number" ? found.file.size : null,
      ...document,
    };
  },
});

/**
 * One conditional write of a node in the account's Files, retried once.
 *
 * `updateAppNode` writes against the account's FileNode state, and any writer in
 * the account invalidates it — a member's upload, another document, a prune
 * (`gilbert-stalwart`). One retry re-reads the state and writes again; a race
 * lost twice is refused rather than retried for ever, and the refusal the server
 * names for the node (`alreadyExists` on a rename, a right) is handed back in
 * its own words.
 */
async function writeNode(
  ctx: Ctx,
  accountId: string,
  id: string,
  change: { name?: string; parentId?: string | null },
): Promise<void> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = await appFolderState(ctx, accountId);
    try {
      const res = await updateAppNode(ctx, accountId, id, change, token);
      const refused = res.notUpdated?.[id];
      if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
      return;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  throw new ToolError(
    "write_raced",
    "Another write kept winning the race for that node; it was left as it is.",
    409,
  );
}

export const createFileFolder = defineTool({
  name: "files.folder",
  description:
    "Create a folder in this account's own Files, by its path — " +
    "`Containers/2026`, or a single name at the top level. Every folder of the " +
    "path that is missing is made and one that is there is left as it is. The " +
    "`gilbert` app folder is not a destination.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => ({ path: textArg(argsRecord(raw), "path") }),
  run: async ({ ctx, accountId }, { path }) => {
    const id = await ensureRootFolderPath(ctx, accountId, path);
    return { folder: pathSegments(path).join("/"), id };
  },
});

export const moveFile = defineTool({
  name: "files.move",
  description:
    "Move a node of this account's own Files into a folder, by the folder's " +
    "path; name no folder to move it to the top level. The node keeps its name " +
    "and its id, and a move into its own subtree is refused.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { id: textArg(args, "id"), folder: optionalTextArg(args, "folder") ?? "" };
  },
  run: async ({ ctx, accountId }, { id, folder }) => {
    const dest = await findVisibleFolder(ctx, accountId, folder);
    if (dest === undefined) throw notFound(`folder "${folder}" in this account's Files`);
    // `null` is the top level of Files, and it is a destination: a patch that
    // dropped it would leave the node where it was.
    await writeNode(ctx, accountId, id, { parentId: dest });
    return { id, folder: folder || null };
  },
});

export const renameFile = defineTool({
  name: "files.rename",
  description:
    "Rename a node of this account's own Files. A name another node of the same " +
    "folder already carries is refused rather than taken.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { id: textArg(args, "id"), name: textArg(args, "name") };
  },
  run: async ({ ctx, accountId }, { id, name }) => {
    await writeNode(ctx, accountId, id, { name });
    return { id, name };
  },
});
