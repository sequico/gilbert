import type { Id } from "@/jmap/types";

/**
 * What a click on a message row means.
 *
 * Lifted out of the list so the rules sit together and can be tested, because
 * the same click can be read two ways and what this returns is what the list
 * draws. Shift-click and ctrl-click sit in two branches of one handler and must
 * agree: a range includes the row it starts from, a ctrl-click selects one row,
 * and a row that is open but not selected is highlighted without being ticked —
 * both look picked, and only one is. That is issue #186, and the reason this is
 * a function rather than a comment asking the next person to be careful.
 */

export type RowClick =
  | { kind: "open" }
  | { kind: "select"; ids: Id[]; on: boolean; moveAnchor: boolean };

/**
 * The rows a shift-click covers: the run from the anchor to the row clicked,
 * **inclusive at both ends**, in the order they are shown. `null` when either
 * end is not on screen -- an anchor can name a row of a folder that is no
 * longer open, and a range to nowhere is not a range.
 *
 * Its own function because two lists select a run this way -- the mail list
 * and the Files list -- and the rule that both ends are in it is exactly the
 * thing that was got wrong once (issue #186).
 */
export function rangeIds(ids: Id[], anchor: Id | null, rowId: Id): Id[] | null {
  if (!anchor) return null;
  const from = ids.indexOf(anchor);
  const to = ids.indexOf(rowId);
  if (from < 0 || to < 0) return null;
  const [start, end] = from < to ? [from, to] : [to, from];
  return ids.slice(start, end + 1);
}

export function rowClick(opts: {
  /** The row clicked. */
  rowId: Id;
  /** Every row on screen, in the order they are shown. */
  ids: Id[];
  /** The row a range would extend from: the last one clicked without shift. */
  anchor: Id | null;
  selected: Record<Id, boolean>;
  modifiers: { shift: boolean; ctrl: boolean };
  isMobile: boolean;
}): RowClick {
  const { rowId, ids, anchor, selected, modifiers, isMobile } = opts;
  const selectedCount = Object.keys(selected).length;

  // A range, from the anchor to here, inclusive at both ends.
  if (modifiers.shift) {
    const run = rangeIds(ids, anchor, rowId);
    // The anchor stays where it is, so extending the range again grows it
    // from the same place rather than from wherever it last reached.
    if (run) return { kind: "select", ids: run, on: true, moveAnchor: false };
  }

  if (modifiers.ctrl) {
    /*
     * The row that is already current joins the selection.
     *
     * Opening a message does not select it -- it is highlighted because it is
     * the one being read, which is a different state -- so picking a second one
     * with ctrl would otherwise select only the second, and every action that
     * followed would quietly apply to half of what the screen shows.
     *
     * Only while nothing is selected yet. Once there is a selection, ctrl-click
     * toggles exactly one row, which is the whole point of it.
     */
    if (!selectedCount && anchor && anchor !== rowId && ids.includes(anchor)) {
      return { kind: "select", ids: [anchor, rowId], on: true, moveAnchor: true };
    }
    return { kind: "select", ids: [rowId], on: !selected[rowId], moveAnchor: true };
  }

  // On a touchscreen, once anything is selected a plain tap goes on selecting:
  // there is no modifier to hold, and opening a message mid-selection is almost
  // never what the tap meant.
  if (selectedCount > 0 && isMobile) {
    return { kind: "select", ids: [rowId], on: !selected[rowId], moveAnchor: true };
  }

  return { kind: "open" };
}
