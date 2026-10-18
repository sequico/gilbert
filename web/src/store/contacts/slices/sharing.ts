import { errorMessage } from "@gilbert/shared/errors";
import {
  GLOBAL_CONTACTS_BOOK_NAME,
  type GlobalContactView,
} from "@gilbert/shared/globalContacts";
import { queryThenGet } from "@gilbert/shared/jmapQuery";
import { isSharedAccountRecord } from "@gilbert/shared/sessionAccount";
import { CAP, client } from "@/jmap/client";
import type {
  AddressBook,
  ContactCard,
  GetResponse,
  Id,
  QueryResponse,
} from "@/jmap/types";
import { isGlobalContactsBook } from "@/lib/contacts";
import {
  fetchGlobalContacts,
  GLOBAL_CONTACTS_ACCOUNT_ID,
  GLOBAL_CONTACTS_BOOK_ID,
} from "@/lib/globalContactsAdmin";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { accountOfSharedKey, sharedKey, sharedKeyForId } from "@/lib/sharedKey";
import { useMail } from "../../mail";
import { useSession } from "../../session";
import { useSettings } from "../../settings";
import {
  ADDRESS_BOOK_PROPS,
  accountOfBook,
  restoreBookPlaceOn,
  sessionEpoch,
} from "../shared";
import type { ContactsGet, ContactsSet, ContactsState, SharedBook } from "../types";

/**
 * The directory's address book, as the store draws any shared book (ADR 0023).
 *
 * It is not a real JMAP `AddressBook`: the directory is served through the
 * route that acts as the Master, so its book is synthesised in the shape every
 * shared-book surface already renders. `myRights` is read-only on purpose — a
 * member writes it through the administration's own route and never through
 * their session — which is what `cardWritable` and the sidebar draw from.
 */
function globalContactsBook(): AddressBook {
  return {
    id: GLOBAL_CONTACTS_BOOK_ID,
    name: GLOBAL_CONTACTS_BOOK_NAME,
    description: null,
    sortOrder: 0,
    isDefault: false,
    // Subscribed so the composer's picker offers it like a book the reader
    // added; the sidebar draws it as its own leading row regardless.
    isSubscribed: true,
    shareWith: {},
    myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
  };
}

/**
 * One directory card, widened from the route's small shape to a JSContact card.
 *
 * The route answers the fields the administrator typed; the store draws
 * ordinary cards everywhere, so the widening happens once here — the same
 * direction the server builds them, so a card read back equals the one the
 * editor wrote. The id is the card's identity and its uid: a directory card is
 * not a group member, so nothing looks a uid up across accounts for it.
 */
function globalContactCard(view: GlobalContactView): ContactCard {
  const card: ContactCard = {
    id: view.id,
    uid: view.id,
    "@type": "Card",
    version: "1.0",
    kind: "individual",
    addressBookIds: { [GLOBAL_CONTACTS_BOOK_ID]: true },
    name: { "@type": "Name", full: view.name },
  };
  if (view.emails.length) {
    const emails: NonNullable<ContactCard["emails"]> = {};
    view.emails.forEach((address, i) => {
      emails[`e${i}`] = {
        "@type": "EmailAddress",
        address,
        ...(i === 0 ? { pref: 1 } : {}),
      };
    });
    card.emails = emails;
  }
  if (view.phones.length) {
    const phones: NonNullable<ContactCard["phones"]> = {};
    view.phones.forEach((number, i) => {
      phones[`p${i}`] = { "@type": "Phone", number };
    });
    card.phones = phones;
  }
  if (view.organization) {
    card.organizations = {
      o0: { "@type": "Organization", name: view.organization },
    };
  }
  if (view.notes) {
    card.notes = { n0: { "@type": "Note", note: view.notes } };
  }
  return card;
}

/*
 * Cards of a *group* mailbox's books are loaded whether or not the reader
 * subscribed to each book: membership of the group is the subscription, and
 * the To field has to answer with them without a detour through Contacts
 * first (the group-ownership rule that Files already follows). A stranger's
 * books still stay out until the reader adds them -- `isSubscribed` or
 * `addedShares` is the only thing separating "shared with me" from
 * "reachable", and this must not guess there.
 */

/** Group mailboxes the reader is a member of, per the mail store's probe. */
async function groupMailboxIds(): Promise<Set<string>> {
  const from = () =>
    new Set(
      groupMailboxAccounts(useMail.getState().mailAccounts).map((a) => a.accountId),
    );
  const ids = from();
  /*
   * Wait only while the mail probe may still be running (mailAccounts is
   * still empty although the session lists non-personal accounts). Once it
   * has landed -- even with no group in it -- the answer is final: waiting
   * on a list that already resolved would stall the eager contact load for
   * the whole timeout on every account that belongs to no group.
   */
  if (ids.size || useMail.getState().mailAccounts.length) return ids;
  /*
   * The eager contact load races the mail probe at boot; wait for it once,
   * briefly, rather than load group cards without knowing which accounts are
   * groups (an account that only shared a folder must not be treated as one).
   */
  return new Promise<Set<string>>((resolve) => {
    const unsub = useMail.subscribe((s) => {
      if (s.mailAccounts.length) {
        unsub();
        resolve(new Set(groupMailboxAccounts(s.mailAccounts).map((a) => a.accountId)));
      }
    });
    setTimeout(() => {
      unsub();
      resolve(from());
    }, 6000);
  });
}

