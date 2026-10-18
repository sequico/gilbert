import type { AddressBook, Id } from "@/jmap/types";
import { loadPlace, placeOwnerFrom } from "@/lib/lastPlace";
import { useSession } from "../session";
import type { ContactsState, SharedBook } from "./types";

/*
 * Asked for by name, so `shareWith` is there to read on every 0.16.
 *
 * An `AddressBook/get` with no `properties` omits it entirely on 0.16.19 --
 * confirmed on 2026-08-27 on a book that really was shared -- where 0.16.21
 * returns every property unasked (confirmed live on 2026-09-06). See the note
 * on CALENDAR_PROPS; address books, calendars and Files all name their
 * properties for the same reason.
 */
export const ADDRESS_BOOK_PROPS = [
  "id",
  "name",
  "description",
  "sortOrder",
  "isDefault",
  "isSubscribed",
  "shareWith",
  "myRights",
];

/**
 * Which account holds an address book: the reader's own when it is one of
 * theirs, otherwise the account that shared it -- a colleague's, or a group
 * mailbox the reader belongs to. Cards write to that account, never to the
 * reader's own.
 */
export function accountOfBook(
  bookId: Id | null | undefined,
  own: Record<Id, AddressBook>,
  ownAccountId: Id | null,
  shared: SharedBook[],
): Id | null {
  if (!bookId) return ownAccountId;
  if (own[bookId]) return ownAccountId;
  return shared.find((b) => b.book.id === bookId)?.accountId ?? ownAccountId;
}

/*
 * Bumped whenever the session stops being the reader's own.
 *
 * A load in flight captured the session it started under, and a sign-out
 * empties the store; without this an answer that lands afterwards would
 * repopulate it for whoever signs in next. Every loader captures the epoch at
 * its start and drops its result when it has moved on.
 */
export let sessionEpoch = 0;

/** Move the epoch on, so a load in flight for the old session drops its answer. */
export function bumpSessionEpoch(): void {
  sessionEpoch += 1;
}

/**
 * Put the reader back on the book they had open, if it is still there.
 *
 * A book chosen on this device last time is not a decision to make again. The
 * record is only a seed: the check against what actually loaded is what keeps
 * a deleted or unshared book from stranding the view on nothing.
 *
 * Takes the state it works on rather than reading the store, which is what lets
 * the slices that restore the place call it without importing `index.ts`.
 */
export function restoreBookPlaceOn(st: ContactsState): void {
  if (st.selection.bookId !== "all") return;
  const place = loadPlace(placeOwnerFrom(useSession.getState())).book;
  if (!place?.bookId || place.bookId === "all") return;
  const there = place.accountId
    ? st.sharedBooks.some(
        (b) => b.accountId === place.accountId && b.book.id === place.bookId,
      )
    : Boolean(st.books[place.bookId]);
  if (there) st.select({ accountId: place.accountId, bookId: place.bookId });
}
