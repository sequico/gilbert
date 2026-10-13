import type { Email, Id, Thread } from "@/jmap/types";
import { LIST_PROPS, type MailState } from "./types";

/*
 * How many messages are held with their bodies.
 *
 * Every message opened kept its full copy -- a body of up to 2 MB, parsed
 * headers, the attachment list -- for as long as the tab was open, so a long
 * session's memory grew with every message read. Past this many, the ones read
 * longest ago go back to what the list needs, and are fetched in full again if
 * they are opened again.
 */
export const BODIES_KEPT = 40;

/** Messages held in full, least recently wanted first. */
export const bodyOrder: Id[] = [];
export const LIST_KEYS = new Set<string>(LIST_PROPS);

export function touchBodies(ids: Id[]): void {
  for (const id of ids) {
    const at = bodyOrder.indexOf(id);
    if (at >= 0) bodyOrder.splice(at, 1);
    bodyOrder.push(id);
  }
}

/**
 * Let go of the bodies of the messages read longest ago, past `BODIES_KEPT`.
 *
 * The open conversation is never touched: its messages are what the reading
 * pane is showing, and releasing one takes it out of the pane until the refetch
 * puts it back -- the pane empties and refills, which is a flash the reader sees
 * for no gain. Everything else goes back to the properties the list draws, so
 * the row it belongs to is unaffected.
 */
export function releaseBodies(s: MailState): MailState | Partial<MailState> {
  if (bodyOrder.length <= BODIES_KEPT) return s;
  const open = new Set(s.openThreadId ? (s.threads[s.openThreadId]?.emailIds ?? []) : []);
  const emails = { ...s.emails };
  const fullIds = { ...s.fullIds };
  let over = bodyOrder.length - BODIES_KEPT;
  for (let i = 0; i < bodyOrder.length && over > 0; ) {
    const id = bodyOrder[i]!;
    if (open.has(id) || s.emails[id]?.threadId === s.openThreadId) {
      i++;
      continue;
    }
    bodyOrder.splice(i, 1);
    over--;
    delete fullIds[id];
    const e = emails[id];
    if (e)
      emails[id] = Object.fromEntries(
        Object.entries(e).filter(([k]) => LIST_KEYS.has(k)),
      ) as unknown as Email;
  }
  return { emails, fullIds };
}

/** Forget what is held: for an account switch, where none of it applies. */
export function resetBodyOrder(): void {
  bodyOrder.length = 0;
}

/**
 * Let go of the messages and conversations nothing on screen needs.
 *
 * `emails` and `threads` hold what the list and the reading pane draw, and
 * nothing else: what the list draws is its own ids and the messages of the
 * conversations those rows belong to, what the reading pane draws is the open
 * conversation, what it is still showing while the next one loads is
 * `lastThreadEmailIds`, and a ticked row is still named by the selection
 * summary however far the window has moved past it. `keep` names whatever else
 * the caller knows is about to be on screen — the window it has just read.
 * Everything else belongs to a window that has moved on, and is fetched again
 * if it is ever shown.
 */
export function releaseHeld(
  s: MailState,
  keep: Iterable<Id>,
): Pick<MailState, "emails" | "fullIds" | "threads"> {
  const held = new Set<Id>(keep);
  for (const id of s.list?.ids ?? []) held.add(id);
  for (const id of s.lastThreadEmailIds) held.add(id);
  for (const id of Object.keys(s.selected)) held.add(id);
  const open = s.openThreadId ? s.threads[s.openThreadId] : undefined;
  for (const id of open?.emailIds ?? []) held.add(id);
  /*
   * A conversation kept because one of its messages is held draws every message
   * it holds — a collapsed row counts them — so the whole of its `emailIds` is
   * held with it. The conversations are named first, since a message that
   * widens the set has no say in which of them are kept.
   */
  const threads: Record<Id, Thread> = {};
  for (const id of held) {
    const threadId = s.emails[id]?.threadId;
    const thread = threadId ? s.threads[threadId] : undefined;
    if (thread) threads[thread.id] = thread;
  }
  if (open) threads[open.id] = open;
  for (const thread of Object.values(threads))
    for (const id of thread.emailIds) held.add(id);
  const emails: Record<Id, Email> = {};
  const fullIds: Record<Id, true> = {};
  for (const [id, email] of Object.entries(s.emails)) {
    if (!held.has(id)) continue;
    emails[id] = email;
    if (s.fullIds[id]) fullIds[id] = true;
  }
  /*
   * A body kept for a message that is no longer held would be dropped by the
   * next full read and, until then, drawn without one: the order bodies are
   * released in follows what is held.
   */
  for (let i = bodyOrder.length - 1; i >= 0; i--)
    if (!held.has(bodyOrder[i]!)) bodyOrder.splice(i, 1);
  return { emails, fullIds, threads };
}
