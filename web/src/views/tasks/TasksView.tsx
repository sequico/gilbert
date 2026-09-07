import { GripVertical, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Id, TaskItem } from "@/jmap/types";
import { t } from "@/lib/i18n";
import { useCalendar } from "@/store/calendar";
import { orderIndexOf, type TaskList, taskListKey, useTasks } from "@/store/tasks";
import { toast } from "@/ui/toast";

/**
 * Generic to-do lists, separate from the calendar. A list is a calendar marked
 * `tasklist`; the reader's own lists come first, then a section per group
 * mailbox (labels, added only when the reader asks). The tasklist calendars
 * never appear among the calendar surfaces -- the calendar sidebar and the
 * event editor both filter them out -- and tasks never appear on the grid.
 *
 * Creation is lazy on purpose: pressing "+" on a group that has no list yet
 * creates its first task-list calendar (a list *is* a calendar), and a group
 * the reader never writes to leaves nothing behind in Stalwart. Deleting the
 * last list of a group deletes that calendar with it.
 */

function isDone(task: TaskItem): boolean {
  return task.progress === "completed" || task.progress === "cancelled";
}

interface RowDragProps {
  dragging: boolean;
  dropTarget: boolean;
  onStart(e: React.DragEvent): void;
  onEnd(): void;
  onRowOver(e: React.DragEvent): void;
  onRowDrop(e: React.DragEvent): void;
}

