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
 * Which folder that is is **one rule, kept once**: `@gilbert/shared/appFolder`
 * owns the predicate and the find-then-create both tiers run, and this module is
 * that rule over the client's transport. There is one name, and the name is the
 * whole rule: no marker to leave, no second name to fall back to, nothing for
 * the two sides to resolve differently. Gilbert is pre-release, so there is no
 * compatibility path for a folder under any other name: its documents are
 * neither read nor migrated.
 *
 * The lookup below filters on `parentId`/`isTopLevel` alone and matches the
 * name here rather than asking the server to. Those are the filters Files
 * itself relies on; `name` is not one Stalwart is known to implement, and a
 * filter it does not know fails the whole query rather than being ignored.
 */
import { appDocumentJson } from "@gilbert/shared/appDocument";
import {
  APP_DOCUMENT_TYPE,
  APP_FOLDER_NAME,
  appFolderCreate,
  ensureAppFolderId,
  findAppFolderId,
} from "@gilbert/shared/appFolder";

/*
 * The folder's name is the shared constant's, not this module's: the predicate
 * that finds the folder reads it, on both tiers. Re-exported because this tier's
 * surfaces name it when they decide what to show or where to write.
 */
export { APP_FOLDER_NAME };

import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, SetResponse } from "@/jmap/types";
import { fileCreate } from "@/lib/filenode";

/** Just enough to find the folder. */
export const folderProps = (): string[] => ["id", "name", "nodeType", "parentId"];

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
 *
 * What comes back is the page and the two things about it a caller cannot work
 * out for itself:
 *
 *  - `list` -- the nodes the `get` resolved. This is what a caller reads.
 *  - `total` -- the population the **query matched**, and only ever what the
 *    server said. It is `undefined` when the server did not report one, and
 *    deliberately *not* filled in with the page size: a caller that then
 *    compares it against the page needs to know the difference between "the
 *    server said there are 800" and "nobody said, and 800 is what I happened
 *    to get back".
 *
 * How much of a level a page is, is a question this deliberately does not
 * answer. Nothing in the client asks it: the Files store resolves folders from
 * the page and lets the write itself answer for a name (ADR 0013), and a caller
 * that pages -- chat, walking its transcript -- knows what it asked for and
 * what came back. So the ceilings are described through the two values above
 * rather than through a verdict about them: `list` is what the `get` resolved,
 * `total` is what the query matched, and the two disagree exactly when the
 * `get`'s own ceiling (`maxObjectsInGet`) cut a query that was itself
 * complete. A caller needing a verdict draws it from `total` where the server
 * reported one and from its own page size where it did not.
 *
 * `scope` is which nodes to look at. `"level"` (the default) is one folder:
 * the children of `parentId`, or the top level when it is null. `"account"` is
 * every node in the account, no filter at all -- the read a tree walk makes so
 * that it can resolve a whole depth of folders from one request.
 */
export async function listChildrenWithState(
  accountId: Id,
  parentId: Id | null,
  properties: string[],
  opts: { position?: number; limit?: number; scope?: "level" | "account" } = {},
): Promise<{
  list: FileNode[];
  state: string;
  total: number | undefined;
}> {
  const filter =
    opts.scope === "account" ? undefined : parentId ? { parentId } : { isTopLevel: true };
  const res = await client.chain([
    [
      "FileNode/query",
      {
        accountId,
        ...(filter ? { filter } : {}),
        position: opts.position ?? 0,
        limit: opts.limit ?? 1000,
      },
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
    total: query.total,
  };
}

/**
 * The account's own app folder, or null when there is not one yet.
 *
 * What the folder *is* is `@gilbert/shared/appFolder`'s rule, which the server
 * asks as well: this is that rule over this tier's transport.
 */
export async function findAppFolder(accountId: Id): Promise<Id | null> {
  return findAppFolderId((parentId) =>
    children(accountId, parentId, folderProps()),
  );
}

/** The account's own app folder, creating it when missing. */
export async function ensureFolder(accountId: Id): Promise<Id> {
  return ensureAppFolderId(
    (parentId) => children(accountId, parentId, folderProps()),
    async () => {
      const set = await client.call<SetResponse<FileNode>>("FileNode/set", {
        accountId,
        create: { d: appFolderCreate() },
      });
      const err = set.notCreated?.d;
      if (err) throw new Error(setErrorMessage(err));
      return set.created!.d!.id;
    },
  );
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
  const type = opts.type ?? APP_DOCUMENT_TYPE;
  // The bytes come from the one serializer both tiers write through, so the
  // document a browser saves is the document the server saves.
  const blob = new Blob([appDocumentJson(value)], { type });
  return writeBlobInFolder(accountId, folderId, name, blob, type, opts);
}
