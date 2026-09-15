/**
 * Turning a drop into files and the folders to put them in.
 *
 * `dataTransfer.files` is flat: drag a folder in and it arrives either as
 * nothing at all or as the files inside it with their structure thrown away.
 * The structure is only reachable through `webkitGetAsEntry`, which is
 * non-standard in name and universal in practice -- Chrome, Firefox and Safari
 * all implement it, and there is no standard alternative to prefer.
 *
 * Two things about that API decide the shape of this file. Its entries go stale
 * the moment the drop handler returns, so they have to be read out
 * synchronously and the walking done afterwards. And `readEntries` returns *up
 * to* some number of entries per call rather than all of them, answering with
 * an empty array only when a directory is exhausted -- read it once and a large
 * folder silently loses everything past the first hundred or so.
 *
 * The result is a flat plan rather than a tree: every file, each with the
 * folder path it belongs under. The caller creates directories as it goes,
 * which keeps every JMAP call in one place instead of scattered through a
 * recursive walk.
 */

/** One file to upload, and the folder path it sits under relative to the drop. */
export interface PlannedUpload {
  file: File;
  /** Folder names from the drop target down to the file. Empty means "here". */
  path: string[];
}

interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (cb: (entries: EntryLike[]) => void, err: (e: unknown) => void) => void;
  };
}

/**
 * The entries a drop is carrying, read synchronously.
 *
 * Must be called from the drop handler itself, before any await: the items list
 * is emptied as soon as the event finishes dispatching.
 */
export function entriesFromDrop(dt: DataTransfer): EntryLike[] {
  const out: EntryLike[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }
    ).webkitGetAsEntry?.();
    if (entry) out.push(entry);
  }
  return out;
}

/** Whether a drop carries at least one directory, and so needs the slow path. */
export function hasDirectory(entries: EntryLike[]): boolean {
  return entries.some((e) => e.isDirectory);
}

function readFile(entry: EntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.file) return resolve(null);
    entry.file(resolve, () => resolve(null));
  });
}

/**
 * Every entry in a directory, across as many `readEntries` calls as it takes.
 *
 * An empty batch is the only end-of-directory signal the API has, so the read
 * is a loop with no length known in advance -- and one that has to be bounded
 * from this side. A reader that never empties would otherwise spin for ever,
 * and because each batch continues the loop from inside its own callback, a
 * synchronous one would take the stack down with it rather than merely hang.
 * `maxEntries` is far above any real folder and exists only so neither happens.
 */
function readAll(entry: EntryLike, maxEntries: number): Promise<EntryLike[]> {
  const reader = entry.createReader?.();
  if (!reader) return Promise.resolve([]);
  const found: EntryLike[] = [];
  let batches = 0;
  return new Promise((resolve) => {
    const step = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) return resolve(found);
          found.push(...batch);
          if (found.length >= maxEntries) return resolve(found);
          // A reader that answers synchronously continues the loop inside its own
          // callback, so unbroken recursion would overflow the stack on a large
          // folder. Unwinding every so often bounds it without paying a timer per
          // batch, which on a real folder is most of the wall clock.
          if (++batches % 64 === 0) setTimeout(step, 0);
          else step();
        },
        () => resolve(found),
      );
    };
    step();
  });
}

/**
 * Walk the dropped entries into a flat list of files and their folder paths.
 *
 * Both bounds are there because a directory tree from outside the app is not
 * something to take on trust: a symlink loop would otherwise walk until the tab
 * dies, and a directory that never reports itself exhausted would read for ever.
 * Neither limit is reachable by a folder anyone meant to upload.
 */
export async function planUpload(
  entries: EntryLike[],
  { maxDepth = 16, maxEntries = 20_000 } = {},
): Promise<PlannedUpload[]> {
  const out: PlannedUpload[] = [];
  const walk = async (entry: EntryLike, path: string[]): Promise<void> => {
    if (entry.isFile) {
      const file = await readFile(entry);
      if (file) out.push({ file, path });
      return;
    }
    if (!entry.isDirectory || path.length >= maxDepth) return;
    const children = await readAll(entry, maxEntries);
    for (const child of children) await walk(child, [...path, entry.name]);
  };
  for (const entry of entries) await walk(entry, []);
  return out;
}

/**
 * A folder path's identity as a map key.
 *
 * Joined with "/" rather than a plain space: a name a dropped folder can
 * actually carry (any OS's file picker forbids "/" in one path segment,
 * since it is the separator every filesystem uses) cannot collide across two
 * different nestings the way a space-joined key can -- a top-level folder
 * literally named "Documents 2024" and a nested "Documents/2024" would
 * otherwise produce the identical key in `files.ts`'s own uploadPlan, silently
 * merging two distinct folders and misfiling whichever files were dropped for
 * one into the other.
 */
export function folderPathKey(path: ReadonlyArray<string>): string {
  return path.join("/");
}

/** The distinct folder paths a plan needs, parents always before their children. */
export function foldersNeeded(plan: PlannedUpload[]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const item of plan) {
    for (let i = 1; i <= item.path.length; i++) {
      const prefix = item.path.slice(0, i);
      const key = folderPathKey(prefix);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(prefix);
    }
  }
  // Shorter paths first, so a folder is never created before its parent.
  return out.sort((a, b) => a.length - b.length);
}
