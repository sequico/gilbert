/**
 * The app folder in JMAP Files where the client keeps its own state: signature
 * images and over-sized signature HTML (Stalwart caps a signature at 2 KB), the
 * synced settings file, a group's chat transcript and its label catalog.
 *
 * It is a real folder in the user's account — that is the whole point, since it
 * is what makes this state travel between devices without Gilbert storing
 * anything server-side of its own — but it is housekeeping rather than
 * something anyone filed there, so the Files view hides it.
 *
 * Which folder that is is **one rule, applied on both sides**: this module and
 * the server's `server/src/appFolder.ts`. A top-level `gilbert` or `.gilbert`
 * is the app folder only when it carries `APP_FOLDER_MARKER`, so a folder a
 * person made by that name is never adopted and the app folder moves to
 * `APP_FOLDER_ALT` instead of landing in their work. Both sides write into the
 * same account's Files, so a folder one of them created and the other could not
 * recognise would split every document in two.
 *
 * The lookup below filters on `parentId`/`isTopLevel` alone and matches the
 * name here rather than asking the server to. Those are the filters Files
 * itself relies on; `name` is not one Stalwart is known to implement, and a
 * filter it does not know fails the whole query rather than being ignored.
 */
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, SetResponse } from "@/jmap/types";
import { directoryCreate, fileCreate } from "@/lib/filenode";

/** The folder Gilbert keeps its own documents in, in every account. */
export const APP_FOLDER = "gilbert";

/** The same folder, when the account already has something called `gilbert`. */
export const APP_FOLDER_ALT = ".gilbert";

/** The file whose presence makes a folder the app folder. */
export const APP_FOLDER_MARKER = ".gilbert-app";

/** Every name the app folder can go by, for the tree to refuse. */
export const APP_FOLDER_NAMES: ReadonlyArray<string> = [APP_FOLDER, APP_FOLDER_ALT];

/** Just enough to find the folder. */
export const folderProps = (): string[] => ["id", "name", "nodeType", "parentId"];

/**
 * A top-level directory by one of the app folder's names.
 *
 * This is the name half of the rule only: whether such a folder **is** the app
 * folder is settled by its marker, which costs a listing — `findAppFolder`.
 */
export function isAppFolderName(
  n: Pick<FileNode, "name" | "parentId" | "nodeType">,
): boolean {
  return (
    !n.parentId && n.nodeType === "directory" && APP_FOLDER_NAMES.includes(String(n.name))
  );
}

/** List one level of the tree: the top level, or the children of a folder. */
async function children(
  accountId: Id,
  parentId: Id | null,
  properties: string[],
): Promise<FileNode[]> {
  return (await listChildrenWithState(accountId, parentId, properties)).list;
}

/**
 * List one level of the tree, with the FileNode state the read saw.
 *
 * The state is the change anchor: a client that then runs
 * `FileNode/changes` from it misses nothing the list does not already have,
 * and reports nothing twice (chat's transcript sync relies on that). The one
 * JMAP listing primitive -- callers that only want the list use `children`
 * or `findInFolder`.
 */
export async function listChildrenWithState(
  accountId: Id,
  parentId: Id | null,
  properties: string[],
  opts: { position?: number; limit?: number } = {},
): Promise<{ list: FileNode[]; state: string; total: number }> {
  const filter = parentId ? { parentId } : { isTopLevel: true };
  const res = await client.chain([
    [
      "FileNode/query",
      { accountId, filter, position: opts.position ?? 0, limit: opts.limit ?? 1000 },
      "q",
    ],
    [
      "FileNode/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" },
        properties,
      },
      "g",
    ],
  ]);
  const [g] = res.get("g") ?? [];
  const [q] = res.get("q") ?? [];
  const got = g as unknown as GetResponse<FileNode>;
  const query = q as unknown as { total?: number };
  return {
    list: got.list,
    state: got.state ?? "0",
    total: query.total ?? got.list.length,
  };
}

/** Whether a folder carries the marker that makes it the app folder. */
async function carriesMarker(accountId: Id, folderId: Id): Promise<boolean> {
  const kids = await children(accountId, folderId, folderProps());
  return kids.some(
    (n) =>
      n.parentId === folderId && n.nodeType === "file" && n.name === APP_FOLDER_MARKER,
  );
}

/** The account's own app folder, or null when there is not a marked one yet. */
export async function findAppFolder(accountId: Id): Promise<Id | null> {
  const top = await children(accountId, null, folderProps());
  for (const candidate of top.filter(isAppFolderName)) {
    if (await carriesMarker(accountId, candidate.id)) return candidate.id;
  }
  return null;
}

/**
 * The name the app folder takes when there is not one yet.
 *
 * The plain name, unless a top-level folder already holds it. A folder that
 * held it and were the app folder would have carried the marker and been
 * adopted, so one that holds it without a marker is somebody's: the app folder
 * goes to `APP_FOLDER_ALT` rather than into their work.
 */
export function appFolderNameWhenMissing(topLevelNames: Iterable<string>): string {
  return new Set(topLevelNames).has(APP_FOLDER) ? APP_FOLDER_ALT : APP_FOLDER;
}

/**
 * The account's own app folder, creating it — and marking it — when missing.
 *
 * The plain name is used unless a top-level folder already holds it without the
 * marker: that folder is somebody's, so the app folder goes to
 * `APP_FOLDER_ALT` rather than into their work.
 */
export async function ensureFolder(accountId: Id): Promise<Id> {
  const existing = await findAppFolder(accountId);
  if (existing) return existing;
  const top = await children(accountId, null, folderProps());
  const name = appFolderNameWhenMissing(
    top
      .filter((n) => !n.parentId && typeof n.name === "string")
      .map((n) => String(n.name)),
  );
  const set = await client.call<SetResponse<FileNode>>("FileNode/set", {
    accountId,
    create: { d: directoryCreate(null, name) },
  });
  const err = set.notCreated?.d;
  if (err) throw new Error(setErrorMessage(err));
  const id = set.created!.d!.id;
  await markAppFolder(accountId, id);
  return id;
}

/** Leave the marker that makes a folder the app folder. */
async function markAppFolder(accountId: Id, folderId: Id): Promise<void> {
  const text =
    "Gilbert keeps its own documents in this folder. It is not a place to file your own.\n";
  const up = await client.upload(accountId, new Blob([text], { type: "text/plain" }), {
    type: "text/plain",
  });
  const set = await client.call<SetResponse<FileNode>>("FileNode/set", {
    accountId,
    create: { m: fileCreate(folderId, APP_FOLDER_MARKER, up.blobId, "text/plain") },
  });
  const err = set.notCreated?.m;
  if (err) throw new Error(setErrorMessage(err));
}

/**
 * A node's persistent blobId. `FileNode/set` does not return one on create, so
 * anything that needs the blob straight after making the node has to ask.
 */
export async function nodeBlobId(accountId: Id, id?: Id): Promise<Id | undefined> {
  if (!id) return undefined;
  try {
    const res = await client.call<GetResponse<FileNode>>("FileNode/get", {
      accountId,
      ids: [id],
      properties: ["id", "blobId"],
    });
    return res.list[0]?.blobId ?? undefined;
  } catch {
    return undefined;
  }
}

/** Find a file by name inside the app folder. */
export async function findInFolder(
  accountId: Id,
  folderId: Id,
  name: string,
): Promise<FileNode | undefined> {
  const props = ["id", "name", "parentId", "blobId", "size", "type", "nodeType"];
  const list = await children(accountId, folderId, props);
  return list.find((n) => n.name === name && n.parentId === folderId);
}
