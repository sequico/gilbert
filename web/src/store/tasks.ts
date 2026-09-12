import { create } from "zustand";
import { chunk, client, setErrorMessage } from "@/jmap/client";
import type { GetResponse, Id, QueryResponse, SetResponse, TaskItem } from "@/jmap/types";
import { useCalendar } from "./calendar";
import { useSession } from "./session";

/**
 * Generic to-do lists, kept apart from the calendar grid.
 *
 * A task list is a calendar whose `description` is the `tasklist` marker, and
 * a task is a JSCalendar `Task` object inside it. Reading the reader's own and
 * shared (including group) calendars through the calendar store is deliberate:
 * discovery and the account-of-a-calendar logic already live there, and this
 * store only adds the task-shaped queries and writes on top.
 *
 * Every tasklist calendar the calendar store knows is listed, subscribed or
 * not. A group's task lists have no add/subscribe affordance (the calendar
 * sidebar keeps tasklists off its add lists), yet they must be there for every
 * member of the group, so the subscription gate the calendar grid applies to
 * shared calendars does not apply here.
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
  setDone(list: TaskList, task: TaskItem, done: boolean): Promise<void>;
  update(list: TaskList, task: TaskItem, patch: Record<string, unknown>): Promise<void>;
  destroy(list: TaskList, task: TaskItem): Promise<void>;
  /** Persist a new manual order for the open tasks of a list. */
  reorder(list: TaskList, orderedIds: Id[]): Promise<void>;
  /**
   * Create a task list (`name`d, `tasklist`-marked) inside `accountId` — the
   * reader's own account or a group's. A list is a calendar, so a group's
   * first list and its tasklist calendar are the same object; creation is
   * lazy, so a group the reader never writes to leaves nothing behind.
   */
  createList(accountId: Id, name: string): Promise<Id>;
  /** Destroy a task list and its tasks — on a group, for every member. */
  destroyList(list: TaskList): Promise<void>;
  /** A task-list account (own or shared) changed its events or calendars. */
  applyChanges(types: Set<string>, accountId?: Id): void;
}

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
        /* One query page cannot hold a whole big list: `limit` stops at 1000
           ids and the server answers the rest of the tasks to later pages,
           so the query is paged on `position` the way the calendar and
           contacts scans are. A list past the first thousand otherwise
           silently lost its tail -- invisible in the view and impossible to
           reorder by keyword. */
        for (let position = 0; ; ) {
          const q = await client.call<QueryResponse>("CalendarEvent/query", {
            accountId: l.accountId,
            filter: { inCalendar: l.calendarId },
            position,
            limit: 1000,
          });
          const ids = q.ids ?? [];
          if (!ids.length) break;
          for (const part of chunk(ids, client.maxObjectsInGet)) {
            const g = await client.call<GetResponse<TaskItem>>("CalendarEvent/get", {
              accountId: l.accountId,
              ids: part,
              properties: TASK_PROPS,
            });
            for (const t of g.list) tasks[taskKey(l.accountId, t.id)] = t;
          }
          position += ids.length;
          // `total` is optional, so the empty page above is what actually ends
          // this; the check only saves the round trip that would find it.
          if (q.total != null && position >= q.total) break;
        }
      } catch {
        /* A list we cannot read stays listed but empty: hiding it would look
           like the list vanished, where keeping it shows the reader what a
           group holds even when its tasks are out of reach. */
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

  async setDone(list, task, done) {
    const res = await client.call<SetResponse>("CalendarEvent/set", {
      accountId: list.accountId,
      update: {
        [task.id]: {
          progress: done ? "completed" : "needs-action",
          /*
           * Completing sets the whole bar; reopening returns the task to the
           * progress it had before, rather than wiping a half-done task to
           * zero because somebody unticked it.
           */
          percentComplete: done
            ? 100
            : task.percentComplete === undefined || task.percentComplete === 100
              ? 0
              : task.percentComplete,
        },
      },
    });
    const err = res.notUpdated?.[task.id];
    if (err) throw new Error(setErrorMessage(err));
    await get().load();
  },

  async update(list, task, patch) {
    const res = await client.call<SetResponse>("CalendarEvent/set", {
      accountId: list.accountId,
      update: { [task.id]: patch },
    });
    const err = res.notUpdated?.[task.id];
    if (err) throw new Error(setErrorMessage(err));
    await get().load();
  },

  async destroy(list, task) {
    const res = await client.call<SetResponse>("CalendarEvent/set", {
      accountId: list.accountId,
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
    /*
     * Both sides of the match carry the account: a task is held under its
     * account-qualified key, and the list is addressed by its own, so a bare
     * calendar id or a bare task id cannot pull in a same-numbered object of
     * another account and write this order onto it. `update` itself is keyed
     * by the object id the set call names -- one account's ids -- and each
     * object behind it is the one the qualified lookup resolved to.
     */
    const update: Record<Id, Record<string, unknown>> = {};
    const mine = new Map<string, TaskItem>();
    for (const [key, x] of Object.entries(get().tasks)) {
      if (key !== taskKey(list.accountId, x.id)) continue;
      if (x.calendarIds?.[list.calendarId]) mine.set(key, x);
    }
    orderedIds.forEach((id, i) => {
      const t = mine.get(taskKey(list.accountId, id));
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

  async createList(accountId, name) {
    if (!accountId) throw new Error("Calendars are not available");
    const own = useCalendar.getState().accountId;
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
    const createdId = res.created!.c!.id;
    /*
     * The account that owns the list is the grant: a group list is the
     * group's own calendar, reached by every member through their session on
     * the group account. No `shareWith` back to a principal, and a member
     * added after the list exists needs no per-object ACL maintenance.
     */
    if (accountId === own) await useCalendar.getState().loadCalendars();
    else await useCalendar.getState().loadSharedCalendars();
    await get().load();
    return createdId;
  },

  async destroyList(list) {
    const own = useCalendar.getState().accountId;
    /*
     * A task list is the calendar it lives in, so deleting the last list of
     * a group deletes the group's tasklist calendar with it — nothing is
     * left behind. Its tasks go with it (`onDestroyRemoveEvents`), which is
     * what deleting a list means to every member of the group.
     */
    const res = await client.call<SetResponse>("Calendar/set", {
      accountId: list.accountId,
      destroy: [list.calendarId],
      onDestroyRemoveEvents: true,
    });
    const err = res.notDestroyed?.[list.calendarId];
    if (err) throw new Error(setErrorMessage(err));
    if (list.accountId === own) await useCalendar.getState().loadCalendars();
    else await useCalendar.getState().loadSharedCalendars();
    await get().load();
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

/*
 * Writes to a task are aimed by the list the reader is acting on, not by a
 * lookup on the bare task id: an id is unique only within its account, so the
 * same id can name a task in the reader's own list and one in a group's, and
 * a scan across accounts would pick whichever came first -- usually the
 * reader's own, silently completing or deleting the wrong task.
 */

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
  // The calendar store is cleared with the sign-out; the next signature event
  // must set the baseline afresh rather than diff against a dead one.
  lastTasklistSignature = null;
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
