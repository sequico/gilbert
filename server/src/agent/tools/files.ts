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
  destroyAppNode,
  documentType,
  ensureRootFolderPath,
  type FileNodeLike,
  fileChildren,
  findVisibleFile,
  findVisibleFolder,
  findVisibleNode,
  nodeStamp,
  pathSegments,
  readVisibleFileBytes,
  unusedVisibleName,
  updateAppNode,
  writeBlobIntoVisibleFolder,
  writeBytesIntoVisibleFolder,
} from "../../appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../../jmap.js";
import { CAPABILITIES } from "../../shared/capabilities.js";
import { APP_FOLDER_NAME, FILE_PROPS } from "../../shared/appFolder.js";
import { isRecord } from "../../shared/json.js";
import { refusalOf } from "../../shared/jmap.js";
import { clientOf } from "../../util.js";
import {
  argsRecord,
  countArg,
  notFound,
  optionalTextArg,
  TOOL_LIST_MAX,
  textArg,
} from "./args.js";
import { READ_BYTES_MAX, readFileText } from "./content.js";
import { defineTool, ToolError } from "./define.js";

export const listFiles = defineTool({
  name: "files.list",
  description:
    "List a folder of this account's Files, by its `path` — `MS2` lists what " +
    "is inside MS2. Name no path for the top level of Files. `limit` is how many " +
    "entries to answer with (at most " +
    TOOL_LIST_MAX +
    "); `total` and `truncated` say whether the folder holds more.",
  authority: "reversible",
  writes: false,
  keys: ["limit", "path"],
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      path: optionalTextArg(args, "path") ?? "",
      limit: countArg(args, "limit", TOOL_LIST_MAX) ?? TOOL_LIST_MAX,
    };
  },
  run: async ({ ctx, accountId }, { path: folder, limit }) => {
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
    const nodes = children.flatMap((node: FileNodeLike) => {
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
    });
    return {
      nodes: nodes.slice(0, limit),
      total: nodes.length,
      truncated: nodes.length > limit,
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
  keys: ["path"],
  parse: (raw: unknown) => ({ path: textArg(argsRecord(raw), "path") }),
  run: async ({ ctx, accountId, readImage }, { path }) => {
    const held = await findVisibleFile(ctx, accountId, path);
    if (typeof held?.file.size === "number" && held.file.size > READ_BYTES_MAX)
      throw new ToolError(
        "too_large",
        `"${path}" is ${held.file.size} bytes; a read stops at ${READ_BYTES_MAX}.`,
        413,
      );
    const found = await readVisibleFileBytes(ctx, accountId, path, READ_BYTES_MAX);
    if (!found) throw notFound(`file "${path}" in this account's Files`);
    // A node that declares no size (or lies about it) is caught after the
    // bytes are here, before a parser or the model is handed them.
    if (found.bytes.byteLength > READ_BYTES_MAX)
      throw new ToolError(
        "too_large",
        `"${path}" is ${found.bytes.byteLength} bytes; a read stops at ${READ_BYTES_MAX}.`,
        413,
      );
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

/** The MIME a text document is written with, by its own extension. */
const TEXT_TYPES: Record<string, string> = {
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
};

function textType(name: string): string {
  const at = name.lastIndexOf(".");
  const ext = at < 0 ? "" : name.slice(at + 1).toLowerCase();
  return TEXT_TYPES[ext] ?? "text/plain";
}

/** A document path as its folder and its file name; the name is the last one. */
function splitDocumentPath(path: string): { folder: string; name: string } {
  const segments = pathSegments(path);
  const name = segments.pop();
  if (!name) throw new ToolError("bad_arguments", "A document path needs a file name.");
  return { folder: segments.join("/"), name };
}

export const writeDocument = defineTool({
  name: "files.write",
  description:
    "Write a text document into this account's own Files at a path — " +
    "`Containers/2026/report.md`. Folders the path names that are missing are " +
    "made, and the type follows the extension (`.md`, `.csv`, `.json`, " +
    "`.html`, otherwise plain text). A document already at that path is " +
    "refused: nothing a person filed is replaced by a write.",
  authority: "reversible",
  writes: true,
  surface: "files",
  spend: { steps: 1 },
  keys: ["path", "text"],
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { path: textArg(args, "path"), text: textArg(args, "text") };
  },
  run: async ({ ctx, accountId }, { path, text }) => {
    const { folder, name } = splitDocumentPath(path);
    const held = await findVisibleFile(ctx, accountId, path);
    if (held)
      throw new ToolError(
        "path_taken",
        `"${path}" already holds a document; files.overwrite replaces it, and files.write never does.`,
        409,
      );
    const bytes = new TextEncoder().encode(text);
    const id = await writeBytesIntoVisibleFolder(
      ctx,
      accountId,
      folder,
      name,
      bytes,
      textType(name),
    );
    return { path: folder ? `${folder}/${name}` : name, id, bytes: bytes.byteLength };
  },
});

export const saveFile = defineTool({
  name: "files.save",
  description:
    "Save a file into this account's own Files, at the path it should land at — " +
    "`Containers/2026/BK-42.pdf`. The source is an **attachment of a message** " +
    "(`message` and `attachment`, exactly as mail.read answered them), or a " +
    "**document already in Files** (`from`, its path). The bytes are copied as " +
    "they are, so a PDF stays a PDF, and a name already taken in the folder gets " +
    "a numbered one beside it: nothing a person filed is replaced.",
  authority: "reversible",
  writes: true,
  surface: "files",
  spend: { steps: 1 },
  keys: ["attachment", "from", "message", "path"],
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const from = optionalTextArg(args, "from");
    const message = optionalTextArg(args, "message");
    const attachment = optionalTextArg(args, "attachment");
    if (from && (message || attachment))
      throw new ToolError(
        "bad_arguments",
        'One source: either "from" names a document in Files, or "message" and "attachment" name one of a message.',
      );
    if (!from && !(message && attachment))
      throw new ToolError(
        "bad_arguments",
        'A source is needed: "from" a document in Files, or "message" with the "attachment" mail.read answered.',
      );
    return { path: textArg(args, "path"), from, message, attachment };
  },
  run: async ({ ctx, accountId }, { path, from, message, attachment }) => {
    const { folder, name } = splitDocumentPath(path);
    const held = await unusedVisibleName(ctx, accountId, folder, name);
    const source = from
      ? await fileBlob(ctx, accountId, from)
      : await attachmentBlob(ctx, accountId, message ?? "", attachment ?? "");
    const id = await writeBlobIntoVisibleFolder(
      ctx,
      accountId,
      folder,
      held,
      source.blobId,
      source.type,
    );
    return {
      path: folder ? `${folder}/${held}` : held,
      from: source.from,
      type: source.type,
      bytes: source.bytes,
      id,
    };
  },
});

/** The blob of a document already in Files, and what it is. */
async function fileBlob(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<{ blobId: string; type: string; bytes: number | null; from: string }> {
  const held = await findVisibleFile(ctx, accountId, path);
  if (!held) throw notFound(`document "${path}" in this account's Files`);
  const blobId = typeof held.file.blobId === "string" ? held.file.blobId : "";
  if (!blobId) throw new ToolError("bad_arguments", `"${path}" holds no file.`, 422);
  return {
    blobId,
    type: contentType(held.file),
    bytes: typeof held.file.size === "number" ? held.file.size : null,
    from: path,
  };
}

/** The blob of one attachment of a message, found the way mail.readAttachment finds it. */
async function attachmentBlob(
  ctx: Ctx,
  accountId: string,
  id: string,
  name: string,
): Promise<{ blobId: string; type: string; bytes: number | null; from: string }> {
  const answer = await clientOf(ctx).call<{ list?: Array<{ attachments?: unknown }> }>(
    "Email/get",
    { accountId, ids: [id], properties: ["attachments"] },
    [CAPABILITIES.mail],
  );
  const message = answer.list?.[0];
  if (!message) throw notFound(`message "${id}" in this account`);
  const held = (Array.isArray(message.attachments) ? message.attachments : []).filter(
    isRecord,
  );
  const one = held.find(
    (part) =>
      typeof part.name === "string" &&
      part.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (!one) throw notFound(`attachment "${name}" on message "${id}"`);
  const blobId = typeof one.blobId === "string" ? one.blobId : "";
  if (!blobId)
    throw new ToolError("bad_arguments", `The attachment "${name}" has no file.`, 422);
  return {
    blobId,
    type:
      typeof one.type === "string" && one.type ? one.type : "application/octet-stream",
    bytes: typeof one.size === "number" ? one.size : null,
    from: `${id}/${name}`,
  };
}

/** The type a FileNode says it is, or what an untyped node is read as. */
function contentType(file: FileNodeLike): string {
  return typeof file.type === "string" && file.type
    ? file.type
    : "application/octet-stream";
}

export const overwriteDocument = defineTool({
  name: "files.overwrite",
  description:
    "Replace the text of a document already in this account's Files, by the " +
    "path it carries. The node keeps its id and its place. The act is the " +
    "document: a person's word for it names the document, and licenses that one.",
  authority: "destructive",
  writes: true,
  surface: "files",
  spend: { steps: 1 },
  act: (args: { path: string }) => ({ target: args.path, content: null }),
  keys: ["path", "text"],
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { path: textArg(args, "path"), text: textArg(args, "text") };
  },
  run: async ({ ctx, accountId }, { path, text }) => {
    const { folder, name } = splitDocumentPath(path);
    const held = await findVisibleFile(ctx, accountId, path);
    if (!held)
      throw notFound(
        `document "${path}" in this account's Files (files.write creates one)`,
      );
    const bytes = new TextEncoder().encode(text);
    await writeBytesIntoVisibleFolder(
      ctx,
      accountId,
      folder,
      name,
      bytes,
      textType(name),
    );
    return { path, id: String(held.file.id ?? ""), bytes: bytes.byteLength };
  },
});

export const deleteDocument = defineTool({
  name: "files.delete",
  description:
    "Remove a document of this account's own Files, or a folder that is empty, " +
    "by its path. A folder still holding something is refused rather than " +
    "emptied. The act is the node: a person's word for it names what is removed.",
  authority: "destructive",
  writes: true,
  surface: "files",
  spend: { steps: 1 },
  act: (args: { path: string }) => ({ target: args.path, content: null }),
  keys: ["path"],
  parse: (raw: unknown) => ({ path: textArg(argsRecord(raw), "path") }),
  run: async ({ ctx, accountId }, { path }) => {
    const held = await findVisibleNode(ctx, accountId, path);
    if (!held?.file.id) throw notFound(`node "${path}" in this account's Files`);
    if (held.directory) {
      const children = await fileChildren(ctx, accountId, String(held.file.id), ["id"]);
      if (children.length)
        throw new ToolError(
          "folder_not_empty",
          `"${path}" still holds ${children.length} item(s); move or remove them first.`,
          409,
        );
    }
    await destroyAppNode(ctx, accountId, String(held.file.id));
    return { path, removed: true };
  },
});

export const createFileFolder = defineTool({
  name: "files.folder",
  description:
    "Create a folder in this account's own Files, by its path — " +
    "`Containers/2026`, or a single name at the top level. Every folder of the " +
    "path that is missing is made and one that is there is left as it is. The " +
    "`gilbert` app folder is not a destination.",
  authority: "reversible",
  writes: true,
  surface: "files",
  spend: { steps: 1 },
  keys: ["path"],
  parse: (raw: unknown) => ({ path: textArg(argsRecord(raw), "path") }),
  run: async ({ ctx, accountId }, { path }) => {
    const id = await ensureRootFolderPath(ctx, accountId, path);
    return { folder: pathSegments(path).join("/"), id };
  },
});

export const moveFile = defineTool({
  name: "files.move",
  description:
    "Move a document or a folder of this account's own Files into a folder: " +
    "`path` is the node's path now, `folder` the folder to move it into — name " +
    "no folder for the top level. The node keeps its name and its id, and a " +
    "folder into its own subtree is refused.",
  authority: "reversible",
  writes: true,
  surface: "files",
  spend: { steps: 1 },
  keys: ["folder", "path"],
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { path: textArg(args, "path"), folder: optionalTextArg(args, "folder") ?? "" };
  },
  run: async ({ ctx, accountId }, { path, folder }) => {
    const held = await findVisibleNode(ctx, accountId, path);
    if (!held?.file.id) throw notFound(`node "${path}" in this account's Files`);
    const to = folder.replace(/\/+$/, "");
    if (held.directory && (to === path || to.startsWith(`${path}/`)))
      throw new ToolError(
        "bad_arguments",
        `A folder cannot be moved into itself ("${path}" into "${to}").`,
      );
    const dest = await findVisibleFolder(ctx, accountId, folder);
    if (dest === undefined) throw notFound(`folder "${folder}" in this account's Files`);
    // `null` is the top level of Files, and it is a destination: a patch that
    // dropped it would leave the node where it was.
    await writeNode(ctx, accountId, String(held.file.id), { parentId: dest });
    const name = String(held.file.name ?? "");
    return { path: folder ? `${folder}/${name}` : name, folder: folder || null };
  },
});

export const renameFile = defineTool({
  name: "files.rename",
  description:
    "Rename a document or a folder of this account's own Files, by the `path` " +
    "it carries now and the `name` to give it. A name another node of the same " +
    "folder already carries is refused rather than taken.",
  authority: "reversible",
  writes: true,
  surface: "files",
  spend: { steps: 1 },
  keys: ["name", "path"],
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { path: textArg(args, "path"), name: textArg(args, "name") };
  },
  run: async ({ ctx, accountId }, { path, name }) => {
    const held = await findVisibleNode(ctx, accountId, path);
    if (!held?.file.id) throw notFound(`node "${path}" in this account's Files`);
    await writeNode(ctx, accountId, String(held.file.id), { name });
    return { path, name };
  },
});
