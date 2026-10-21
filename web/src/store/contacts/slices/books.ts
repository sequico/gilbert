import { errorMessage } from "@gilbert/shared/errors";
import { batchedSet, CAP, client, setErrorMessage } from "@/jmap/client";
import type {
  AddressBook,
  ContactCard,
  GetResponse,
  Id,
  SetResponse,
} from "@/jmap/types";
import { refuseDirectoryWrite } from "@/lib/globalContactsAdmin";
import { uniqueAddresses } from "@/lib/address";
import { contactFromAddress } from "@/lib/contacts";
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
     * It is the **reader's own** account's book, and only while that is the
     * account this store is bound to: a group mailbox in view owns cards of its
     * own, and filing somebody's correspondents into a group's directory would
     * put them where the reader's other devices do not read. The book is created
     * on first use and remembered by id, so its name can be anything and an
     * emptied or deleted one is simply replaced. A deleted book is detected by
     * its id no longer being in the list.
     */
    async collectRecipients(addrs, own) {
      const self = useSession.getState().ownAccountFor(CAP.contacts);
      if (!self || get().accountId !== self) return 0;
      if (!get().available) return 0;
      // Every card has to be known, or someone already a contact gets a second card.
      if (!get().loaded) await get().loadAll();
      const ownSet = new Set(own.map((e) => e.toLowerCase()));
      const fresh = uniqueAddresses(addrs).filter(
        (a) =>
          a.email && !ownSet.has(a.email.toLowerCase()) && !get().lookupByEmail(a.email),
      );
      if (!fresh.length) return 0;
      const { settings, update } = useSettings.getState();
      let bookId =
        settings.collectedBookId && get().books[settings.collectedBookId]
          ? settings.collectedBookId
          : null;
      if (!bookId) {
        bookId = await get().createBook(t("Collected"));
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
      const res = await client.call<SetResponse<ContactCard>>("ContactCard/set", {
        accountId: self,
        create,
      });
      await get().syncCards();
      return Object.keys(res.created ?? {}).length;
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
