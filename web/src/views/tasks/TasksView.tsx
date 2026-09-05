import { ListTodo, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TaskItem } from "@/jmap/types";
import { t } from "@/lib/i18n";
import { type TaskList, useTasks } from "@/store/tasks";
import { promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

/**
 * Generic to-do lists, separate from the calendar. A list is a calendar marked
 * `tasklist`; the reader's own lists come first, then subscribed group/shared
 * lists. The tasklist calendars never appear among the calendar surfaces -- the
 * calendar sidebar and the event editor both filter them out -- and tasks never
 * appear on the calendar grid.
 */

export function TaskSidebar() {
  const lists = useTasks((s) => s.lists);
  const tasks = useTasks((s) => s.tasks);
  const selectedId = useTasks((s) => s.selectedListId);

  const addList = async () => {
    const name = await promptDialog({
      title: t("New task list"),
      placeholder: t("Name"),
    });
    if (!name?.trim()) return;
    try {
      await useTasks.getState().createList(name.trim());
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <>
      <div className="nav-section">
        <span>{t("Task lists")}</span>
        <button
          className="icon-btn sm"
          title={t("New task list")}
          aria-label={t("New task list")}
          onClick={() => void addList()}
        >
          <Plus size={14} />
        </button>
      </div>
      {lists.map((l) => {
        const open = l.calendarId === selectedId;
        const openCount = Object.values(tasks).filter(
          (x) =>
            x.calendarIds?.[l.calendarId] &&
            x.progress !== "completed" &&
            x.progress !== "cancelled",
        ).length;
        return (
          <div
            key={`${l.accountId}:${l.calendarId}`}
            className={`nav-item ${open ? "active" : ""}`}
            onClick={() => useTasks.getState().select(l.calendarId)}
            title={l.accountName ? `${l.name} — ${l.accountName}` : l.name}
          >
            <ListTodo size={17} />
            <span className="grow truncate">{l.name}</span>
            {openCount > 0 && <span className="nav-count">{openCount}</span>}
          </div>
        );
      })}
      {!lists.length && (
        <p className="hint" style={{ padding: "4px 12px" }}>
          {t("No task lists yet.")}
        </p>
      )}
    </>
  );
}

function TaskRow({ task }: { task: TaskItem }) {
  const done = task.progress === "completed" || task.progress === "cancelled";
  const [busy, setBusy] = useState(false);
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
  const due = task.due?.slice(0, 10);
  return (
    <div className={`task-row ${done ? "done" : ""}`}>
      <button
        className="task-check"
        disabled={busy}
        aria-label={done ? t("Mark as not done") : t("Mark as done")}
        onClick={() => void act(() => useTasks.getState().setDone(task, !done))}
      >
        <span className="task-checkbox">{done ? <X size={14} /> : null}</span>
      </button>
      <span className="task-title">{task.title || t("(untitled)")}</span>
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
        onClick={() => void act(() => useTasks.getState().destroy(task))}
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

  const list = useMemo<TaskList | null>(
    () => lists.find((l) => l.calendarId === selectedId) ?? lists[0] ?? null,
    [lists, selectedId],
  );
  const ordered = useMemo(() => {
    const listTasks = list
      ? Object.values(tasks).filter((x) => x.calendarIds?.[list.calendarId])
      : [];
    return [...listTasks].sort((a, b) => {
      if ((a.progress === "completed") !== (b.progress === "completed"))
        return a.progress === "completed" ? 1 : -1;
      return (
        (a.priority ?? 9) - (b.priority ?? 9) ||
        String(a.title).localeCompare(String(b.title))
      );
    });
  }, [tasks, list]);

  useEffect(() => {
    void load();
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
    if (!title || !list) return;
    setQuick("");
    try {
      await useTasks.getState().create(list, title);
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
      <div className="task-list">
        {ordered.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
        {!ordered.length && (
          <p className="hint" style={{ padding: "12px" }}>
            {t("No tasks. Add one above.")}
          </p>
        )}
      </div>
    </div>
  );
}
