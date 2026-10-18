import type { FilesGet, FilesSet, FilesState } from "../types";

/**
 * What is being dragged, so every pane that could take it says so.
 *
 * A slice of the files store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function dragSlice(
  set: FilesSet,
  _get: FilesGet,
): Pick<FilesState, "setDragging"> {
  return {
    setDragging(ids) {
      set({ draggingIds: ids });
    },
  };
}
