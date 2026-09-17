import { useState } from "react";
import type { FileNode } from "@/jmap/types";
import { folderKey } from "@/lib/folderView";
import {
  type FilesSort,
  type FilesSortKey,
  loadFilesSort,
  placeOwnerFrom,
  rememberFilesSort,
} from "@/lib/lastPlace";
import { useSession } from "@/store/session";

/**
 * The order a folder's listing is drawn in, and where that is remembered.
 *
 * **Sorted here rather than by the server, and the bound that costs is worth
 * stating.** The message list asks Stalwart to sort, because a mailbox is read
 * a page at a time and sorting fifty of ten thousand would be a lie about the
 * rest. A Files listing is read in one request of up to `LEVEL_LIMIT` nodes
 * (`loadChildren`), so this orders everything the browser holds of this folder
 * -- a folder larger than that ceiling is already a listing only part of which
 * is on screen. Asking the server instead is not the safer half of that trade:
 * of the three columns, `name` is a sort the listing already sends and the
 * server answers, `size` and `modified` on a FileNode are verified nowhere in
 * this repo, the mock ignores `FileNode/query`'s `sort` altogether (so a
 * server-side order would be untestable in `dev:mock`), and a sort the server
 * does not know **fails the whole query** rather than the order -- which would
 * blank a folder instead of ordering it.
 *
 * **Folders come first, whatever the column.** A directory has no size, and
 * the tree above the list is already the one place folders are ordered by name;
 * a Size sort that scattered folders through the files would be sorting by
 * nothing. Within each of the two groups the column decides, and a tie on the
 * column falls back to the name, so the order is the same on two devices.
 */
export function sortFiles(nodes: FileNode[], sort: FilesSort): FileNode[] {
  const rank = (n: FileNode) => (n.nodeType === "directory" ? 0 : 1);
  const byName = (a: FileNode, b: FileNode) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  /* `UTCDate` is an ISO-8601 instant in UTC (`jmap/types.ts`), so the strings
     compare in time order and no parsing is needed to order two of them. */
  const stamp = (n: FileNode) => n.modified ?? n.created;
  return [...nodes].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    let by: number;
    if (sort.key === "name") by = byName(a, b);
    else if (sort.key === "size") by = (a.size ?? 0) - (b.size ?? 0);
    else by = stamp(a).localeCompare(stamp(b));
    if (by === 0) return byName(a, b);
    return sort.desc ? -by : by;
  });
}

export interface FilesSortControl {
  sort: FilesSort;
  /** The header a reader just clicked: its column, or that column reversed. */
  toggle(key: FilesSortKey): void;
}

/**
 * One folder's order, read for this reader and written back on every change.
 *
 * Remembered per folder and per account (`folderKey`), in the same device-local
 * record as the open folders and the place the reader was left in -- it is
 * where they were reading, not a preference to carry to another machine.
 *
 * The read happens **while rendering**, not in an effect, because the folder in
 * the key changes on every navigation: an effect would draw the new folder's
 * first frame in the previous folder's order and correct it a moment later,
 * which is exactly the frame the reader is looking at when they click between
 * two folders sorted differently. Adjusting state during a render is safe here
 * because it is guarded -- the next render takes the branch and stops.
 *
 * One folder in the key and not one order for Files: a download folder by date
 * and a documents folder by name is how people file, and reading a different
 * folder must not reorder the one behind it. A change of reader replaces rather
 * than merges, for the same reason the open folders do.
 */
export function useFilesSort(
  accountId: string | null,
  folderId: string | null,
): FilesSortControl {
  const owner = useSession((s) => placeOwnerFrom(s));
  const folder = folderKey(accountId, folderId ?? "root");
  const [state, setState] = useState(() => ({
    owner,
    folder,
    sort: loadFilesSort(owner, folder),
  }));

  if (state.owner !== owner || state.folder !== folder)
    setState({ owner, folder, sort: loadFilesSort(owner, folder) });

  return {
    sort: state.sort,
    toggle: (key) => {
      /* Two states, so the column in force reverses and any other column
         replaces it -- ascending, which is how every table starts. */
      const next: FilesSort =
        state.sort.key === key ? { key, desc: !state.sort.desc } : { key, desc: false };
      setState({ owner, folder, sort: next });
      rememberFilesSort(owner, folder, next);
    },
  };
}
