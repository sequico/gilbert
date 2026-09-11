/**
 * The app folder in JMAP Files where the client keeps its own state: signature
 * images and over-sized signature HTML (Stalwart caps a signature at 2 KB), the
 * synced settings file, a group's chat transcript and its label catalog.
 *
 * It is a real folder in the user's account — that is the whole point, since it
 * is what makes this state travel between devices without Gilbert storing
 * anything server-side of its own — but it is housekeeping rather than
 * something anyone filed there: the Files view drops it from the listing, so it
 * never appears as a place to file your own.
 *
 * Which folder that is is **one rule, applied on both sides**: this module and
 * the server's `server/src/appFolder.ts`. There is one name, and the name is
 * the whole rule: no marker to leave, no second name to fall back to, nothing
 * for the two sides to resolve differently. Gilbert is pre-release, so a folder
 * an earlier build created under another name is not read and its documents are
 * not migrated.
 *
 * The lookup below filters on `parentId`/`isTopLevel` alone and matches the
 * name here rather than asking the server to. Those are the filters Files
 * itself relies on; `name` is not one Stalwart is known to implement, and a
 * filter it does not know fails the whole query rather than being ignored.
 */
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, SetResponse } from "@/jmap/types";
import { directoryCreate } from "@/lib/filenode";

/** The folder Gilbert keeps its own documents in, in every account. */
export const APP_FOLDER = "gilbert";

/** Just enough to find the folder. */
export const folderProps = (): string[] => ["id", "name", "nodeType", "parentId"];

/** A top-level directory by the app folder's name. */
export function isAppFolder(
  n: Pick<FileNode, "name" | "parentId" | "nodeType">,
): boolean {
  return !n.parentId && n.nodeType === "directory" && String(n.name) === APP_FOLDER;
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

/** The account's own app folder, or null when there is not one yet. */
export async function findAppFolder(accountId: Id): Promise<Id | null> {
  const top = await children(accountId, null, folderProps());
  const found = top.find(isAppFolder);
  return found ? found.id : null;
}

/** The account's own app folder, creating it when missing. */
export async function ensureFolder(accountId: Id): Promise<Id> {
  const existing = await findAppFolder(accountId);
  if (existing) return existing;
  const set = await client.call<SetResponse<FileNode>>("FileNode/set", {
    accountId,
    create: { d: directoryCreate(null, APP_FOLDER) },
  });
  const err = set.notCreated?.d;
  if (err) throw new Error(setErrorMessage(err));
  return set.created!.d!.id;
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
