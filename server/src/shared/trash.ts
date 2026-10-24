/**
 * The account's Trash: a top-level folder of its own, and the document that
 * remembers where each trashed node came from.
 *
 * Deleting in Files is a move (ADR 0013): a node goes into the account's Trash,
 * whole and with everything under it, and comes back from it. Every account has
 * one — the reader's own and each group's — because the folder is created in the
 * account the deletion happens in.
 *
 * The folder's own name is the whole identity, exactly as the app folder's is
 * (`isAppFolder`): no marker to leave and no second name to fall back to, so the
 * two tiers and every reader agree about which folder it is. The name is
 * internal and never shown — the surfaces draw it translated
 * (`fileNodeLabel`) — while the folder is ordinary enough for a JMAP client to
 * see it as what it is.
 *
 * The origins live in `gilbert/trash.json`, beside the other documents Gilbert
 * keeps: a trashed node is a child of the Trash folder, which no longer says
 * where it sat or what it was called before, and restoring it needs both answers
 * kept somewhere durable. Both tiers move nodes in and out, so the document's
 * shape is shared here while the transport stays each tier's own.
 */

/** The Trash folder's name at the top level of Files. Internal; the UI translates it. */
export const TRASH_FOLDER_NAME = "Trash";

/** The app-folder document that remembers each trashed node's original folder. */
export const TRASH_DOCUMENT = "trash.json";

/** Where a node sat, and what it was called, before it was trashed. */
export interface TrashOrigin {
  /** The folder it was in, `null` for the top level of Files. */
  parentId: string | null;
  /** The name it had before it was trashed. */
  name: string;
  /**
   * The name it landed with in the Trash, which is a numbered one when the
   * Trash already held that name.
   *
   * Kept apart from `name` so a restore can tell the two cases: a node still
   * called what it arrived as had its name only numbered by the move, and gets
   * its own back; a node renamed inside the Trash keeps the reader's name.
   */
  as: string;
}

/** The shape of `trash.json`. */
export interface TrashDocument {
  /**
   * Trashed node id → where it came from.
   *
   * A node trashed twice is one entry: the place it came from the first time is
   * the one a person means by "put it back".
   */
  origins: Record<string, TrashOrigin>;
}

/** The least a node has to say to be recognised as the Trash folder. */
interface TrashFolderNodeLike {
  name?: unknown;
  parentId?: unknown;
  nodeType?: unknown;
}

/**
 * Whether a node is the Trash folder: a top-level directory by that name.
 *
 * The same rule as `isAppFolder`, and for the same reason: a folder is found by
 * what it is called and where it sits rather than by a marker a client could
 * lose. A folder carrying the name inside some other folder is an ordinary
 * folder, not this one.
 */
export function isTrashFolder(node: TrashFolderNodeLike): boolean {
  return (
    (node.parentId ?? null) === null &&
    node.nodeType === "directory" &&
    String(node.name ?? "") === TRASH_FOLDER_NAME
  );
}

/**
 * Whether a visible path is the Trash, or anywhere inside it.
 *
 * Visible paths are `/`-joined from the top level of Files (`pathSegments` in
 * `appFolder.ts`), so the Trash is the **first** segment. The reader that
 * decides which changes may wake a rule asks this: what a person deleted is no
 * longer the group's work, and the move into the Trash is what a delete is.
 */
export function isTrashPath(path: string): boolean {
  return path === TRASH_FOLDER_NAME || path.startsWith(`${TRASH_FOLDER_NAME}/`);
}

/**
 * What a `trash.json` document says, tolerantly.
 *
 * A document this build cannot read answers "nothing is remembered", which is
 * the safe way round: a node restored without an origin goes back to the top
 * level of Files, where it is visible, rather than being guessed into somebody's
 * folder. An entry without a name is the same: there is nothing to put back.
 */
export function parseTrashDocument(value: unknown): TrashDocument {
  const origins: Record<string, TrashOrigin> = {};
  const held = (value as { origins?: unknown } | null)?.origins;
  if (held && typeof held === "object" && !Array.isArray(held)) {
    for (const [id, raw] of Object.entries(held as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as { parentId?: unknown; name?: unknown; as?: unknown };
      const name = typeof entry.name === "string" ? entry.name : "";
      if (!name) continue;
      origins[id] = {
        parentId: typeof entry.parentId === "string" ? entry.parentId : null,
        name,
        as: typeof entry.as === "string" && entry.as ? entry.as : name,
      };
    }
  }
  return { origins };
}

/** The document with `entries` remembered, every other origin left alone. */
export function withOrigins(
  doc: TrashDocument,
  entries: Record<string, TrashOrigin>,
): TrashDocument {
  return { origins: { ...doc.origins, ...entries } };
}

/** The document with `ids` forgotten — what a restore or a permanent delete does. */
export function withoutOrigins(doc: TrashDocument, ids: Iterable<string>): TrashDocument {
  const origins = { ...doc.origins };
  for (const id of ids) delete origins[id];
  return { origins };
}

/**
 * `name` when nothing holds it, otherwise the first free `base (n).ext`.
 *
 * Two trashed nodes can carry one name — the folder already held a copy of
 * "report.pdf" when the second one arrived — and a move that kept the name would
 * be refused by the server. The extension stays on the end, so the file a person
 * restores is still the file they put in.
 *
 * The bound is the same order the app folder's own `unusedVisibleName` uses: a
 * thousand copies of one name in one folder is not a state to keep trying past.
 */
export function uniqueName(taken: ReadonlySet<string>, name: string): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`"${name}" already has a thousand copies in this folder.`);
}
