/**
 * The `{ path, text }` a check reads one file as, built once for every suite
 * that stages a file: the two ADR checks and the dead configuration check each
 * wrote the same one-line builder. The interface it satisfies is
 * `RepoFile` in `repoFile.d.mts`.
 */
export function file(path, text) {
  return { path, text };
}
