import { errorMessage } from "@gilbert/shared/errors";
import { ref } from "@gilbert/shared/jmapQuery";
import { sessionIsAdmin } from "@gilbert/shared/sessionAccount";
import { batchedSet, chunk, client, JmapMethodError, setErrorMessage } from "@/jmap/client";
import type {
  ChangesResponse,
  ContactCard,
  GetResponse,
  Id,
  QueryResponse,
  SetError,
  SetResponse,
} from "@/jmap/types";
import { type ContactMoveRefusal, contactMoveRefusal } from "@/lib/contactMove";
import { contactDisplayName, sortKey } from "@/lib/contacts";
import {
  GLOBAL_CONTACTS_ACCOUNT_ID,
  refuseDirectoryWrite,
} from "@/lib/globalContactsAdmin";
import { t } from "@/lib/i18n";
import { accountOf, accountOfSharedKey, sharedKey } from "@/lib/sharedKey";
import { useSession } from "../../session";
import { accountOfBook, sessionEpoch } from "../shared";
import type { ContactsGet, ContactsSet, ContactsState } from "../types";

/**
 * What a refused move says, in the reader's language.
 *
 * The rule answers a code and the sentence is composed where it shows, which is
 * here for the write the store performs: a string held in a library is a string
 * no catalogue can translate. It names the one thing that makes the difference,
 * because a reader who is refused a move has to know the move was the reason
 * rather than the address book, which stays usable in every other way.
 */
function contactMoveSentence(code: ContactMoveRefusal): string {
  switch (code) {
    case "contact_move_admin":
      return t(
        "Moving a contact between your own address books and a group's is an installation administrator's, because the card belongs to the account it lands in. Editing it and filing new contacts where they are still work.",
      );
  }
}

