import { create } from "zustand";
import { CAP } from "@/jmap/client";
import type { EmailAddress } from "@/jmap/types";
import { accountKey, loadRaw } from "@/lib/storage";
import { useMail } from "../mail";
import { useSession } from "../session";
import { bumpSessionEpoch, restoreBookPlaceOn } from "./shared";
import { booksSlice } from "./slices/books";
import { cardsSlice } from "./slices/cards";
import { directorySlice } from "./slices/directory";
import { groupsSlice } from "./slices/groups";
import { importSlice } from "./slices/import";
import { mergeSlice } from "./slices/merge";
import { pushSlice } from "./slices/push";
import { sharingSlice } from "./slices/sharing";
import type { ContactsState } from "./types";

/*
 * Declared once, in `@/lib/sharedKey`: its format is what the reader's own
 * `settings.addedShares` stores, so a second spelling here would be a selection
 * that stops being found. Re-exported because this store's callers key cards by
 * it.
 */
export { sharedKey } from "@/lib/sharedKey";
export type { ContactsState, Suggestion } from "./types";

export const useContacts = create<ContactsState>((set, get) => ({
  accountId: null,
  available: false,
  books: {},
  cards: {},
  cardState: null,
  loaded: false,
  loading: false,
  error: null,
  principals: [],
  principalsLoaded: false,
  recent: [],
  sharedBooks: [],
  sharedCards: {},
  sharedLoaded: false,
  sharedLoadError: null,
  selection: { accountId: null, bookId: "all" },

  ...booksSlice(set, get),
  ...cardsSlice(set, get),
  ...groupsSlice(set, get),
  ...sharingSlice(set, get),
  ...mergeSlice(set, get),
  ...importSlice(set, get),
  ...directorySlice(set, get),
  ...pushSlice(set, get),
}));

/**
 * Put the reader back on the book they had open, if it is still there.
 *
 * The public entry point for the views; the rule itself is
 * `restoreBookPlaceOn` in `./shared`, which the slices call with the state they
 * hold.
 */
export function restoreBookPlace(): void {
  restoreBookPlaceOn(useContacts.getState());
}

useSession.subscribe((s) => {
  if (s.status === "authenticated") {
    const accountId = s.accountFor(CAP.contacts);
    let recent: EmailAddress[] = [];
    try {
      recent = loadRaw<EmailAddress[]>(accountKey(accountId, "recent"), []);
    } catch {
      /* ignore */
    }
    useContacts.setState({ recent });
  } else {
    /*
     * The shared half goes with the sign-out for the same reason it is loaded
     * with the account: a card id is only unique within its account, and the
     * next reader on a shared machine must not briefly be offered the
     * previous reader's shared contacts while their own load, or inherit
     * their selection into the contact list. Calendar and files clear
     * their shared state the same way.
     */
    bumpSessionEpoch();
    useContacts.setState({
      accountId: null,
      books: {},
      cards: {},
      loaded: false,
      principals: [],
      principalsLoaded: false,
      sharedBooks: [],
      sharedCards: {},
      sharedLoaded: false,
      sharedLoadError: null,
      selection: { accountId: null, bookId: "all" },
      loading: false,
      error: null,
    });
  }
});

// Harvest recent recipients from Sent when the mail store learns about them.
useMail.subscribe((s, prev) => {
  if (s.emails === prev.emails) return;
  const sentId = s.roleId("sent");
  if (!sentId) return;
  // cheap: only look at newly-added emails in Sent
  const addrs: EmailAddress[] = [];
  for (const id of Object.keys(s.emails)) {
    if (prev.emails[id]) continue;
    const e = s.emails[id]!;
    if (e.mailboxIds[sentId]) addrs.push(...(e.to ?? []), ...(e.cc ?? []));
  }
  if (addrs.length) useContacts.getState().addRecent(addrs.slice(0, 50));
});
