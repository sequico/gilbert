/**
 * The app folder in JMAP Files — `gilbert` — where the client keeps its own
 * state: signature images and over-sized signature HTML (Stalwart caps a
 * signature at 2 KB), and the synced settings file.
 *
 * It is a real folder in the user's account — that is the whole point, since it
 * is what makes this state travel between devices without Gilbert storing
 * anything server-side of its own — but it is housekeeping rather than
 * something anyone filed there, so the Files view hides it. See `isAppFolder`.
 *
 * Until the 2026-09-06 rebrand the folder was called `ihasmail`. That name is
 * data sitting in every account, so it is not simply dropped: `ensureFolder`
 * renames a leftover top-level `ihasmail` folder to `gilbert` in place —
 * children and blobs untouched — on the first open that finds one, and every
 * open afterwards sees only `gilbert`. The legacy name lives in exactly one
 * place (the constant below, and the migration in `ensureFolder`); nothing
 * else reads or writes it.
 *
 * Both lookups below filter on `parentId`/`isTopLevel` alone and match the name
 * here rather than asking the server to. Those are the filters Files itself
 * relies on; `name` is not one Stalwart is known to implement, and a filter it
 * does not know fails the whole query rather than being ignored.
 */
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, SetResponse } from "@/jmap/types";
import { directoryCreate } from "@/lib/filenode";

export const APP_FOLDER = "gilbert";
/** What the app folder was called before the rebrand; migrated on first open. */
const LEGACY_APP_FOLDER = "ihasmail";

/** Just enough to find the folder. */
export const folderProps = (): string[] => ["id", "name", "nodeType", "parentId"];

/** The client's own folder, which the Files view does not show. */
export function isAppFolder(
  n: Pick<FileNode, "name" | "parentId" | "nodeType">,
): boolean {
  return n.name === APP_FOLDER && !n.parentId && n.nodeType === "directory";
}

/**
 * Which of the listed top-level nodes is the app folder, and what to do with
 * it. Pure, so the migration rule is testable without a server.
 *
 * - `current`: a `gilbert` folder already exists — use it.
 * - `legacy`: only the old `ihasmail` folder exists — rename it to `gilbert`.
 * - `none`: neither — the caller creates `gilbert`.
 *
 * `gilbert` wins when both exist: the legacy one is then somebody else's
 * leftover (a pre-migration client that ran after ours), not the app folder.
 */
export function appFolderCandidate(
  nodes: Pick<FileNode, "id" | "name" | "parentId" | "nodeType">[],
): { kind: "current" | "legacy" | "none"; id?: Id } {
  const topLevelDir = (n: (typeof nodes)[number]) =>
    !n.parentId && n.nodeType === "directory";
  const current = nodes.find((n) => topLevelDir(n) && n.name === APP_FOLDER);
  if (current) return { kind: "current", id: current.id };
  const legacy = nodes.find((n) => topLevelDir(n) && n.name === LEGACY_APP_FOLDER);
  return legacy ? { kind: "legacy", id: legacy.id } : { kind: "none" };
}

/** List one level of the tree: the top level, or the children of a folder. */
async function children(
  accountId: Id,
  parentId: Id | null,
  properties: string[],
): Promise<FileNode[]> {
  const filter = parentId ? { parentId } : { isTopLevel: true };
  const res = await client.chain([
    ["FileNode/query", { accountId, filter, limit: 1000 }, "q"],
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
  return (g as unknown as GetResponse<FileNode>).list;
}

/**
 * Find the app folder, make it as `gilbert`, or rename the leftover `ihasmail`
 * one into place. Returns its node id.
 */
export async function ensureFolder(accountId: Id): Promise<Id> {
  const candidate = appFolderCandidate(await children(accountId, null, folderProps()));
  if (candidate.kind === "current") return candidate.id!;
  if (candidate.kind === "legacy") {
    const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
      accountId,
      update: { [candidate.id!]: { name: APP_FOLDER } },
    });
    const err = res.notUpdated?.[candidate.id!];
    if (!err) return candidate.id!;
    // Somebody else renamed (or removed) the folder between our listing and our
    // rename — resolve to the current state instead of failing the open.
    const now = appFolderCandidate(await children(accountId, null, folderProps()));
    if (now.kind === "current") return now.id!;
    throw new Error(setErrorMessage(err));
  }
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
