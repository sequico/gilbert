import { create } from "zustand";
import { chunk, client, setErrorMessage } from "@/jmap/client";
import type { GetResponse, Id, SetResponse, TaskItem } from "@/jmap/types";
import { useCalendar } from "./calendar";
import { useSession } from "./session";

/**
 * Generic to-do lists, kept apart from the calendar grid.
 *
 * A task list is a calendar whose `description` is the `tasklist` marker, and
 * a task is a JSCalendar `Task` object inside it. Reading the reader's own and
 * subscribed shared (including group) calendars through the calendar store is
 * deliberate: discovery, subscription and the account-of-a-calendar logic
 * already live there, and this store only adds the task-shaped queries and
 * writes on top.
 */

export const TASKLIST_MARKER = "tasklist";

/** Keyword prefix that carries a task's position inside its list. */
const ORDER_KEY = "order-";

const TASK_PROPS = [
  "id",
  "@type",
  "uid",
  "calendarIds",
  "title",
  "description",
  "progress",
  "due",
  "priority",
  "percentComplete",
  "keywords",
  "relatedTo",
];

export interface TaskList {
  accountId: Id;
  accountName?: string;
  calendarId: Id;
  name: string;
  color?: string | null;
}

export interface TaskState {
  /** The reader's own calendars account. */
  accountId: Id | null;
  lists: TaskList[];
  tasks: Record<string, TaskItem>;
  loaded: boolean;
  /**
   * Which list the Tasks view is showing, as its account-qualified key — a
   * calendar id is only unique within its account, so the reader's own list
   * and a group's can share an id and a bare one would pick the wrong list.
   */
  selectedListId: string | null;
  select(key: string): void;
  load(): Promise<void>;
  create(
    list: TaskList,
    title: string,
    opts?: { due?: string; priority?: number },
  ): Promise<Id>;
  setDone(task: TaskItem, done: boolean): Promise<void>;
  update(task: TaskItem, patch: Record<string, unknown>): Promise<void>;
  destroy(task: TaskItem): Promise<void>;
  /** Persist a new manual order for the open tasks of a list. */
  reorder(list: TaskList, orderedIds: Id[]): Promise<void>;
  createList(name: string): Promise<Id>;
  /** A task-list account (own or shared) changed its events or calendars. */
  applyChanges(types: Set<string>, accountId?: Id): void;
}

/** The position a task carries in its keywords, or null when never ordered. */
/** The position a task carries in its keywords, or null when never ordered. */
export function orderIndexOf(task: TaskItem): number | null {
  let found: number | null = null;
  for (const [k, v] of Object.entries(task.keywords ?? {})) {
    if (!k.startsWith(ORDER_KEY) || v !== true) continue;
    const n = Number(k.slice(ORDER_KEY.length));
    if (Number.isFinite(n) && (found === null || n < found)) found = n;
  }
  return found;
}

/*
 * Builds the keywords patch for one task at `index`.
 *
 * Servers disagree on how an object-valued property patch is applied: some
 * replace the whole map (the mock does), JMAP-style ones merge per key where
 * `false` removes a keyword. Sending every key is correct under both -- the
 * stale positions go out as `false` (removal when merged, inert when
 * replaced) and only true-valued keys are ever read back as positions.
 */
function orderKeywords(task: TaskItem, index: number | null): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const wanted = index === null ? null : `${ORDER_KEY}${index}`;
  for (const [k, v] of Object.entries(task.keywords ?? {})) {
    out[k] = k.startsWith(ORDER_KEY) ? k === wanted : v;
  }
  if (wanted) out[wanted] = true;
  return out;
}

const taskKey = (accountId: Id, id: Id): string => `${accountId}/${id}`;

/**
 * A task list's stable key: account and calendar together, since a calendar
 * id is only unique within its account. Selection and the change checks key
 * on this, never on the bare calendar id.
 */
export function taskListKey(accountId: Id, calendarId: Id): string {
  return `${accountId}/${calendarId}`;
}

function isTasklist(c: { description?: string | null }): boolean {
  return c.description === TASKLIST_MARKER;
}

