/**
 * What a row stands for, and what a row therefore says.
 *
 * With conversation view on, one row is a conversation; with it off, a row is a
 * message. Every surface that shows or writes a row's state has to answer the
 * same two questions the same way, and answering them separately is how a row
 * came to *show* one thing and *do* another: the star in a conversation showed
 * one message's state and wrote the whole thread's.
 *
 * So both questions live here, once:
 *
 *  - **which messages a row covers** — the thread's, narrowed to the folder the
 *    list is showing, because a conversation reaches into folders this list is
 *    not about (`rowScope`);
 *  - **what a row carrying a per-message keyword says** — a row carries it when
 *    *any* of its messages does, which is the only answer a single row can give
 *    when its messages disagree (`anyCarries`).
 *
 * The rule that follows from those two is the product rule, and it is stated in
 * FEATURES.md: **a star belongs to whatever the row is.** On a conversation it
 * is the conversation's, on a message it is that message's, and the count in the
 * sidebar is taken over the same unit — threads when conversations are
 * collapsed, messages when they are not.
 */
import type { Id } from "@/jmap/types";

/** The part of a message these rules read. */
export interface CarriesKeywords {
  mailboxIds?: Record<Id, boolean>;
  keywords?: Record<string, boolean>;
}

/**
 * The messages one row covers: the ones also in the folder the list is about.
 *
 * A thread reaches into folders this list says nothing about — a reply the
 * reader filed away, a copy in Sent — and a row acting on those would act on
 * messages the list never showed. With no folder in hand (a search, a starred
 * view) the whole thread is in scope, because that is what those lists are.
 */
export function rowScope<M extends CarriesKeywords>(
  messages: ReadonlyArray<M>,
  mailboxId?: Id | null,
): M[] {
  if (!mailboxId) return [...messages];
  const inFolder = messages.filter((m) => m.mailboxIds?.[mailboxId]);
  // A thread whose messages are all somewhere else still has its own row: the
  // row is being looked at, so it falls back to itself rather than to nothing.
  return inFolder.length ? inFolder : [...messages];
}

/** Whether any of these messages carries the keyword. */
export function anyCarries(
  messages: ReadonlyArray<CarriesKeywords>,
  keyword: string,
): boolean {
  return messages.some((m) => m.keywords?.[keyword]);
}

/** Whether any of these messages lacks the keyword. */
export function anyLacks(
  messages: ReadonlyArray<CarriesKeywords>,
  keyword: string,
): boolean {
  return messages.some((m) => !m.keywords?.[keyword]);
}
