import type { Email, Id } from "@/jmap/types";
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