/**
 * The books and cards of accounts that shared with the reader, and the
 * questions asked about where a card lives.
 *
 * A slice of the contacts store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function sharingSlice(
  set: ContactsSet,
  get: ContactsGet,
): Pick<
  ContactsState,
  | "loadShared"
  | "reloadShared"
  | "accountOfCard"
  | "bookNamesOf"
  | "cardWritable"
  | "accountOfBook"
> {
  /* One shared-contacts load at a time; several callers may ask at once. */
  let sharedLoadRun: Promise<void> | null = null;

  return {
    /*
     * Books and cards from accounts that shared with the reader.
     *
     * These are held apart from the reader's own rather than merged into them,
     * because ids are only unique within an account: two accounts each having a
     * book "ab1" is ordinary, and a flat map keyed on the bare id would have one
     * quietly replace the other. `sharedKey` keeps them apart.
     *
     * Loaded eagerly, unlike the shared folders in Files, because these are not
     * only browsed -- they have to answer when someone types a name into a To
     * field, which cannot wait for a folder to be opened first.
     */
    async loadShared() {
      if (sharedLoadRun) return sharedLoadRun;
      const run = (async () => {
        const epoch = sessionEpoch;
        const session = useSession.getState();
        const own = session.ownAccountFor(CAP.contacts);
        const s = session.session;
        const accounts = Object.entries(s?.accounts ?? {}).filter(
          ([id, a]) => isSharedAccountRecord(a) && id !== own,
        );
        /*
         * The installation's directory first (ADR 0023). It is not a share and it
         * does not live in any account the reader can enter: the route reads it
         * as the Master and answers every session, so it is installed here as one
         * more shared book under the sentinel the rest of the store keys it by. A
         * route that fails leaves it out rather than taking the group and
         * colleague books down with it.
         */
        const directory: SharedBook[] = [];
        const cards: Record<string, ContactCard> = {};
        try {
          const global = await fetchGlobalContacts();
          directory.push({
            accountId: GLOBAL_CONTACTS_ACCOUNT_ID,
            accountName: GLOBAL_CONTACTS_BOOK_NAME,
            book: globalContactsBook(),
          });
          for (const view of global)
            cards[sharedKey(GLOBAL_CONTACTS_ACCOUNT_ID, view.id)] =
              globalContactCard(view);
        } catch {
          /* no directory this load; the rest of the shared books still load */
        }
        if (!accounts.length) {
          if (epoch !== sessionEpoch) return;
          set({
            sharedBooks: directory,
            sharedCards: cards,
            sharedLoaded: true,
            sharedLoadError: null,
          });
          restoreBookPlaceOn(get());
          return;
        }
        const groupIds = await groupMailboxIds();
        const books: SharedBook[] = [];
        const failures: string[] = [];
        /*
         * Every account at once. `client.call` batches the calls made in one tick
         * into a single request, so the loop this replaces sent one request after
         * another -- a shared account apiece, before the reader had opened
         * anything.
         */
        await Promise.all(
          accounts.map(async ([accountId, account]) => {
            /*
             * One account that cannot be read is one account missing from the
             * sidebar, and the reader is told: a swallowed failure here looks
             * exactly like a group that has shared nothing, which is the reading
             * nobody can act on. What the accounts that answered is still kept --
             * the whole load is not thrown away for one unreadable book.
             */
            try {
              const res = await client.call<GetResponse<AddressBook>>("AddressBook/get", {
                accountId,
                ids: null,
                properties: ADDRESS_BOOK_PROPS,
              });
              for (const book of res.list)
                books.push({ accountId, accountName: account.name, book });
              /*
               * Cards come only from books the reader has added -- or books of a
               * group mailbox the reader is a member of, where membership is the
               * subscription (see `groupMailboxIds`).
               *
               * Stalwart hands back every book in a reachable account with full
               * rights on each, shared or not -- an account linked for its files
               * offered its address book too -- so `isSubscribed` is the only thing
               * separating "shared with me" from "reachable" for a stranger's
               * account. Loading the rest would put a stranger's contacts in the To
               * field, which is the one place this must not guess.
               */
              const added = new Set(useSettings.getState().settings.addedShares);
              const wanted = new Set(
                res.list
                  .filter(
                    (b) =>
                      b.isSubscribed ||
                      added.has(sharedKey(accountId, b.id)) ||
                      groupIds.has(accountId),
                  )
                  .map((b) => b.id),
              );
              // Nothing in this account is the reader's to read: a book they have
              // not added, in an account they are not a member of.
              if (!wanted.size) return;
              /*
               * Shared contacts load by page up to a bound: 5000 is well past
               * anything a working group keeps in its books, while still bounded
               * so a huge shared book cannot hold the reader's own list hostage.
               * Each get is capped at `maxObjectsInGet`, so the pages walk
               * positions instead of asking for everything at once.
               */
              const sharedCardBound = 5000;
              const page = client.maxObjectsInGet;
              let fetched = 0;
              for (let position = 0; fetched < sharedCardBound; ) {
                const cardsRes = await client.chain(
                  queryThenGet({
                    query: "ContactCard/query",
                    get: "ContactCard/get",
                    accountId,
                    position,
                    limit: page,
                    maxObjectsInGet: page,
                  }),
                );
                const q = cardsRes.get("q")?.[0] as unknown as QueryResponse;
                const g = cardsRes.get("g")?.[0] as unknown as GetResponse<ContactCard>;
                for (const c of g.list) {
                  if (!Object.keys(c.addressBookIds ?? {}).some((id) => wanted.has(id)))
                    continue;
                  cards[sharedKey(accountId, c.id)] = c;
                }
                fetched += q.ids.length;
                if (!q.ids.length || q.ids.length < page) break;
                position += q.ids.length;
              }
            } catch (err) {
              failures.push(`${account.name ?? accountId}: ${errorMessage(err)}`);
            }
          }),
        );
        /*
         * Answers arrive in any order, and the sidebar lists them in the session's
         * order -- so the account books are put back in it rather than left in
         * whatever order the requests happened to finish. The directory leads
         * them, as the first row of the sidebar (ADR 0023).
         */
        const order = new Map(accounts.map(([id], i) => [id, i]));
        books.sort(
          (a, b) => (order.get(a.accountId) ?? 0) - (order.get(b.accountId) ?? 0),
        );
        /*
         * The session may have ended -- or become somebody else's -- while the
         * shared books were being read. The store holds the previous reader's
         * shares, so an answer that landed after a sign-out is dropped rather
         * than written over the empty store.
         */
        if (
          epoch !== sessionEpoch ||
          own !== useSession.getState().ownAccountFor(CAP.contacts)
        )
          return;
        set({
          sharedBooks: [...directory, ...books],
          sharedCards: cards,
          sharedLoaded: true,
          sharedLoadError: failures.length ? failures.join(" · ") : null,
        });
        restoreBookPlaceOn(get());
      })();
      sharedLoadRun = run;
      void run.finally(() => {
        if (sharedLoadRun === run) sharedLoadRun = null;
      });
      return run;
    },

    async reloadShared() {
      const running = sharedLoadRun;
      if (running) await running.catch(() => undefined);
      await get().loadShared();
    },

    accountOfCard(id) {
      if (get().cards[id]) return null;
      const key = sharedKeyForId(get().sharedCards, id);
      return key ? accountOfSharedKey(key, id) : null;
    },

    bookNamesOf(card, heldIn) {
      const st = get();
      /*
       * Where the card lives: the caller's answer when it has one, and the id
       * lookup otherwise. The lookup prefers the reader's own map, so it names the
       * reader's own book for another account's card carrying the same id -- which
       * is why a caller that knows the account says so.
       */
      const accountId = heldIn === undefined ? st.accountOfCard(card.id) : heldIn;
      const names: string[] = [];
      for (const id of Object.keys(card.addressBookIds ?? {})) {
        /* The reader's own card: their own books are the ones that answer, and an
           id none of them carries is a book this client has not read rather than
           one to name. */
        if (!accountId) {
          const own = st.books[id]?.name;
          if (own) names.push(own);
          continue;
        }
        const held = st.sharedBooks.find(
          (b) => b.accountId === accountId && b.book.id === id,
        );
        // The directory has no owner to name it after -- it is the
        // installation's (ADR 0023) -- so it reads as its own name.
        if (held)
          names.push(
            isGlobalContactsBook(held.book)
              ? held.book.name
              : `${held.book.name} · ${held.accountName}`,
          );
      }
      return names;
    },

    cardWritable(card, heldIn) {
      const st = get();
      /*
       * The account holding the card: the caller's answer when it has one. The id
       * lookup is the fallback, and it answers with the reader's own card whenever
       * one carries this id -- so a group's card whose id the reader also holds
       * would be judged by the reader's own book, and offered a write it does not
       * have.
       */
      let accountId: Id | null;
      if (heldIn === undefined) {
        if (st.cards[card.id]) return true;
        accountId = st.accountOfCard(card.id);
      } else {
        if (!heldIn || heldIn === st.accountId) return true;
        accountId = heldIn;
      }
      /* Nothing says this is another account's card, or the books that would
         answer have not answered: offer it, and let the server refuse in its own
         words if it will. */
      if (!accountId || !st.sharedLoaded) return true;
      const books = Object.keys(card.addressBookIds ?? {});
      return st.sharedBooks.some(
        (b) =>
          b.accountId === accountId &&
          books.includes(b.book.id) &&
          b.book.myRights.mayWrite,
      );
    },

    accountOfBook(bookId) {
      return accountOfBook(bookId, get().books, get().accountId, get().sharedBooks);
    },
  };
}