function TaskRow({
  list,
  task,
  drag,
}: {
  list: TaskList;
  task: TaskItem;
  drag?: RowDragProps;
}) {
  const done = isDone(task);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  // Enter/Escape tear the input down, and the teardown blur must not save.
  const skipBlur = useRef(false);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const commitTitle = async () => {
    const next = title.trim();
    setEditing(false);
    if (!next || next === task.title) return;
    await act(() => useTasks.getState().update(list, task, { title: next }));
  };
  const startEditing = () => {
    skipBlur.current = false;
    setTitle(task.title ?? "");
    setEditing(true);
  };
  const due = task.due?.slice(0, 10);
  const cls = ["task-row"];
  if (done) cls.push("done");
  if (drag?.dragging) cls.push("dragging");
  if (drag?.dropTarget) cls.push("drop-target");
  return (
    <div
      className={cls.join(" ")}
      draggable={!done && Boolean(drag)}
      onDragStart={drag?.onStart}
      onDragEnd={drag?.onEnd}
      onDragOver={drag?.onRowOver}
      onDrop={drag?.onRowDrop}
    >
      {/* The conventional drag affordance: a handle on the left, before the
          checkbox. Decorative -- the whole row is the drag surface -- so it is
          aria-hidden and hidden with the row when a finished task can no
          longer move. */}
      {!done && (
        <span className="task-grip" aria-hidden="true">
          <GripVertical size={14} />
        </span>
      )}
      <button
        className="task-check"
        disabled={busy}
        aria-label={done ? t("Mark as not done") : t("Mark as done")}
        onClick={() => void act(() => useTasks.getState().setDone(list, task, !done))}
      >
        <span className="task-checkbox">{done ? <X size={14} /> : null}</span>
      </button>
      {editing ? (
        <input
          className="task-title input"
          autoFocus
          value={title}
          disabled={busy}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (!skipBlur.current) void commitTitle();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              skipBlur.current = true;
              void commitTitle();
            } else if (e.key === "Escape") {
              skipBlur.current = true;
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className="task-title"
          title={t("Double-click to rename")}
          onDoubleClick={startEditing}
        >
          {task.title || t("(untitled)")}
        </span>
      )}
      {task.priority != null && (
        <span className="task-priority" title={t("Priority")}>
          P{task.priority}
        </span>
      )}
      {due && <span className="task-due">{due}</span>}
      <button
        className="icon-btn sm task-delete"
        aria-label={t("Delete task")}
        title={t("Delete task")}
        onClick={() => void act(() => useTasks.getState().destroy(list, task))}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

export function TasksView() {
  const lists = useTasks((s) => s.lists);
  const tasks = useTasks((s) => s.tasks);
  const selectedId = useTasks((s) => s.selectedListId);
  const load = useTasks((s) => s.load);
  const [quick, setQuick] = useState("");
  const [dragId, setDragId] = useState<Id | null>(null);
  const [overId, setOverId] = useState<Id | null>(null);

  const list = useMemo<TaskList | null>(
    () =>
      lists.find((l) => taskListKey(l.accountId, l.calendarId) === selectedId) ??
      lists[0] ??
      null,
    [lists, selectedId],
  );
  const ordered = useMemo(() => {
    const listTasks = list
      ? Object.entries(tasks)
          .filter(([k]) => k.startsWith(`${list.accountId}/`))
          .map(([, t]) => t)
          .filter((x) => x.calendarIds?.[list.calendarId])
      : [];
    return [...listTasks].sort((a, b) => {
      const da = isDone(a);
      const db = isDone(b);
      if (da !== db) return da ? 1 : -1;
      // Done tasks keep their place among themselves; the open block is what
      // the drag reorders, so its keys are contiguous 0..n-1 after a drag.
      const oa = orderIndexOf(a) ?? Infinity;
      const ob = orderIndexOf(b) ?? Infinity;
      if (oa !== ob) return oa - ob;
      return (
        (a.priority ?? 9) - (b.priority ?? 9) ||
        String(a.title).localeCompare(String(b.title))
      );
    });
  }, [tasks, list]);
  const openOrder = useMemo(
    () => ordered.filter((x) => !isDone(x)).map((x) => x.id),
    [ordered],
  );

  const persistOrder = async (ids: Id[]) => {
    if (!list) return;
    try {
      await useTasks.getState().reorder(list, ids);
    } catch (err) {
      toast.error((err as Error).message);
      // The reorder was refused: put the list back to what the server holds.
      await useTasks
        .getState()
        .load()
        .catch(() => {});
    }
  };

  /*
   * Drop placement is decided by which half of the row the pointer is over:
   * the top half puts the dragged task before the target, the bottom half
   * after it. The bottom half of the last row is therefore how a task lands
   * at the very end, and a drop on the empty list area below the rows
   * appends too (targetId === null). Everything is computed on the open
   * order after the dragged task has been removed, so the target's own index
   * already reflects that removal.
   */
  const finishDrag = (targetId: Id | null, after: boolean) => {
    const id = dragId;
    setDragId(null);
    setOverId(null);
    if (!id || !list) return;
    const next = [...openOrder];
    const from = next.indexOf(id);
    if (from < 0) return;
    next.splice(from, 1);
    if (targetId === null) {
      next.push(id);
    } else {
      const to = next.indexOf(targetId);
      if (to < 0) return;
      next.splice(after ? to + 1 : to, 0, id);
    }
    void persistOrder(next);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      /*
       * Group and shared calendars are fetched when the calendar store starts
       * up; accounts can appear in the session later than that (a group
       * mailbox discovered by the mail pane), so opening Tasks re-asks for
       * them — a group task list that never appeared is usually one whose
       * calendar was never loaded, and the calendar store's own reload on
       * session changes is the backstop.
       */
      await useCalendar
        .getState()
        .loadSharedCalendars()
        .catch(() => {});
      if (!cancelled) void load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    const onNew = () => {
      const input = document.querySelector<HTMLInputElement>(".task-quick input");
      input?.focus();
    };
    window.addEventListener("ihm:new-task", onNew);
    return () => window.removeEventListener("ihm:new-task", onNew);
  }, []);

  const submit = async () => {
    const title = quick.trim();
    if (!title) return;
    /* A brand-new account has no task lists at all: the quick-add still has
       to land the task somewhere, so the reader's own first list is created
       on the spot (named like the classic default) before the task goes
       in. Group lists stay lazy — pressing “+” on a group makes that
       group's first list; typing here never leaves a list behind on a group
       the reader did not ask to write to. */
    try {
      let target = list;
      if (!target) {
        const own = useCalendar.getState().accountId;
        if (own) {
          const ownList = lists.find((l) => l.accountId === own);
          if (ownList) target = ownList;
          else {
            const id = await useTasks.getState().createList(own, t("My Tasks"));
            const made = useTasks
              .getState()
              .lists.find((l) => l.accountId === own && l.calendarId === id);
            if (made) target = made;
          }
        }
      }
      if (!target) return;
      setQuick("");
      await useTasks.getState().create(target, title);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="tasks">
      <div className="task-quick">
        <Plus size={16} />
        <input
          value={quick}
          placeholder={t("Add a task, then press Enter")}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
      </div>
      <div
        className="task-list"
        onDragOver={
          dragId
            ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }
            : undefined
        }
        onDrop={
          dragId
            ? (e) => {
                // Rows handle their own drop; anything else — the gap below
                // the last row — appends the task to the end.
                if ((e.target as HTMLElement).closest(".task-row")) return;
                e.preventDefault();
                finishDrag(null, false);
              }
            : undefined
        }
      >
        {list &&
          ordered.map((t) => {
            const id = t.id;
            const drag: RowDragProps = {
              dragging: dragId === id,
              dropTarget: !!dragId && dragId !== id && overId === id && !isDone(t),
              onStart: (e) => {
                // Buttons and the rename input must keep their own gestures;
                // a drag that begins on one of them is a mis-drag.
                if ((e.target as HTMLElement).closest("button, input")) {
                  e.preventDefault();
                  return;
                }
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", id);
                setDragId(id);
              },
              onEnd: () => {
                setDragId(null);
                setOverId(null);
              },
              onRowOver: (e) => {
                if (!dragId || dragId === id || isDone(t)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOverId(id);
              },
              onRowDrop: (e) => {
                e.preventDefault();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                finishDrag(id, e.clientY > r.top + r.height / 2);
              },
            };
            return (
              <TaskRow
                key={id}
                list={list}
                task={t}
                drag={isDone(t) ? undefined : drag}
              />
            );
          })}
        {!ordered.length && (
          <p className="hint" style={{ padding: "12px" }}>
            {t("No tasks. Add one above.")}
          </p>
        )}
      </div>
    </div>
  );
}
