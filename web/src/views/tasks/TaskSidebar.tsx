import { ListTodo, Plus, Trash2 } from "lucide-react";
import { Fragment, useMemo } from "react";
import type { Id } from "@/jmap/types";
import { t } from "@/lib/i18n";
import { useCalendar } from "@/store/calendar";
import { useMail } from "@/store/mail";
import { type TaskList, taskListKey, useTasks } from "@/store/tasks";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

/**
 * The task-list pane of the module sidebar: the reader's own lists first,
 * then one section per group mailbox, then lists shared from accounts that
 * are not a group (shown read-only). The tasks feature and its lazy-creation
 * model are documented at the top of TasksView.tsx.
 */

export function TaskSidebar() {
  const lists = useTasks((s) => s.lists);
  const tasks = useTasks((s) => s.tasks);
  const selectedId = useTasks((s) => s.selectedListId);
  const ownAccountId = useCalendar((s) => s.accountId);
  const mailAccounts = useMail((s) => s.mailAccounts);
  /* Derived outside the selector: a filter there would build a fresh array on
     every mail-store change and re-render the sidebar for mail it does not
     read (see MailboxTree for the same pattern). */
  const groups = useMemo(
    () => mailAccounts.filter((a) => a.kind === "group"),
    [mailAccounts],
  );

  const addList = async (accountId: Id | null) => {
    if (!accountId) return;
    const name = await promptDialog({
      title: t("New task list"),
      placeholder: t("Name"),
    });
    if (!name?.trim()) return;
    try {
      await useTasks.getState().createList(accountId, name.trim());
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const removeList = async (list: TaskList) => {
    const group = list.accountName;
    const ok = await confirmDialog({
      title: t("Delete “{name}”?", { name: list.name }),
      message: group
        ? t("All its tasks will be deleted, for every member of {group}.", {
            group,
          })
        : t("All tasks in this list will be deleted."),
      confirmLabel: t("Delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await useTasks.getState().destroyList(list);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  /* A task belongs to a list when its key is under the list's account *and*
     it names the list's calendar — a group list whose calendar id matches an
     own one must not count the own list's tasks. */
  const openCount = (l: TaskList) =>
    Object.entries(tasks).filter(
      ([k, x]) =>
        k.startsWith(`${l.accountId}/`) &&
        x.calendarIds?.[l.calendarId] &&
        x.progress !== "completed" &&
        x.progress !== "cancelled",
    ).length;

  const listRow = (l: TaskList, canDelete: boolean) => {
    const key = taskListKey(l.accountId, l.calendarId);
    const open = key === selectedId;
    return (
      <div
        key={key}
        className={`nav-item ${open ? "active" : ""}`}
        onClick={() => useTasks.getState().select(key)}
        title={l.accountName ? `${l.name} — ${l.accountName}` : l.name}
      >
        <ListTodo size={17} />
        <span className="grow truncate">{l.name}</span>
        {openCount(l) > 0 && <span className="nav-count">{openCount(l)}</span>}
        {canDelete && (
          <button
            className="icon-btn xs nav-more"
            title={t("Delete task list")}
            aria-label={t("Delete task list")}
            onClick={(e) => {
              e.stopPropagation();
              void removeList(l);
            }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    );
  };

  const groupIds = new Set(groups.map((g) => g.accountId));
  const ownLists = lists.filter((l) => l.accountId === ownAccountId);
  /* A task list that lives in a non-personal account that is not one of the
     reader's group mailboxes (a colleague's calendar-only share) still shows
     under a read-only heading rather than vanishing from the sidebar. */
  const sharedOnly = lists.filter(
    (l) => l.accountId !== ownAccountId && !groupIds.has(l.accountId),
  );

  return (
    <>
      <div className="nav-section">
        <span>{t("My task lists")}</span>
        {ownAccountId && (
          <button
            className="icon-btn sm"
            title={t("New task list")}
            aria-label={t("New task list")}
            onClick={() => void addList(ownAccountId)}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {ownLists.map((l) => listRow(l, true))}
      {groups.map((g) => (
        <Fragment key={g.accountId}>
          <div className="nav-section">
            <span className="grow truncate" title={g.name}>
              {g.name}
            </span>
            <button
              className="icon-btn sm"
              title={t("New task list")}
              aria-label={t("New task list in {group}", { group: g.name })}
              onClick={() => void addList(g.accountId)}
            >
              <Plus size={14} />
            </button>
          </div>
          {lists.filter((l) => l.accountId === g.accountId).map((l) => listRow(l, true))}
        </Fragment>
      ))}
      {sharedOnly.length > 0 && (
        <Fragment>
          <div className="nav-section">
            <span>{t("Shared with me")}</span>
          </div>
          {/* Read-only: these live in an account that is not one of the
              reader's groups, so there is no "new list here" and no delete
              of somebody else's calendar. */}
          {sharedOnly.map((l) => listRow(l, false))}
        </Fragment>
      )}
      {!lists.length && (
        <p className="hint" style={{ padding: "4px 12px" }}>
          {t("No task lists yet.")}
        </p>
      )}
    </>
  );
}