export const useTasks = create<TaskState>((set, get) => ({
  accountId: null,
  lists: [],
  tasks: {},
  loaded: false,
  selectedListId: null,

  select(id) {
    set({ selectedListId: id });
  },

  async load() {
    const cal = useCalendar.getState();
    const own = cal.accountId;
    const lists: TaskList[] = [
      ...Object.values(cal.calendars)
        .filter(isTasklist)
        .map((c) => ({
          accountId: own ?? "",
          calendarId: c.id,
          name: c.name,
          color: c.color,
        })),
      ...cal.sharedCalendars
        .filter((x) => isTasklist(x.calendar))
        .map((x) => ({
          accountId: x.accountId,
          accountName: x.accountName,
          calendarId: x.calendar.id,
          name: x.calendar.name,
          color: x.calendar.color,
        })),
    ];
    const tasks: Record<string, TaskItem> = {};
    for (const l of lists) {
      if (!l.accountId) continue;
      try {
        const q = await client.call<{ ids: Id[] }>("CalendarEvent/query", {
          accountId: l.accountId,
          filter: { inCalendar: l.calendarId },
          limit: 1000,
        });
        for (const part of chunk(q.ids, client.maxObjectsInGet)) {
          const g = await client.call<GetResponse<TaskItem>>("CalendarEvent/get", {
            accountId: l.accountId,
            ids: part,
            properties: TASK_PROPS,
          });
          for (const t of g.list) tasks[taskKey(l.accountId, t.id)] = t;
        }
      } catch {
        /* a calendar we cannot read is simply not listed */
      }
    }
    set((s) => ({
      accountId: own,
      lists,
      tasks,
      loaded: true,
      selectedListId:
        s.selectedListId &&
        lists.some((l) => taskListKey(l.accountId, l.calendarId) === s.selectedListId)
          ? s.selectedListId
          : lists[0]
            ? taskListKey(lists[0].accountId, lists[0].calendarId)
            : null,
    }));
  },

  async create(list, title, opts = {}) {
    const obj: Record<string, unknown> = {
      "@type": "Task",
      uid: crypto.randomUUID(),
      title,
      progress: "needs-action",
      calendarIds: { [list.calendarId]: true },
    };
    if (opts.due) obj.due = opts.due;
    if (opts.priority != null) obj.priority = opts.priority;
    const res = await client.call<SetResponse<TaskItem>>("CalendarEvent/set", {
      accountId: list.accountId,
      create: { c: obj },
    });
    const err = res.notCreated?.c;
    if (err) throw new Error(setErrorMessage(err));
    await get().load();
    return res.created!.c!.id;
  },

  async setDone(task, done) {
    const accountId = accountOfTask(get(), task.id);
    if (!accountId) return;
    const res = await client.call<SetResponse>("CalendarEvent/set", {
      accountId,
      update: {
        [task.id]: {
          progress: done ? "completed" : "needs-action",
          percentComplete: done ? 100 : 0,
        },
      },
    });
    const err = res.notUpdated?.[task.id];
    if (err) throw new Error(setErrorMessage(err));
    await get().load();
  },

  async update(task, patch) {
    const accountId = accountOfTask(get(), task.id);
    if (!accountId) return;
    const res = await client.call<SetResponse>("CalendarEvent/set", {
      accountId,
      update: { [task.id]: patch },
    });
    const err = res.notUpdated?.[task.id];
    if (err) throw new Error(setErrorMessage(err));
    await get().load();
  },

  async destroy(task) {
    const accountId = accountOfTask(get(), task.id);
    if (!accountId) return;
    const res = await client.call<SetResponse>("CalendarEvent/set", {
      accountId,
      destroy: [task.id],
    });
    const err = res.notDestroyed?.[task.id];
    if (err) throw new Error(setErrorMessage(err));
    await get().load();
  },

  /*
   * Manual order is carried in each task's `keywords` as `order-N`. Rewriting
   * the order rewrites the keyword on every task whose place changed, in one
   * CalendarEvent/set call, so a drag survives reloads and reaches the other
   * members of a group list the same way any task edit does.
   */
  async reorder(list, orderedIds) {
    const update: Record<Id, Record<string, unknown>> = {};
    const mine = Object.values(get().tasks).filter(
      (x) => x.calendarIds?.[list.calendarId],
    );
    const byId = new Map(mine.map((t) => [t.id, t]));
    orderedIds.forEach((id, i) => {
      const t = byId.get(id);
      if (t) update[id] = { keywords: orderKeywords(t, i) };
    });
    // Tasks that just left the open list keep their old key, which is harmless:
    // completed tasks sort below the open ones whatever their number is.
    if (!Object.keys(update).length) return;
    const res = await client.call<SetResponse>("CalendarEvent/set", {
      accountId: list.accountId,
      update,
    });
    const err = Object.values(res.notUpdated ?? {})[0];
    if (err) throw new Error(setErrorMessage(err));
    await get().load();
  },

  async createList(name) {
    const accountId = useCalendar.getState().accountId;
    if (!accountId) throw new Error("Calendars are not available");
    /*
     * Subscribed from the start: a list the reader just made is theirs to
     * use, and a server that leaves a new calendar unsubscribed unless the
     * client says otherwise (Stalwart does; the mock used to hide it by
     * filling the flag in) would keep the fresh list invisible to every
     * client that honours `isSubscribed`.
     */
    const res = await client.call<SetResponse<{ id: Id }>>("Calendar/set", {
      accountId,
      create: { c: { name, description: TASKLIST_MARKER, isSubscribed: true } },
    });
    const err = res.notCreated?.c;
    if (err) throw new Error(setErrorMessage(err));
    await useCalendar.getState().loadCalendars();
    await get().load();
    return res.created!.c!.id;
  },

  applyChanges(types, accountId) {
    /*
     * Tasks are JSCalendar `Task` objects inside `tasklist` calendars, so a
     * push state change for CalendarEvent (or Calendar) on the reader's own
     * account or on any account holding a task list means the list contents
     * may have changed out from under the open view. The calendar store's own
     * change hook only reacts to the *set* of lists, not to their contents.
     */
    if (!types.has("CalendarEvent") && !types.has("Calendar")) return;
    const own = get().accountId;
    const relevant =
      accountId === undefined ||
      accountId === own ||
      get().lists.some((l) => l.accountId === accountId);
    if (relevant) void get().load();
  },
}));

