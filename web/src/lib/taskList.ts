/**
 * What makes a calendar a task list.
 *
 * A task list *is* a calendar in the account, marked rather than kept
 * somewhere else -- so the mark is read on both sides of the line: the tasks
 * module lists them, and the calendar must not draw them, nor the tasks inside
 * them, as events. It lives here rather than in either store because the two
 * stores would otherwise have to import each other for one string.
 */
export const TASKLIST_MARKER = "tasklist";

/** Whether a calendar is one of ours that holds tasks rather than events. */
export function isTaskCalendar(c: { description?: string | null } | undefined) {
  return Boolean(c) && c?.description === TASKLIST_MARKER;
}
