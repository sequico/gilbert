import { errorMessage } from "@gilbert/shared/errors";
import { batchedSet, CAP, client, setErrorMessage } from "@/jmap/client";
import type {
  AddressBook,
  ContactCard,
  GetResponse,
  Id,
  SetResponse,
} from "@/jmap/types";
import { uniqueAddresses } from "@/lib/address";
import { contactFromAddress } from "@/lib/contacts";
import { refuseDirectoryWrite } from "@/lib/globalContactsAdmin";
import { t } from "@/lib/i18n";
import { placeOwnerFrom, rememberPlace } from "@/lib/lastPlace";
import { sharedKey } from "@/lib/sharedKey";
import { useSession } from "../../session";
import { useSettings } from "../../settings";
import {
  ADDRESS_BOOK_PROPS,
  accountOfBook,
  restoreBookPlaceOn,
  sessionEpoch,
} from "../shared";
import type { ContactsGet, ContactsSet, ContactsState } from "../types";

/**
 * One collection at a time. Two sends in flight would otherwise both find the
 * remembered book unset and create one each, and would both see an address as
 * new before the other's card landed.
 */
let collecting: Promise<number> = Promise.resolve(0);

/**
 * The reader's own address books: the list, the selection, and the writes that
 * change them.
 *
 * A slice of the contacts store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function booksSlice(
  set: ContactsSet,
  get: ContactsGet,
): Pick<
  ContactsState,
  | "init"
  | "loadBooks"
  | "select"
  | "setBookSubscribed"
  | "emptyBook"
  | "collectRecipients"
  | "createBook"
  | "updateBook"
  | "destroyBook"
> {
  return {
    async init() {
      // The reader's own, not whichever account is selected: a shared address
      // book is shown beside theirs rather than instead of it, so nothing here
      // should move when the switcher does.
      const accountId = useSession.getState().ownAccountFor(CAP.contacts);
      const available = Boolean(accountId && client.hasCapability(CAP.contacts));
      if (accountId !== get().accountId)
        set({
          accountId,
          books: {},
          cards: {},
          loaded: false,
          selection: { accountId: null, bookId: "all" },
        });
      set({ available });
      if (!available) return;
      await get().loadBooks();
      void get().loadShared();
      /*
       * The cards too, in the background. The avatars in the mail list come from
       * them, and nothing else loaded them until Contacts was opened or an
       * address was typed -- so a photo appeared once somebody did either, and was
       * gone again after the next reload.
       */
      if (!get().loaded) void get().loadAll();
    },

    async setBookSubscribed(accountId, bookId, subscribed) {
      refuseDirectoryWrite(accountId);
      /*
       * `notUpdated` matters more here than anywhere else this pattern is used.
       * Subscribing is a write to somebody *else's* account, so it is the one
       * call in the app that a perfectly healthy server is entitled to refuse --
       * and a refusal arrives as a successful response carrying a per-object
       * failure, not as a thrown error. Ignoring it makes a refused subscribe look
       * exactly like a button that does nothing.
       */
      /*
       * Ask the server to remember it, and remember it here when it will not.
       *
       * Subscribing writes to the owner's account, and Stalwart 0.16.19 refuses
       * that for a book shared read-only -- "You are not allowed to modify this
       * address book" -- while accepting the same write on a shared calendar. The
       * server's own flag is still preferred when it takes it, because then every
       * client agrees; a refusal is an ordinary answer here rather than a
       * failure, and the preference goes in the reader's own synced settings.
       */
      const key = sharedKey(accountId, bookId);
      let stored = false;
      try {
        const res = await client.call<SetResponse>("AddressBook/set", {
          accountId,
          update: { [bookId]: { isSubscribed: subscribed } },
        });
        const err = res.notUpdated?.[bookId];
        if (err) throw new Error(setErrorMessage(err));
        stored = true;
      } catch {
        stored = false;
      }
      if (!stored) {
        const { settings, update } = useSettings.getState();
        const added = new Set(settings.addedShares);
        if (subscribed) added.add(key);
        else added.delete(key);
        update({ addedShares: [...added] });
      }
      if (
        !subscribed &&
        get().selection.accountId === accountId &&
        get().selection.bookId === bookId
      ) {
        set({ selection: { accountId: null, bookId: "all" } });
      }
      await get().reloadShared();
    },

    select(selection) {
      set({ selection });
      rememberPlace(placeOwnerFrom(useSession.getState()), {
        book: { accountId: selection.accountId, bookId: selection.bookId },
      });
    },

    async loadBooks() {
      const accountId = get().accountId;
      if (!accountId) return;
      const epoch = sessionEpoch;
      try {
        const res = await client.call<GetResponse<AddressBook>>("AddressBook/get", {
          accountId,
          ids: null,
          properties: ADDRESS_BOOK_PROPS,
        });
        const books: Record<Id, AddressBook> = {};
        for (const b of res.list) books[b.id] = b;
        // The account may have changed -- or the reader signed out -- while the
        // read was in flight; its answer belongs to the session that asked.
        if (epoch !== sessionEpoch || get().accountId !== accountId) return;
        set({ books, error: null });
        restoreBookPlaceOn(get());
      } catch (err) {
        if (epoch !== sessionEpoch || get().accountId !== accountId) return;
        set({ error: errorMessage(err) });
      }
    },

    async emptyBook(bookId) {
      const accountId = get().accountId!;
      const inBook = Object.values(get().cards).filter((c) => c.addressBookIds?.[bookId]);
      /*
       * Two different acts, decided per card.
       *
       * A card filed only here is deleted. A card filed here *and* somewhere else
       * is removed from this book and left where it also lives -- emptying one
       * book must not empty another, and `ContactCard/set destroy` does not know
       * the difference: it takes the card away from every book at once.
       */
      const destroy: Id[] = [];
      const update: Record<Id, unknown> = {};
      for (const c of inBook) {
        if (Object.keys(c.addressBookIds ?? {}).length > 1)
          update[c.id] = { [`addressBookIds/${bookId}`]: null };
        else destroy.push(c.id);
      }

      /* One budget for destroys and updates together, the way `writeCards` shares
         one for creates and updates: `batchedSet` is that loop. */
      try {
        const { destroyed, updated, refused } = await batchedSet<ContactCard>({
          method: "ContactCard",
          accountId,
          destroy,
          update,
        });
        return { destroyed: destroyed.length, unfiled: updated, refused };
      } finally {
        await get().syncCards();
      }
    },

    /**
     * Save the addresses written to that are not on any card yet, in an address
     * book of their own, so every device suggests them and not only the browser
     * that sent the message.
     *
     * `from` is the account the message goes out from, and only the reader's own
     * collects: a message written from a group mailbox is the group's, and its
     * correspondents belong in the group's directory rather than in the reader's
     * personal book, where their other devices would read them. That is the
     * account Send was pressed under, not whatever mailbox is on screen when the
     * undo window closes -- a message of the reader's own sent while a group is
     * on screen still collects, into the reader's own book.
     *
     * Nothing is collected until every card of the account is known: a card list
     * that is not there yet would make every existing contact look new, and a
     * duplicate card is worse than one send's worth of addresses left
     * uncollected. A load already in flight is not waited for, so that send
     * leaves them uncollected and the next one collects.
     *
     * The book is created on first use and remembered by id, so its name can be
     * anything and an emptied or deleted one is simply replaced -- by another book
     * of that name where there is one (a settings write the installation's policy
     * refused leaves the id unset, and a second book per send is not the answer).
     * That name is the catalogue's current one, so a reader who changes language
     * between two such sends is the one case where a second book appears.
     *
     * shortcut: one collection at a time is per tab; two devices sending at once
     * can each create a book, upgraded if that ever shows.
     */
    async collectRecipients(addrs, own, from) {
      const run = async () => {
        const self = useSession.getState().ownAccountFor(CAP.contacts);
        if (!self || from !== self) return 0;
        if (!get().available) return 0;
        // The session a collection was started in: a sign-out or another
        // account's sign-in between two awaits leaves books, cards and the write
        // target belonging to two accounts, and the neighbours in this slice all
        // refuse that rather than write across it.
        const epoch = sessionEpoch;
        if (!get().loaded) await get().loadAll();
        if (epoch !== sessionEpoch || get().accountId !== self) return 0;
        if (!get().loaded) return 0;
        const ownSet = new Set(own.map((e) => e.toLowerCase()));
        const fresh = uniqueAddresses(addrs).filter(
          (a) =>
            a.email &&
            !ownSet.has(a.email.toLowerCase()) &&
            !get().lookupByEmail(a.email),
        );
        if (!fresh.length) return 0;
        const { settings, update } = useSettings.getState();
        let bookId: Id | null = null;
        const remembered = settings.collectedBookId;
        if (remembered) {
          if (get().books[remembered]) bookId = remembered;
          else {
            /*
             * The books this store holds can be older than the account — a create
             * whose list read failed, or a second device — so a remembered id the
             * cache does not carry is asked for rather than assumed deleted.
             * Assuming costs a second book of the same name, every send.
             */
            const answered = await client.call<GetResponse<AddressBook>>(
              "AddressBook/get",
              { accountId: self, ids: [remembered] },
            );
            if (epoch !== sessionEpoch || get().accountId !== self) return 0;
            if (answered.list.length) bookId = remembered;
          }
        }
        if (!bookId) {
          bookId =
            Object.values(get().books).find((b) => b.name === t("Collected"))?.id ?? null;
          if (bookId) update({ collectedBookId: bookId });
        }
        if (!bookId) {
          bookId = await get().createBook(t("Collected"));
          if (epoch !== sessionEpoch || get().accountId !== self) return 0;
          update({ collectedBookId: bookId });
        }
        const create = Object.fromEntries(
          fresh.map((a, i) => [
            `c${i}`,
            {
              "@type": "Card",
              version: "1.0",
              uid: crypto.randomUUID(),
              ...contactFromAddress(a),
              addressBookIds: { [bookId!]: true },
            },
          ]),
        );
        /*
         * The cards go out through the store's one batching door: a send to a
         * few hundred people is more objects than one `/set` may carry, and a
         * single call would have been refused whole — the feature promising to
         * save them and saving nothing. A refusal is answered as the count it
         * managed, so a caller can say how many.
         */
        const written = await batchedSet<ContactCard>({
          method: "ContactCard",
          accountId: self,
          create,
        });
        await get().syncCards();
        return written.created;
      };
      const next = collecting.then(run, run);
      collecting = next.catch(() => 0);
      return next;
    },

    /**
     * Create an address book, owned by `accountId` when given and by the
     * reader's own account otherwise. A book created on a group account
     * belongs to the group: it is written directly into the group's own
     * account, so every member -- including one added after the fact --
     * reaches it through their session on that account, and no share or
     * per-user ACL is written. Group books are created subscribed so members
     * see them without each adding one; the reader's own books need no flag
     * (they are theirs, listed as such).
     */
    async createBook(name, accountId?: Id) {
      const own = get().accountId!;
      const target = accountId ?? own;
      const res = await client.call<SetResponse<AddressBook>>("AddressBook/set", {
        accountId: target,
        create: { b: target === own ? { name } : { name, isSubscribed: true } },
      });
      const err = res.notCreated?.b;
      if (err) throw new Error(setErrorMessage(err));
      if (target === own) await get().loadBooks();
      else await get().reloadShared();
      return res.created!.b!.id;
    },

    async updateBook(id, patch, accountId) {
      const own = get().accountId;
      /*
       * The account the book lives in, which the caller knows when it came from
       * a row that names it -- the sidebar does. Falling back to the book's own
       * account here is right only while the ids do not collide, and they do: a
       * book id is unique inside its account and nowhere else.
       */
      const target = accountId ?? accountOfBook(id, get().books, own, get().sharedBooks);
      if (!target) throw new Error("That address book is not available");
      refuseDirectoryWrite(target);
      const res = await client.call<SetResponse>("AddressBook/set", {
        accountId: target,
        update: { [id]: patch },
      });
      const err = res.notUpdated?.[id];
      if (err) throw new Error(setErrorMessage(err));
      if (target === own) await get().loadBooks();
      else await get().reloadShared();
    },

    async destroyBook(id, accountId) {
      const own = get().accountId;
      const target = accountId ?? accountOfBook(id, get().books, own, get().sharedBooks);
      if (!target) throw new Error("That address book is not available");
      refuseDirectoryWrite(target);
      const res = await client.call<SetResponse>("AddressBook/set", {
        accountId: target,
        destroy: [id],
        onDestroyRemoveContents: true,
      });
      const err = res.notDestroyed?.[id];
      if (err) throw new Error(setErrorMessage(err));
      if (target === own) {
        await get().loadBooks();
        await get().syncCards();
      } else {
        await get().reloadShared();
      }
    },
  };
}