/** The account a task lives in, looked up from the task id across all lists. */
function accountOfTask(state: TaskState, id: Id): Id | null {
  const entry = Object.entries(state.tasks).find(([, t]) => t.id === id);
  if (!entry) return null;
  return entry[0].slice(0, entry[0].length - id.length - 1);
}

/** A different sign-in must not leave the previous reader's tasks on screen. */
useSession.subscribe((s, prev) => {
  if (s.status === prev.status || s.status === "authenticated") return;
  useTasks.setState({
    accountId: null,
    lists: [],
    tasks: {},
    loaded: false,
    selectedListId: null,
  });
});

/**
 * Which task lists exist right now, as one comparable string.
 *
 * The calendar store changes for many reasons (every event range load included)
 * that have nothing to do with task lists; reloading tasks on each would turn
 * a grid refresh into a round of task queries. So the subscription below
 * compares this signature and only reloads when the set of tasklist calendars
 * actually changed -- a new one appeared, or one vanished.
 */
function tasklistSignature(): string {
  const cal = useCalendar.getState();
  const ownAccount = cal.accountId ?? "";
  const own = Object.values(cal.calendars)
    .filter(isTasklist)
    .map((c) => `${ownAccount}:${c.id}`)
    .sort();
  const shared = cal.sharedCalendars
    .filter((x) => isTasklist(x.calendar))
    .map((x) => `${x.accountId}:${x.calendar.id}`)
    .sort();
  return [...own, ...shared].join("|");
}

let lastTasklistSignature: string | null = null;
useCalendar.subscribe(() => {
  const sig = tasklistSignature();
  // First event after load sets the baseline; the Tasks view's own load()
  // already handled the first paint.
  if (lastTasklistSignature === null) {
    lastTasklistSignature = sig;
    return;
  }
  if (sig === lastTasklistSignature) return;
  lastTasklistSignature = sig;
  void useTasks.getState().load();
});
