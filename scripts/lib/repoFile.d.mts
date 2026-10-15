/**
 * The shape every check reads one file as: its repository-relative path and its
 * text. The two ADR checks and the dead configuration check all hand files
 * around as this, so it is named once here rather than declared in each of the
 * three `.d.mts` files beside them.
 */
export interface RepoFile {
  /** Relative to the repository root. */
  path: string;
  text: string;
}

/** The `{ path, text }` a suite stages a file as. */
export function file(path: string, text: string): RepoFile;