/**
 * The cards themselves: reading them, filtering them, and the writes that move
 * one between accounts or merge it into another.
 *
 * A slice of the contacts store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function cardsSlice(
  set: ContactsSet,
  get: ContactsGet,
): Pick<
  ContactsState,
  | "loadAll"
  | "syncCards"
  | "getCard"
  | "filterCards"
  | "search"
  | "cardsIn"
  | "createCard"
  | "addCardToBook"
  | "moveCardTo"
  | "updateCard"
  | "repointContactRefs"
  | "destroyCards"
> {
  /*
   * The text a card answers a search with, built once per card object.
   *
   * A card is an immutable value: every write replaces the object rather than
   * editing it (`loadAll`, `syncCards` and `getCard` all set a fresh one), so the
   * same object always yields the same string and the build is worth reusing for
   * every query -- a directory of a few thousand cards otherwise rebuilds
   * thousands of strings per keystroke. Keyed on the object, which is what makes
   * that safe with no invalidation list: a changed card arrives as a new object
   * and therefore a different key, and a sign-out or account switch drops the
   * objects the keys were, leaving them to the collector.
   *
   * The fields, their order and the space that joins them are the filter's own:
   * this holds the match string, it does not decide what matches.
   */
  const cardHaystacks = new WeakMap<ContactCard, string>();

  function cardHaystack(c: ContactCard): string {
    let hay = cardHaystacks.get(c);
    if (hay === undefined) {
      hay = [
        contactDisplayName(c),
        ...Object.values(c.emails ?? {}).map((e) => e.address),
        ...Object.values(c.phones ?? {}).map((p) => p.number),
        ...Object.values(c.organizations ?? {}).map((o) => o.name ?? ""),
        ...Object.values(c.nicknames ?? {}).map((n) => n.name),
      ]
        .join(" ")
        .toLowerCase();
      cardHaystacks.set(c, hay);
    }
    return hay;
  }

  return {
    async loadAll() {
      const accountId = get().accountId;
      if (!accountId || get().loading) return;
      const epoch = sessionEpoch;
      set({ loading: true });
      try {
        const cards: Record<Id, ContactCard> = {};
        let position = 0;
        const limit = 500;
        let cardState: string | null = null;
        for (let guard = 0; guard < 50; guard++) {
          const res = await client.chain([
            [
              "ContactCard/query",
              { accountId, position, limit, calculateTotal: true },
              "q",
            ],
            [
              "ContactCard/get",
              {
                accountId,
                "#ids": ref("q", "ContactCard/query", "/ids"),
              },
              "g",
            ],
          ]);
          const q = res.get("q")?.[0] as unknown as QueryResponse;
          const g = res.get("g")?.[0] as unknown as GetResponse<ContactCard>;
          for (const c of g.list) cards[c.id] = c;
          /*
           * The first page's state, then left alone: a change made while the
           * later pages were being read is reported again by the next sync rather
           * than missed, and re-reporting is what a reconcile is built to absorb.
           */
          cardState ??= g.state;
          position += q.ids.length;
          if (q.ids.length < limit || (q.total != null && position >= q.total)) break;
        }
        if (epoch !== sessionEpoch || get().accountId !== accountId) {
          // A dropped answer must not leave the spinner up: nothing else clears
          // `loading`, and `loadAll` refuses to start while it is set.
          set({ loading: false });
          return;
        }
        set({ cards, cardState, loaded: true, loading: false, error: null });
      } catch (err) {
        if (epoch !== sessionEpoch || get().accountId !== accountId) {
          set({ loading: false });
          return;
        }
        set({ loading: false, error: errorMessage(err) });
      }
    },

    /*
     * What changed, rather than everything again.
     *
     * Every push that touched a card, and every edit or import made here, reloaded
     * the whole address book -- up to fifty pages of five hundred cards with all
     * their properties -- to pick up one change. `ContactCard/changes` names what
     * happened since the state `cards` was read at, and only those cards are
     * fetched. A server that cannot say (`cannotCalculateChanges`), or any other
     * failure, falls back to the full load, which is what happened before.
     */
    async syncCards() {
      const { accountId, cardState, loaded } = get();
      if (!accountId || !loaded || !cardState) return get().loadAll();
      try {
        const changed = new Set<Id>();
        const destroyed = new Set<Id>();
        let since = cardState;
        for (let guard = 0; guard < 50; guard++) {
          const ch = await client.call<ChangesResponse>("ContactCard/changes", {
            accountId,
            sinceState: since,
            maxChanges: 500,
          });
          for (const id of [...ch.created, ...ch.updated]) {
            changed.add(id);
            destroyed.delete(id);
          }
          for (const id of ch.destroyed) {
            destroyed.add(id);
            changed.delete(id);
          }
          since = ch.newState;
          if (!ch.hasMoreChanges) break;
        }
        const fetched = await Promise.all(
          chunk([...changed], client.maxObjectsInGet).map((part) =>
            client.call<GetResponse<ContactCard>>("ContactCard/get", {
              accountId,
              ids: part,
            }),
          ),
        );
        // The account may have changed under us while the fetch was in flight.
        if (get().accountId !== accountId) return;
        set((s) => {
          const cards = { ...s.cards };
          for (const id of destroyed) delete cards[id];
          for (const r of fetched) {
            for (const c of r.list) cards[c.id] = c;
            // Listed as changed, gone by the time it was asked for.
            for (const id of r.notFound ?? []) delete cards[id];
          }
          return { cards, cardState: since, error: null };
        });
      } catch (err) {
        /*
         * A server that cannot compute changes is a normal answer, not a fault to
         * report: the fallback is what this did before, and it works everywhere.
         * Anything else is worth a line, because it means the sync path is not
         * doing what it is here for.
         */
        if (!(err instanceof JmapMethodError) || err.type !== "cannotCalculateChanges")
          console.warn("[gilbert] contact sync failed, reloading the books:", err);
        set({ cardState: null });
        await get().loadAll();
      }
    },

    async getCard(id, accountId) {
      const own = get().accountId;
      const target =
        accountId ?? (get().cards[id] ? own : (get().accountOfCard(id) ?? own));
      if (!target) return null;
      // The directory is served by a route, not held in an account: its card is
      // already in the store, and `global` is not a JMAP account to ask.
      if (target === GLOBAL_CONTACTS_ACCOUNT_ID)
        return get().sharedCards[sharedKey(target, id)] ?? null;
      const res = await client.call<GetResponse<ContactCard>>("ContactCard/get", {
        accountId: target,
        ids: [id],
      });
      const c = res.list[0];
      if (c) {
        if (target === own) set((s) => ({ cards: { ...s.cards, [c.id]: c } }));
        else
          set((s) => ({
            sharedCards: { ...s.sharedCards, [sharedKey(target, c.id)]: c },
          }));
      }
      return c ?? null;
    },

    filterCards(cards, text) {
      const q = text.trim().toLowerCase();
      const filtered = q ? cards.filter((c) => cardHaystack(c).includes(q)) : cards;
      /*
       * Each card's sort key is built once and the comparator reads what it built:
       * the sort runs O(n log n) comparisons, and a comparator that rebuilt and
       * lower-cased a display name on each side of every one of them was the
       * larger half of what a keystroke cost.
       */
      return filtered
        .map((card) => ({ card, key: sortKey(card) }))
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((entry) => entry.card);
    },

    search(text) {
      return get().filterCards(Object.values(get().cards), text);
    },

    cardsIn(accountId) {
      const own = get().accountId;
      if (!accountId || accountId === own) return Object.values(get().cards);
      return Object.entries(get().sharedCards)
        // The key's own reader, not a prefix written out again: one format.
        .filter(([key]) => accountOf(key) === accountId)
        .map(([, card]) => card);
    },

    /*
     * `accountId` is optional and qualified by the caller when the book id alone
     * is ambiguous: own and shared books live in different accounts and their
     * ids collide, so a bare id always resolves to the reader's own account.
     * Every place a human chooses a book passes the account that holds it.
     */
    async createCard(card, addressBookId, accountId?) {
      const accountId_ =
        accountId ??
        accountOfBook(addressBookId, get().books, get().accountId, get().sharedBooks);
      if (!accountId_) throw new Error("That address book is not available");
      refuseDirectoryWrite(accountId_);
      const obj = {
        "@type": "Card",
        version: "1.0",
        uid: crypto.randomUUID(),
        kind: "individual",
        ...card,
        addressBookIds: { [addressBookId]: true },
      };
      const res = await client.call<SetResponse<ContactCard>>("ContactCard/set", {
        accountId: accountId_,
        create: { c: obj },
      });
      const err = res.notCreated?.c;
      if (err) throw new Error(setErrorMessage(err));
      const id = res.created!.c!.id;
      await get().getCard(id, accountId_);
      return id;
    },

    /*
     * One more book for a card that already has one.
     *
     * The whole map goes out, not the new id alone: a JMAP update that sends
     * `addressBookIds` with one entry replaces the membership and moves the card,
     * which is the opposite of what was asked (measured on Stalwart 1.0.0: a card
     * with two books is kept, listed by both, and up to ten are allowed).
     *
     * The card is named by its account and its id, and the book must belong to
     * that account: a card lives inside one account, so no book of another
     * account can hold it.
     */
    async addCardToBook(card, bookId) {
      const own = get().accountId;
      const held =
        card.accountId === own || !card.accountId
          ? get().cards[card.id]
          : get().sharedCards[sharedKey(card.accountId, card.id)];
      /*
       * Nothing in hand means nothing to add to: the map would be built from an
       * empty set and the write would carry one id, which *moves* the card out of
       * the books it is in. Loud instead -- the card is always in the store by the
       * time a row is drawn, so a miss is a caller's mistake.
       */
      if (!held) throw new Error("That contact is not in this account");
      const books = { ...(held.addressBookIds ?? {}) };
      if (books[bookId]) return;
      books[bookId] = true;
      await get().updateCard(card, { addressBookIds: books });
    },

    /*
     * Move a card between accounts: the copy is created in the target account's
     * book and the original destroyed where it was. Cards are per-account
     * objects, so a cross-account move is not a patch -- the id changes too,
     * which is why this returns the new id for the caller to navigate to.
     *
     * `edited` is the card as the caller holds it after its own edits (the
     * editor's form object). The copy is built from that laid over the cached
     * card, never from the cache alone: the editor saves a move in the same
     * breath as its edits, and a copy made from what was cached would file the
     * old name -- and drop a photo uploaded for the move -- into the new book.
     */
    async moveCardTo(id, fromAccountId, toAccountId, toBookId, edited) {
      const own = get().accountId;
      if (!fromAccountId || !toAccountId)
        throw new Error("That address book is not available");
      refuseDirectoryWrite(fromAccountId);
      refuseDirectoryWrite(toAccountId);
      /*
       * Moving a card between accounts changes whose it is, so it is an
       * installation administrator's (ADR 0016). The guard is here, on the
       * effect, rather than on the menu that offers it: a form that changes a
       * card's account reaches the same write, and a rule kept on the surface
       * that draws the entry is a rule a second surface walks around.
       */
      const refusal = contactMoveRefusal({
        fromAccountId,
        toAccountId,
        isAdmin: sessionIsAdmin(useSession.getState().session),
      });
      if (refusal) throw new Error(contactMoveSentence(refusal));
      if (fromAccountId === toAccountId) {
        // Same account: file the card in the chosen book and take it out of the
        // others, as one full map. The cross-account path below is a true move
        // (create there, destroy here), so the same-account path moves too.
        const card =
          fromAccountId === own
            ? get().cards[id]
            : get().sharedCards[sharedKey(fromAccountId, id)];
        const books = card?.addressBookIds ?? {};
        const addressBookIds: Record<string, boolean | null> = { [toBookId]: true };
        for (const key of Object.keys(books))
          if (key !== toBookId) addressBookIds[key] = null;
        await get().updateCard(
          { id, accountId: fromAccountId === own ? null : fromAccountId },
          { addressBookIds },
        );
        return id;
      }
      const card =
        fromAccountId === own
          ? get().cards[id]
          : get().sharedCards[sharedKey(fromAccountId, id)];
      if (!card) throw new Error("Could not find the contact to move");
      const source = edited ? { ...card, ...edited } : card;
      const { id: _old, addressBookIds: _books, ...rest } = source;
      const newId = await get().createCard(
        rest as Partial<ContactCard>,
        toBookId,
        toAccountId,
      );
      const res = await client.call<SetResponse>("ContactCard/set", {
        accountId: fromAccountId,
        destroy: [id],
      });
      /* A destroy can be refused while the call itself succeeds. The copy is
         already in the target book by then, so a refusal must not take the
         source off the list as well -- a successful create plus an ignored
         refusal would duplicate the card on the server while hiding it locally. */
      const err = res.notDestroyed?.[id];
      if (err)
        throw new Error(
          "The contact was moved, but the copy in the old address book could not be deleted. Delete it by hand.",
        );
      set((st) => {
        if (fromAccountId === own) {
          const cards = { ...st.cards };
          delete cards[id];
          return { cards };
        }
        const sharedCards = { ...st.sharedCards };
        delete sharedCards[sharedKey(fromAccountId, id)];
        return { sharedCards };
      });
      await get().getCard(newId, toAccountId);
      return newId;
    },

    async updateCard(card, patch) {
      refuseDirectoryWrite(card.accountId);
      const accountId = card.accountId ?? get().accountId;
      // Loud rather than silent: a card with no account to write it to is a caller
      // mistake, and returning quietly would let a merge go on to destroy the card
      // it never merged.
      if (!accountId) throw new Error("No account holds that contact");
      const res = await client.call<SetResponse>("ContactCard/set", {
        accountId,
        update: { [card.id]: patch },
      });
      const err = res.notUpdated?.[card.id];
      if (err) throw new Error(setErrorMessage(err));
      await get().getCard(card.id, accountId);
    },

    /*
     * Every card that names `fromUid` -- a group's `members`, a card's
     * `relatedTo` -- is written back naming `toUid` instead. It runs before the
     * card that holds `fromUid` is destroyed, so nothing ever points at a uid that
     * is gone: a group keeps the member, a relation keeps its person.
     *
     * The cards are the account's, read from what the store holds; only the
     * reference is replaced, never the rest of the card.
     */
    async repointContactRefs(accountId, fromUid, toUid, skip = []) {
      if (!fromUid || !toUid || fromUid === toUid) return;
      const own = get().accountId;
      const target = accountId ?? own;
      if (!target) return;
      refuseDirectoryWrite(target);
      const cards =
        target === own
          ? Object.values(get().cards)
          : Object.entries(get().sharedCards)
              .filter(([key, card]) => accountOfSharedKey(key, card.id) === target)
              .map(([, card]) => card);
      const skipIds = new Set(skip);
      for (const card of cards) {
        if (skipIds.has(card.id)) continue;
        const patch: Record<string, unknown> = {};
        if (card.members?.[fromUid]) patch.members = { [fromUid]: null, [toUid]: true };
        const related = card.relatedTo ?? {};
        if (related[fromUid]) {
          const moved = related[fromUid]!;
          const held = related[toUid];
          const relation = { ...(moved.relation ?? {}), ...(held?.relation ?? {}) };
          patch.relatedTo = {
            [fromUid]: null,
            [toUid]: {
              ...moved,
              ...held,
              ...(Object.keys(relation).length ? { relation } : {}),
            },
          };
        }
        if (Object.keys(patch).length)
          await get().updateCard(
            { id: card.id, accountId: target === own ? null : target },
            patch,
          );
      }
    },

    /*
     * Batched for the same reason the imports are: a selection larger than
     * `maxObjectsInSet` is refused whole, so "select all" over a big address book
     * would delete nothing and say why in JMAP's words.
     *
     * Grouped by the account that holds each card, because `ContactCard/set` names
     * one account per call and a selection can span several: "All contacts" holds
     * the reader's own cards and every group's (membership is the subscription),
     * so sending the whole selection to the account of its *first* id would delete
     * nothing from the others and report the rest as refused.
     *
     * The ids that actually went are what leaves the list, rather than everything
     * that was asked for. A batch that fails after earlier ones succeeded must not
     * leave deleted contacts on screen, and must not take live ones off it -- so
     * what went is remembered per account, which is also what says where each one
     * leaves the cache from.
     */
    async destroyCards(cards, fromBook) {
      const own = get().accountId;
      /*
       * Every card is named by the account it lives in as well as its id. An id
       * alone is not an address: the reader's own card and a group's can carry the
       * same one, and a bare id resolves to the reader's own -- so destroying the
       * group's card would take the reader's own with it.
       *
       * With `fromBook`, the deletion is the book's: a card filed in more than one
       * book loses that one and stays where else it is, and only a card that is
       * here alone is destroyed. Without it -- the merge's absorbed card, the one
       * on screen -- the card itself goes, which is what those two mean.
       */
      const byAccount = new Map<Id, { destroy: Id[]; update: Record<Id, unknown> }>();
      for (const { id, accountId } of cards) {
        const target = accountId ?? own;
        if (!target) continue;
        // The directory is not a JMAP account: its cards leave the list through
        // the administration route, never a `ContactCard/set` at the sentinel.
        refuseDirectoryWrite(target);
        const held = byAccount.get(target) ?? { destroy: [], update: {} };
        const card =
          target === own ? get().cards[id] : get().sharedCards[sharedKey(target, id)];
        const books = Object.keys(card?.addressBookIds ?? {});
        if (fromBook && books.length > 1 && books.includes(fromBook))
          held.update[id] = { [`addressBookIds/${fromBook}`]: null };
        else held.destroy.push(id);
        byAccount.set(target, held);
      }
      const gone: Id[] = [];
      const goneByAccount = new Map<Id, Id[]>();
      const unfiledByAccount = new Map<Id, Id[]>();
      let unfiled = 0;
      let refused: SetError | undefined;
      try {
        for (const [accountId, part] of byAccount) {
          const res = await batchedSet<ContactCard>({
            method: "ContactCard",
            accountId,
            update: part.update,
            destroy: part.destroy,
          });
          if (res.destroyed.length) {
            gone.push(...res.destroyed);
            goneByAccount.set(accountId, res.destroyed);
          }
          const left = Object.keys(part.update);
          if (left.length) {
            unfiled += left.length;
            unfiledByAccount.set(accountId, left);
          }
          refused ??= res.refused;
        }
      } finally {
        if (gone.length)
          set((s) => {
            const cards = { ...s.cards };
            const sharedCards = { ...s.sharedCards };
            for (const [accountId, went] of goneByAccount)
              for (const id of went) {
                if (accountId === own) delete cards[id];
                else delete sharedCards[sharedKey(accountId, id)];
              }
            return { cards, sharedCards };
          });
        /*
         * A card taken out of one book is still here: its membership is patched
         * in place, so the list it was just removed from stops drawing it without
         * a second round trip. Only the book named is dropped -- any other book
         * keeps its place in the card.
         */
        if (unfiled && fromBook)
          set((s) => {
            const cards = { ...s.cards };
            const sharedCards = { ...s.sharedCards };
            for (const [accountId, ids] of unfiledByAccount)
              for (const id of ids) {
                const key = accountId === own ? id : sharedKey(accountId, id);
                const map = accountId === own ? cards : sharedCards;
                const card = map[key];
                if (!card) continue;
                const { [fromBook]: _gone, ...rest } = card.addressBookIds ?? {};
                map[key] = { ...card, addressBookIds: rest };
              }
            return { cards, sharedCards };
          });
      }
      /* Answered rather than thrown. A refusal that took half the selection with
         it still deleted the other half, and an error that says only "it failed"
         sends somebody looking for contacts that are already gone. */
      return { destroyed: gone.length, unfiled, refused };
    },
  };
}
