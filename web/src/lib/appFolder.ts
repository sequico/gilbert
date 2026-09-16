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
 * for the two sides to resolve differently. Gilbert is pre-release, so there is
 * no compatibility path for a folder under any other name: its documents are
 * neither read nor migrated.
 *
 * The lookup below filters on `parentId`/`isTopLevel` alone and matches the
 * name here rather than asking the server to. Those are the filters Files
 * itself relies on; `name` is not one Stalwart is known to implement, and a
 * filter it does not know fails the whole query rather than being ignored.
 */
import { appDocumentJson } from "@gilbert/shared/appDocument";
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, SetResponse } from "@/jmap/types";
import { directoryCreate, fileCreate } from "@/lib/filenode";

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

/**
 * A node found in a folder, with the state the read that found it saw.
 *
 * The state is the compare-and-set token: pass it to `putFile` as `ifInState`
 * and the write is refused if anything in the account changed since this read,
 * which is the only protection JMAP offers in place of a lock.
 */
export interface FoundNode extends FileNode {
  state?: string;
}

/**
 * The fields a read of a named file asks for.
 *
 * `state` is asked for beside the node's own fields, and the listing answers
 * with the account's FileNode state either way. It is what a conditional write
 * compares against: a caller that can find the document it means to replace,
 * but has nothing to make the write conditional on, cannot write safely
 * however careful it is.
 */
const fileProps = [
  "id",
  "name",
  "parentId",
  "blobId",
  "size",
  "type",
  "nodeType",
  "state",
];

/** Find a file by name inside the app folder, with the state that read saw. */
export async function findInFolder(
  accountId: Id,
  folderId: Id,
  name: string,
): Promise<FoundNode | undefined> {
  return (await findInFolderWithState(accountId, folderId, name)).file;
}

/**
 * The same read, answering the state even when no file carries that name.
 *
 * A writer that means to *create* the file needs a token as much as one that
 * means to replace it. The first save into an account is a create — the folder
 * holds no `settings.json` yet — and without a state to compare, two tabs that
 * each find nothing both create a file, and one of the two saves ends up in a
 * document nothing ever reads. With the state of the read that found nothing,
 * the second create is refused as a lost compare-and-set and retried against
 * the file the first tab made.
 */
export async function findInFolderWithState(
  accountId: Id,
  folderId: Id,
  name: string,
): Promise<{ file?: FoundNode; state: string }> {
  const { list, state } = await listChildrenWithState(accountId, folderId, fileProps);
  const found = list.find((n) => n.name === name && n.parentId === folderId);
  // One state per type per account, so any node changing anywhere in the
  // account invalidates the token — the comparison `FileNode/set` makes.
  return { file: found ? { ...found, state } : undefined, state };
}

/**
 * Whether a refusal is a lost compare-and-set.
 *
 * A write carrying a stale `ifInState` is refused with the error RFC 8620 §5.3
 * defines for it, which the client raises as its own typed error with the
 * server's `type` on it (`JmapMethodError`, `web/src/jmap/client.ts`) — so the
 * type is read off whatever arrived rather than off one error class, since the
 * refusal reaches the caller through `putFile` and has to be recognisable
 * there. Stalwart 0.16 answers exactly this type rather than masking it as
 * `invalidArguments` (live, `scripts/probe-conditional-writes.mjs`), and the
 * server tier recognises the same refusal the same way (`isStateMismatch`,
 * `server/src/jmap.ts`).
 */
export function isStateMismatch(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: unknown }).type === "stateMismatch"
  );
}

/**
 * One file write, whatever the bytes came from: create when the name is new
 * in this folder, update when it is taken.
 *
 * The one writer this client has for "a named file in a folder": `chat.ts`,
 * `signatureImages.ts`, the chat store and `settingsSync.ts` all go through it,
 * so find-then-`FileNode/set` exists once in this tree. `ifInState` is what
 * makes a write safe against a second writer — the caller passes the FileNode
 * state its own read saw, which is the `state` on the node `findInFolder`
 * returned, and the server refuses the write when anything in the account has
 * changed since. That refusal is the compare-and-set JMAP offers in place of a
 * lock: a save that loses it lands on nothing rather than on a document somebody
 * else has replaced in the meantime, and the caller that cares — the settings
 * writer, where `settings.json` is a name every tab saves to — retries by
 * re-reading. A caller with nothing to lose omits `opts.ifInState` and takes the
 * unconditional write; nothing here is conditional unless it is asked for. The
 * server's own twin, `putFile` in `server/src/appFolder.ts`, is the shape this
 * mirrors.
 */
export async function putFile(
  accountId: Id,
  folderId: Id,
  name: string,
  blobId: Id,
  type: string,
  opts: { ifInState?: string } = {},
): Promise<{ id: Id; blobId: Id }> {
  const existing = await findInFolder(accountId, folderId, name);
  const conditional = opts.ifInState ? { ifInState: opts.ifInState } : {};
  if (existing) {
    const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
      accountId,
      ...conditional,
      update: { [existing.id]: { blobId, type } },
    });
    const err = res.notUpdated?.[existing.id];
    if (err) throw new Error(setErrorMessage(err));
    return { id: existing.id, blobId };
  }
  const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
    accountId,
    ...conditional,
    create: { n: fileCreate(folderId, name, blobId, type) },
  });
  const err = res.notCreated?.n;
  if (err) throw new Error(setErrorMessage(err));
  const created = res.created?.n as Partial<FileNode> | undefined;
  const id = created?.id;
  if (!id) throw new Error("the file was created but the mail server returned no id");
  // Some servers hand back no blobId on create; ask, so a caller that needs
  // the persistent one straight away (a signature image's blob URL) has it.
  const resolvedBlobId = created?.blobId ?? (await nodeBlobId(accountId, id)) ?? blobId;
  return { id, blobId: resolvedBlobId };
}

/** Upload bytes and write them into a named file in a folder — one call. */
export async function writeBlobInFolder(
  accountId: Id,
  folderId: Id,
  name: string,
  data: Blob,
  type: string,
  opts: { ifInState?: string } = {},
): Promise<{ id: Id; blobId: Id }> {
  const up = await client.upload(accountId, data, { type });
  return putFile(accountId, folderId, name, up.blobId, type, opts);
}

/**
 * Upload a JSON document and write it into a named file in the account's app
 * folder, creating the folder when missing — the client-side twin of the
 * server's `writeAppFile`/`writeAppFileAt` (`server/src/appFolder.ts`).
 */
export async function writeAppJson(
  accountId: Id,
  name: string,
  value: unknown,
  opts: { ifInState?: string; type?: string } = {},
): Promise<{ id: Id; blobId: Id }> {
  const folderId = await ensureFolder(accountId);
  const type = opts.type ?? "application/json";
  // The bytes come from the one serializer both tiers write through, so the
  // document a browser saves is the document the server saves.
  const blob = new Blob([appDocumentJson(value)], { type });
  return writeBlobInFolder(accountId, folderId, name, blob, type, opts);
}
