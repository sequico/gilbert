import { queryThenGet } from "@gilbert/shared/jmapQuery";
import { create } from "zustand";
import { CAP, chunk, client, JmapMethodError, setErrorMessage } from "@/jmap/client";
import type {
  AddressBook,
  ChangesResponse,
  ContactCard,
  EmailAddress,
  GetResponse,
  Id,
  Principal,
  QueryResponse,
  SetError,
  SetResponse,
} from "@/jmap/types";
import type { CardAddress } from "@/lib/contactAddress";
import { type ContactMoveRefusal, contactMoveRefusal } from "@/lib/contactMove";
import {
  contactDisplayName,
  contactEmails,
  groupRecipients,
  sortKey,
} from "@/lib/contacts";
import { t } from "@/lib/i18n";
import { loadPlace, placeOwnerFrom, rememberPlace } from "@/lib/lastPlace";
import { parseLdif, uidFromDn } from "@/lib/ldif";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { cardFromLdif } from "@/lib/mozillaAb";
import { accountKey, loadRaw, saveJson } from "@/lib/storage";
import { useMail } from "./mail";
import { useSession } from "./session";
import { useSettings } from "./settings";

/**
 * Create cards in batches the server will take.
 *
 * `ContactCard/set` is refused whole over `maxObjectsInSet` -- the server does
 * not take the first 500 and drop the rest, it creates nothing and answers
 * `requestTooLarge` -- so an address book big enough to cross the ceiling
 * imports nothing at all. The same failure the calendar import meets, found on a
 * real 800 KB export ([#173]).
 *
 * `maxObjectsInSet` is what the session advertises and 500 where a server does
 * not say; splitting by it rather than by a constant follows a deployment that
 * has tuned the limit.
 *
 * Both imports come through here, which is what makes the LDIF import the same
 * as the vCard import from `ContactCard/set` down.
 *
 * [#173]: https://git.coffeylabs.org/coffey-labs/ihasmail-github-archive/issues/173
 */
/**
 * The UIDs an address book already holds.
 *
 * Read once per import rather than once per card, and narrowed to the target
 * book from `addressBookIds` here rather than through a filter -- the same
 * arrangement, and for the same reasons, as the calendar's scan in #222.
 *
 * Asked of the server rather than read from the cards already in the store.
 * The store's copy is complete once the view has loaded, and importing is not
 * something that waits for a view: a scan that is right whatever the client
 * happens to be holding costs one pass over a list nobody imports into twice a
 * day.
 */
async function scanBook(
  accountId: Id,
  addressBookId: Id,
): Promise<{ byUid: Map<string, Id>; likeness: Set<string> }> {
  /* The id as well as the UID, because a card that is already here is updated
     rather than skipped, and updating needs something to address. */
  const byUid = new Map<string, Id>();
  const likeness = new Set<string>();
  const page = client.maxObjectsInGet;
  for (let position = 0; ; ) {
    const q = await client.call<QueryResponse>("ContactCard/query", {
      accountId,
      position,
      limit: page,
      calculateTotal: true,
    });
    const ids = q.ids ?? [];
    if (!ids.length) break;
    for (const part of chunk(ids, page)) {
      const g = await client.call<GetResponse<ContactCard>>("ContactCard/get", {
        accountId,
        ids: part,
        properties: ["uid", "addressBookIds", "name", "emails"],
      });
      for (const c of g.list) {
        if (!c.addressBookIds?.[addressBookId]) continue;
        if (c.uid && !byUid.has(c.uid)) byUid.set(c.uid, c.id);
        for (const key of likenessKeys(c)) likeness.add(key);
      }
    }
    position += ids.length;
    // `total` is optional, so the empty page above is what actually ends this.
    if (q.total != null && position >= q.total) break;
  }
  return { byUid, likeness };
}

/**
 * What makes two cards *look* like the same person -- name and one address.
 *
 * Deliberately not used to skip or merge anything. It is a guess, and it is
 * wrong in both directions: two colleagues who share a name and a shared alias
 * collapse into one, and somebody whose address changed since the last export
 * looks like a stranger. Either mistake is silent and one of them is
 * unrecoverable, so it counts and never acts.
 *
 * What is left for it to count is the entries that matching could not catch:
 * one whose `dn` moved between exports, and anything imported before there was
 * a `dn` to match on. Those arrive as new cards, and saying "40 of these look
 * like contacts you already had" is the honest half of the answer -- the
 * reported harm was
 * confusion rather than duplication, and being told costs nothing.
 *
 * One key per address, so a person whose second address matches is still
 * recognised.
 */
function likenessKeys(c: Partial<ContactCard>): string[] {
  const name = contactDisplayName(c as ContactCard)
    .trim()
    .toLowerCase();
  if (!name) return [];
  const addresses = Object.values(c.emails ?? {})
    .map((e) => e.address?.trim().toLowerCase())
    .filter(Boolean);
  return addresses.map((a) => `${name}\u0000${a}`);
}

async function writeCards(
  accountId: Id,
  create: Record<string, unknown>,
  update: Record<Id, unknown> = {},
): Promise<{ created: number; updated: number; refused?: SetError }> {
  /*
   * Creates and updates share one budget. Stalwart counts every object in a
   * `/set` against `maxObjectsInSet` -- creates, updates and destroys together
   * -- so batching them separately would let a file of 300 new and 300 changed
   * cards through as two calls of 300 and be refused for a limit of 500 that
   * neither half exceeds.
   */
  const keys = [
    ...Object.keys(create).map((k) => ["create", k] as const),
    ...Object.keys(update).map((k) => ["update", k] as const),
  ];
  let created = 0;
  let updated = 0;
  let refused: SetError | undefined;
  for (const part of chunk(keys, client.maxObjectsInSet)) {
    const subCreate: Record<string, unknown> = {};
    const subUpdate: Record<string, unknown> = {};
    for (const [kind, k] of part) {
      if (kind === "create") subCreate[k] = create[k];
      else subUpdate[k] = update[k];
    }
    let res: SetResponse<ContactCard>;
    try {
      res = await client.call<SetResponse<ContactCard>>("ContactCard/set", {
        accountId,
        create: subCreate,
        update: subUpdate,
      });
    } catch (err) {
      // A batch that failed with earlier ones already filed: those contacts are
      // in the address book, and an error saying only that the import failed
      // sends someone looking for contacts that are already there.
      if (!created && !updated) throw err;
      throw new Error(
        `${created + updated} of ${keys.length} contacts were imported before this happened: ${(err as Error).message}`,
      );
    }
    created += Object.keys(res.created ?? {}).length;
    updated += Object.keys(res.updated ?? {}).length;
    refused ??=
      Object.values(res.notCreated ?? {})[0] ?? Object.values(res.notUpdated ?? {})[0];
  }
  return { created, updated, refused };
}

export interface Suggestion {
  name: string | null;
  email: string;
  source: "contact" | "gal" | "recent";
  contactId?: Id;
  photo?: string | null;
  /**
   * A group of contacts, offered as one choice that expands (ADR 0004).
   *
   * `accountId` is where its members live -- a uid means nothing outside the
   * account that holds it -- and `members` is what the row says, so the reader
   * knows how many people they are about to add. Such a suggestion has no
   * address of its own: a group is not a recipient.
   */
  group?: { accountId: Id; members: number };
}

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

/** A book somebody else shared, and the account it lives in. */
export interface SharedBook {
  accountId: Id;
  accountName: string;
  book: AddressBook;
}

/**
 * Which account holds an address book: the reader's own when it is one of
 * theirs, otherwise the account that shared it -- a colleague's, or a group
 * mailbox the reader belongs to. Cards write to that account, never to the
 * reader's own.
 */
function accountOfBook(
  bookId: Id | null | undefined,
  own: Record<Id, AddressBook>,
  ownAccountId: Id | null,
  shared: SharedBook[],
): Id | null {
  if (!bookId) return ownAccountId;
  if (own[bookId]) return ownAccountId;
  return shared.find((b) => b.book.id === bookId)?.accountId ?? ownAccountId;
}

/** Which book the contact list is showing. `accountId` null means the reader's. */
export interface BookSelection {
  accountId: Id | null;
  bookId: Id | "all";
}

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

/*
 * Declared once, in `@/lib/sharedKey`: its format is what the reader's own
 * `settings.addedShares` stores, so a second spelling here would be a selection
 * that stops being found. Re-exported because this store's callers key cards by
 * it.
 */
import { accountOfSharedKey, sharedKey } from "@/lib/sharedKey";

export { sharedKey };

interface ContactsState {
  accountId: Id | null;
  available: boolean;
  books: Record<Id, AddressBook>;
  cards: Record<Id, ContactCard>;
  /** The server state `cards` was read at, for asking what changed since. */
  cardState: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  principals: Principal[];
  principalsLoaded: boolean;
  recent: EmailAddress[];
  /** Address books shared with the reader, from every non-personal account. */
  sharedBooks: SharedBook[];
  /** Their cards, keyed by account and id. See `sharedKey`. */
  sharedCards: Record<string, ContactCard>;
  sharedLoaded: boolean;
  selection: BookSelection;

  init(): Promise<void>;
  loadBooks(): Promise<void>;
  loadAll(): Promise<void>;
  /**
   * Bring `cards` up to date with what changed on the server, or load them all
   * when that cannot be worked out.
   */
  syncCards(): Promise<void>;
  /** Books and cards from accounts that shared with the reader. */
  loadShared(): Promise<void>;
  select(selection: BookSelection): void;
  /** Add a shared address book to, or remove it from, the reader's own view. */
  setBookSubscribed(accountId: Id, bookId: Id, subscribed: boolean): Promise<void>;
  /** The account a card belongs to, null for the reader's own. */
  accountOfCard(id: Id): Id | null;
  /**
   * What the books holding this card are called, in the reader's terms.
   *
   * Resolved through the account that **holds the card**, because a book id is
   * only unambiguous inside one: a default book is seeded per account, so the
   * reader's own book and a group's may carry the same id, and looking an id up
   * in the reader's own books alone names their book for a card that is in a
   * group's. A book in another account is named as the composer names one --
   * `book · account` -- since two groups may each keep a book of the same name.
   *
   * One place, because the question is asked by more than one surface and a
   * second spelling of "which book is this card in" is how one of them comes to
   * name the wrong one.
   */
  bookNamesOf(card: ContactCard, heldIn?: Id | null): string[];
  /**
   * Whether the reader may write this card where it lives.
   *
   * Not "is it in the reader's own account": a group's address book is in the
   * group's account and a member writes it, exactly as the group's calendars
   * and files are written by them. The book that holds the card decides — the
   * reader's own is always writable, a colleague's share when it grants a
   * write, a group's own book when the membership does.
   *
   * A card whose books have not answered yet is *offered*: nothing loaded says
   * the reader may not write it, and the write that follows is the server's to
   * refuse in its own words. Withholding on a guess is the worse failure — it
   * takes the controls off a card that is usually the reader's own.
   */
  cardWritable(card: ContactCard, heldIn?: Id | null): boolean;
  /** The account holding an address book, null when it is not the reader's own. */
  accountOfBook(bookId: Id): Id | null;
  getCard(id: Id, accountId?: Id | null): Promise<ContactCard | null>;
  /**
   * The addresses behind a group, whichever surface asked (ADR 0004).
   *
   * `accountId` names the account the group lives in, which is also where its
   * members are; null or the reader's own means their own books. One
   * resolution for the suggestion list, the recipient picker and the contact
   * card's own action -- three answers to "who is in this group" is how one of
   * them comes to disagree with the others.
   */
  expandGroup(
    group: ContactCard,
    accountId: Id | null,
  ): { addresses: EmailAddress[]; skipped: number };
  search(text: string): ContactCard[];
  /**
   * The cards of one account, as the reader may read them.
   *
   * The reader's own when `accountId` is null or theirs, otherwise that
   * account's cards -- which is what a card living there refers to. A group's
   * members are the group's own cards, not copies in the reader's book, and a
   * `uid` means nothing outside the account that holds it.
   */
  cardsIn(accountId: Id | null): ContactCard[];
  /** The search filter itself, so a shared book can be filtered the same way. */
  filterCards(cards: ContactCard[], text: string): ContactCard[];
  createCard(
    card: Partial<ContactCard>,
    addressBookId: Id,
    accountId?: Id | null,
  ): Promise<Id>;
  /** Move a card between accounts (create in the target, destroy the original). */
  moveCardTo(
    id: Id,
    fromAccountId: Id,
    toAccountId: Id,
    toBookId: Id,
    edited?: Partial<ContactCard>,
  ): Promise<Id>;
  /**
   * Write a patch to one card, named by its account and its id.
   *
   * The pair, because an id alone resolves to the reader's own card wherever one
   * carries it: a group's card whose id the reader also holds would be patched in
   * the reader's own account instead.
   */
  updateCard(card: CardAddress, patch: Record<string, unknown>): Promise<void>;
  /**
   * Delete cards outright, reporting what the server actually destroyed rather
   * than what was asked for. Nothing is thrown for a refusal -- a partial one
   * has a count worth telling somebody about, and `refused` says why the rest
   * did not go.
   *
   * A selection may span accounts, so the calls are grouped by the one holding
   * each card and the count is what the server confirmed across them.
   */
  destroyCards(cards: CardAddress[]): Promise<{ destroyed: number; refused?: SetError }>;
  /**
   * Empty an address book: everything filed in it, gone.
   *
   * `unfiled` is the part that is not a deletion. A card filed in two books is
   * only *this* book's to remove, so it is taken out of this one and left
   * alone in the other -- destroying it would empty a book nobody asked about.
   */
  emptyBook(
    bookId: Id,
  ): Promise<{ destroyed: number; unfiled: number; refused?: SetError }>;
  /** Create an address book; pass `accountId` to create it in a group account, owned by the group. */
  createBook(name: string, accountId?: Id): Promise<Id>;
  /**
   * Rename an address book, or patch it some other way.
   *
   * `accountId` is the account that holds it, and a caller that knows it must
   * pass it: a book id is unique only within its account -- a default book is
   * seeded per account, so the reader's own and a group's can carry the same
   * one -- and resolving the bare id prefers the reader's own. Renaming the
   * group's directory renamed theirs.
   */
  updateBook(id: Id, patch: Partial<AddressBook>, accountId?: Id | null): Promise<void>;
  destroyBook(id: Id, accountId?: Id | null): Promise<void>;
  /** Import vCards, updating any whose UID this book already holds rather than duplicating it. */
  importVCard(
    text: string,
    addressBookId: Id,
  ): Promise<{ created: number; updated: number; alike: number }>;
  /**
   * Import an address book in LDIF, read against Mozilla's schema.
   *
   * Mozilla's schema has no UID, so a re-import is recognised by the entry's
   * `dn` instead -- the same update-rather-than-duplicate rule the vCard import
   * follows, on the only identity the file carries. `alike` is what is left
   * over: entries that were created and still look like somebody already here,
   * which is what a changed `dn` produces. Answered in the same shape as the
   * vCard import so the caller need not know which it called.
   */
  importLdif(
    text: string,
    addressBookId: Id,
  ): Promise<{ created: number; updated: number; alike: number }>;
  loadPrincipals(): Promise<void>;
  suggest(query: string, limit?: number): Promise<Suggestion[]>;
  addRecent(addrs: EmailAddress[]): void;
  lookupByEmail(email: string): ContactCard | undefined;
  applyChanges(types: Set<string>, accountId?: Id): void;
}

export const CARD_PROPS = undefined; // all properties

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
 * Put the reader back on the book they had open, if it is still there.
 *
 * A book chosen on this device last time is not a decision to make again. The
 * record is only a seed: the check against what actually loaded is what keeps
 * a deleted or unshared book from stranding the view on nothing.
 */
export function restoreBookPlace() {
  const st = useContacts.getState();
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

/* One shared-contacts load at a time; several callers may ask at once. */
let sharedLoadRun: Promise<void> | null = null;

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
  selection: { accountId: null, bookId: "all" },

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
      const session = useSession.getState();
      const own = session.ownAccountFor(CAP.contacts);
      const s = session.session;
      const accounts = Object.entries(s?.accounts ?? {}).filter(
        ([id, a]) => a.isPersonal === false && id !== own,
      );
      if (!accounts.length) {
        set({ sharedBooks: [], sharedCards: {}, sharedLoaded: true });
        restoreBookPlace();
        return;
      }
      const groupIds = await groupMailboxIds();
      const books: SharedBook[] = [];
      const cards: Record<string, ContactCard> = {};
      /*
       * Every account at once. `client.call` batches the calls made in one tick
       * into a single request, so the loop this replaces sent one request after
       * another -- a shared account apiece, before the reader had opened
       * anything.
       */
      await Promise.all(
        accounts.map(async ([accountId, account]) => {
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
          } catch {}
        }),
      );
      /*
       * Answers arrive in any order, and the sidebar lists them in the session's
       * order -- so the books are put back in it rather than left in whatever
       * order the requests happened to finish.
       */
      const order = new Map(accounts.map(([id], i) => [id, i]));
      books.sort((a, b) => (order.get(a.accountId) ?? 0) - (order.get(b.accountId) ?? 0));
      set({ sharedBooks: books, sharedCards: cards, sharedLoaded: true });
      restoreBookPlace();
    })();
    sharedLoadRun = run;
    void run.finally(() => {
      if (sharedLoadRun === run) sharedLoadRun = null;
    });
    return run;
  },

  async setBookSubscribed(accountId, bookId, subscribed) {
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
    await get().loadShared();
  },

  select(selection) {
    set({ selection });
    rememberPlace(placeOwnerFrom(useSession.getState()), {
      book: { accountId: selection.accountId, bookId: selection.bookId },
    });
  },

  accountOfCard(id) {
    if (get().cards[id]) return null;
    const hit = Object.entries(get().sharedCards).find(([key]) => key.endsWith(`:${id}`));
    return hit ? accountOfSharedKey(hit[0], id) : null;
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
      if (held) names.push(`${held.book.name} · ${held.accountName}`);
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

  async loadBooks() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const res = await client.call<GetResponse<AddressBook>>("AddressBook/get", {
        accountId,
        ids: null,
        properties: ADDRESS_BOOK_PROPS,
      });
      const books: Record<Id, AddressBook> = {};
      for (const b of res.list) books[b.id] = b;
      set({ books, error: null });
      restoreBookPlace();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async loadAll() {
    const accountId = get().accountId;
    if (!accountId || get().loading) return;
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
              "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" },
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
      set({ cards, cardState, loaded: true, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
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
    const filtered = q
      ? cards.filter((c) => {
          const hay = [
            contactDisplayName(c),
            ...Object.values(c.emails ?? {}).map((e) => e.address),
            ...Object.values(c.phones ?? {}).map((p) => p.number),
            ...Object.values(c.organizations ?? {}).map((o) => o.name ?? ""),
            ...Object.values(c.nicknames ?? {}).map((n) => n.name),
          ]
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        })
      : cards;
    return filtered.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  },

  search(text) {
    return get().filterCards(Object.values(get().cards), text);
  },

  expandGroup(group, accountId) {
    return groupRecipients(group, get().cardsIn(accountId));
  },

  cardsIn(accountId) {
    const own = get().accountId;
    if (!accountId || accountId === own) return Object.values(get().cards);
    const prefix = `${accountId}:`;
    return Object.entries(get().sharedCards)
      .filter(([key]) => key.startsWith(prefix))
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
    /*
     * Moving a card between accounts changes whose it is, so it is an
     * installation administrator's (ADR 0018). The guard is here, on the
     * effect, rather than on the menu that offers it: a form that changes a
     * card's account reaches the same write, and a rule kept on the surface
     * that draws the entry is a rule a second surface walks around.
     */
    const refusal = contactMoveRefusal({
      fromAccountId,
      toAccountId,
      isAdmin: useSession.getState().session?.gilbert?.isAdmin === true,
    });
    if (refusal) throw new Error(contactMoveSentence(refusal));
    if (fromAccountId === toAccountId) {
      // Same account: a patch that adds the target book, mirroring updateCard.
      await get().updateCard(
        { id, accountId: fromAccountId === own ? null : fromAccountId },
        { addressBookIds: { [toBookId]: true } },
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
    const accountId = card.accountId ?? get().accountId;
    if (!accountId) return;
    const res = await client.call<SetResponse>("ContactCard/set", {
      accountId,
      update: { [card.id]: patch },
    });
    const err = res.notUpdated?.[card.id];
    if (err) throw new Error(setErrorMessage(err));
    await get().getCard(card.id, accountId);
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
  async destroyCards(cards) {
    const own = get().accountId;
    /*
     * Every card is named by the account it lives in as well as its id. An id
     * alone is not an address: the reader's own card and a group's can carry the
     * same one, and a bare id resolves to the reader's own -- so destroying the
     * group's card would take the reader's own with it.
     */
    const byAccount = new Map<Id, Id[]>();
    for (const { id, accountId } of cards) {
      const target = accountId ?? own;
      if (!target) continue;
      const held = byAccount.get(target);
      if (held) held.push(id);
      else byAccount.set(target, [id]);
    }
    const gone: Id[] = [];
    const goneByAccount = new Map<Id, Id[]>();
    let refused: SetError | undefined;
    try {
      for (const [accountId, part] of byAccount)
        for (const batch of chunk(part, client.maxObjectsInSet)) {
          const res = await client.call<SetResponse>("ContactCard/set", {
            accountId,
            destroy: batch,
          });
          const destroyed = res.destroyed ?? [];
          if (destroyed.length) {
            gone.push(...destroyed);
            const went = goneByAccount.get(accountId);
            if (went) went.push(...destroyed);
            else goneByAccount.set(accountId, [...destroyed]);
          }
          refused ??= Object.values(res.notDestroyed ?? {})[0];
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
    }
    /* Answered rather than thrown. A refusal that took half the selection with
       it still deleted the other half, and an error that says only "it failed"
       sends somebody looking for contacts that are already gone. */
    return { destroyed: gone.length, refused };
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

    const gone: Id[] = [];
    let unfiled = 0;
    let refused: SetError | undefined;
    /* One budget for both, the way `writeCards` shares one: Stalwart counts
       every object in a `/set` against `maxObjectsInSet` together. */
    const work = [
      ...destroy.map((id) => ["destroy", id] as const),
      ...Object.keys(update).map((id) => ["update", id] as const),
    ];
    try {
      for (const part of chunk(work, client.maxObjectsInSet)) {
        const partDestroy = part
          .filter(([kind]) => kind === "destroy")
          .map(([, id]) => id);
        const partUpdate: Record<Id, unknown> = {};
        for (const [kind, id] of part) if (kind === "update") partUpdate[id] = update[id];
        const res = await client.call<SetResponse<ContactCard>>("ContactCard/set", {
          accountId,
          ...(partDestroy.length ? { destroy: partDestroy } : {}),
          ...(Object.keys(partUpdate).length ? { update: partUpdate } : {}),
        });
        gone.push(...(res.destroyed ?? []));
        unfiled += Object.keys(res.updated ?? {}).length;
        refused ??=
          Object.values(res.notDestroyed ?? {})[0] ??
          Object.values(res.notUpdated ?? {})[0];
      }
    } finally {
      await get().syncCards();
    }
    return { destroyed: gone.length, unfiled, refused };
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
    else await get().loadShared();
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
    const res = await client.call<SetResponse>("AddressBook/set", {
      accountId: target,
      update: { [id]: patch },
    });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    if (target === own) await get().loadBooks();
    else await get().loadShared();
  },

  async destroyBook(id, accountId) {
    const own = get().accountId;
    const target = accountId ?? accountOfBook(id, get().books, own, get().sharedBooks);
    if (!target) throw new Error("That address book is not available");
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
      await get().loadShared();
    }
  },

  async importVCard(text, addressBookId) {
    const accountId = accountOfBook(
      addressBookId,
      get().books,
      get().accountId,
      get().sharedBooks,
    );
    if (!accountId) throw new Error("That address book is not available");
    const up = await client.upload(accountId, new Blob([text], { type: "text/vcard" }), {
      type: "text/vcard",
    });
    const parsed = await client.call<{
      parsed?: Record<string, ContactCard[] | ContactCard>;
      notParsable?: Id[];
    }>("ContactCard/parse", { accountId, blobIds: [up.blobId] });
    const entry = parsed.parsed?.[up.blobId];
    const cards: ContactCard[] = entry ? (Array.isArray(entry) ? entry : [entry]) : [];
    if (!cards.length) throw new Error("No contacts found in file");
    const { byUid } = await scanBook(accountId, addressBookId);
    const create: Record<string, unknown> = {};
    const update: Record<Id, unknown> = {};
    // The cards this pass has already queued, by UID: a file may repeat a UID.
    const queuedByUid = new Map<string, string>();
    cards.forEach((c, i) => {
      const { id: _id, addressBookIds: _ab, ...rest } = c as ContactCard & { id?: Id };
      /*
       * A vCard UID is an identity its author meant, so a card whose UID this
       * book already holds is that card -- and the newer version of it wins.
       *
       * A UID the book does not hold yet is still a UID: a file that repeats
       * one queues a single card, the later version winning, rather than two
       * cards that then disagree about what the same UID says.
       *
       * The write is a merge, not a replacement. Properties the file carries
       * overwrite what
       * is here; properties it does not mention are left alone, so a phone
       * number somebody added in Gilbert after the first import survives a
       * re-import of the original file. The cost is that a field genuinely
       * deleted at the source stays here -- worth it, because the other way
       * round loses work nobody asked to lose.
       */
      const existing = rest.uid ? byUid.get(rest.uid) : undefined;
      if (existing) {
        update[existing] = { ...rest, addressBookIds: undefined };
        delete (update[existing] as Record<string, unknown>).addressBookIds;
        return;
      }
      const queued = rest.uid ? queuedByUid.get(rest.uid) : undefined;
      if (queued) {
        create[queued] = { ...(create[queued] as Record<string, unknown>), ...rest };
        return;
      }
      create[`c${i}`] = {
        ...rest,
        uid: rest.uid || crypto.randomUUID(),
        addressBookIds: { [addressBookId]: true },
      };
      if (rest.uid) queuedByUid.set(rest.uid, `c${i}`);
    });
    try {
      const { created, updated, refused } = await writeCards(accountId, create, update);
      // Nothing at all got in: say why rather than report importing none as
      // though the file had been empty. The LDIF import said this already; a
      // vCard import that quietly returned 0 was the odd one out.
      if (!created && !updated)
        throw new Error(
          refused
            ? setErrorMessage(refused)
            : "the server did not accept any of its contacts",
        );
      /* No likeness count: a vCard carries a UID, so anything already here was
         matched on it rather than guessed at. */
      return { created, updated, alike: 0 };
    } finally {
      if (accountId === get().accountId) await get().syncCards();
      else await get().loadShared();
    }
  },

  /*
   * LDIF, which nothing on the server reads.
   *
   * vCard has `ContactCard/parse` and so never needed a parser here; LDIF has
   * no equivalent, so the file is read in the browser -- `parseLdif` for the
   * syntax, `cardFromLdif` for what Mozilla's schema means by it -- and what
   * goes to the server is finished cards. That is the whole difference between
   * the two imports; from `ContactCard/set` down they are the same.
   */
  async importLdif(text, addressBookId) {
    const accountId = accountOfBook(
      addressBookId,
      get().books,
      get().accountId,
      get().sharedBooks,
    );
    if (!accountId) throw new Error("That address book is not available");
    /* The record and not just the card: the `dn` is the entry's identity and
       `cardFromLdif` deliberately does not carry it into the card. */
    const entries = parseLdif(text)
      .map((rec) => ({ uid: uidFromDn(rec.dn), card: cardFromLdif(rec) }))
      .filter(
        (e): e is { uid: string | null; card: Partial<ContactCard> } => e.card !== null,
      );
    if (!entries.length) throw new Error("it has no contacts in it");
    /*
     * Read before anything is written, so "already had" means before this
     * import rather than including it.
     */
    const before = await scanBook(accountId, addressBookId);
    let alike = 0;
    const create: Record<string, unknown> = {};
    const update: Record<Id, unknown> = {};
    /* Where in `create` an entry from this same file already landed. A
       directory cannot hold two entries under one `dn`, so a file that does is
       malformed -- but it must not become two cards sharing a uid, which is a
       duplicate of exactly the kind being fixed here. The later one wins, as it
       would in the directory. */
    const pending = new Map<string, string>();
    entries.forEach(({ uid, card }, i) => {
      /*
       * An entry whose `dn` this book already holds is that entry, and the
       * newer version of it wins -- a merge, as the vCard import does it:
       * properties the file carries overwrite what is here, properties it does
       * not mention are left alone. The reason to import a file twice is
       * usually that the first attempt was not right, so skipping would mean a
       * corrected export corrects nothing (#174).
       */
      const existing = uid ? before.byUid.get(uid) : undefined;
      if (existing) {
        update[existing] = card;
        return;
      }
      const seen = uid ? pending.get(uid) : undefined;
      const key = seen ?? `c${i}`;
      if (uid) pending.set(uid, key);
      /*
       * Only what is actually being created can look like a duplicate: what
       * matched above is not a look-alike but the same entry. So this counts
       * what `dn` matching could not catch -- an entry whose `dn` moved, or one
       * imported before there was anything to match on -- and still only
       * counts, because name-plus-email is a guess wrong in both directions and
       * a merge made on a guess cannot be undone.
       */
      if (!seen && likenessKeys(card).some((k) => before.likeness.has(k))) alike++;
      create[key] = {
        "@type": "Card",
        version: "1.0",
        ...card,
        uid: uid ?? crypto.randomUUID(),
        addressBookIds: { [addressBookId]: true },
      };
    });
    try {
      const { created, updated, refused } = await writeCards(accountId, create, update);
      if (!created && !updated)
        throw new Error(
          refused
            ? setErrorMessage(refused)
            : "the server did not accept any of its contacts",
        );
      return { created, updated, alike };
    } finally {
      if (accountId === get().accountId) await get().syncCards();
      else await get().loadShared();
    }
  },

  async loadPrincipals() {
    if (get().principalsLoaded) return;
    const accountId = useSession.getState().accountFor(CAP.principals);
    if (!accountId || !client.hasCapability(CAP.principals)) {
      set({ principalsLoaded: true });
      return;
    }
    try {
      const res = await client.chain([
        ["Principal/query", { accountId, limit: 1000 }, "q"],
        [
          "Principal/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Principal/query", path: "/ids" },
            properties: ["id", "type", "name", "description", "email", "timeZone"],
          },
          "g",
        ],
      ]);
      const g = res.get("g")?.[0] as unknown as GetResponse<Principal>;
      set({ principals: g.list, principalsLoaded: true });
    } catch {
      set({ principalsLoaded: true });
    }
  },

  async suggest(query, limit = 8) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const st = get();
    if (!st.loaded && st.available && !st.loading) void st.loadAll();
    if (!st.principalsLoaded) void st.loadPrincipals();
    const out: Suggestion[] = [];
    const seen = new Set<string>();
    const add = (s: Suggestion) => {
      // A group has no address; its own key is its account and card. Without
      // this every group would answer to the empty string and only the first
      // would ever be offered.
      const k = s.group
        ? `group:${s.group.accountId}:${s.contactId ?? ""}`
        : s.email.toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(s);
    };
    const score = (name: string | null, email: string): number => {
      const n = (name ?? "").toLowerCase();
      const e = email.toLowerCase();
      if (e.startsWith(q) || n.startsWith(q)) return 0;
      if (n.split(/\s+/).some((w) => w.startsWith(q))) return 1;
      if (e.includes(q) || n.includes(q)) return 2;
      return 99;
    };
    const candidates: Array<Suggestion & { score: number }> = [];
    // A shared address book is only useful if it answers when you are writing
    // to someone in it, so its cards are offered alongside the reader's own.
    // They rank a shade lower, so a name in both wins from your own book.
    /* Own cards carry the reader's own account; a shared card carries the
       account it came from, which is what its key is made of -- a group's
       members are in that account, and a uid means nothing outside it. */
    const own = Object.values(st.cards).map((c) => ({
      c,
      penalty: 0,
      accountId: st.accountId,
    }));
    const shared = Object.entries(st.sharedCards).map(([key, c]) => ({
      c,
      penalty: 0.5,
      accountId: key.slice(0, key.length - c.id.length - 1),
    }));
    for (const { c, penalty, accountId } of [...own, ...shared]) {
      for (const a of contactEmails(c)) {
        const sc = score(a.name, a.email);
        if (sc < 99)
          candidates.push({
            name: a.name,
            email: a.email,
            source: "contact",
            contactId: c.id,
            score: sc + penalty,
          });
      }
      /*
       * A group is offered as one choice, and it expands when it is taken
       * (ADR 0004). It has no address of its own, so nothing here adds one;
       * what the row needs is a name, the account its members are in, and how
       * many there are.
       */
      if (c.kind === "group") {
        const name = contactDisplayName(c);
        const sc = score(name, "");
        if (sc < 99)
          candidates.push({
            name,
            email: "",
            source: "contact",
            contactId: c.id,
            group: {
              accountId: accountId ?? st.accountId ?? "",
              members: Object.keys(c.members ?? {}).length,
            },
            score: sc + penalty,
          });
      }
    }
    for (const p of st.principals) {
      if (!p.email) continue;
      const sc = score(p.name, p.email);
      if (sc < 99)
        candidates.push({ name: p.name, email: p.email, source: "gal", score: sc + 0.5 });
    }
    for (const r of st.recent) {
      const sc = score(r.name, r.email);
      if (sc < 99)
        candidates.push({
          name: r.name,
          email: r.email,
          source: "recent",
          score: sc + 0.25,
        });
    }
    candidates.sort(
      (a, b) => a.score - b.score || (a.name ?? a.email).localeCompare(b.name ?? b.email),
    );
    for (const c of candidates) {
      add(c);
      if (out.length >= limit) break;
    }
    return out;
  },

  addRecent(addrs) {
    const cur = get().recent;
    const next = [
      ...addrs.filter((a) => a.email),
      ...cur.filter(
        (r) => !addrs.some((a) => a.email.toLowerCase() === r.email.toLowerCase()),
      ),
    ].slice(0, 200);
    set({ recent: next });
    try {
      saveJson(accountKey(get().accountId, "recent"), next);
    } catch {
      /* ignore */
    }
  },

  lookupByEmail(email) {
    const e = email.toLowerCase();
    const match = (c: ContactCard) =>
      Object.values(c.emails ?? {}).some((x) => x.address.toLowerCase() === e);
    // The reader's own books first: a card they wrote themselves should win
    // over a colleague's version of the same person.
    return (
      Object.values(get().cards).find(match) ??
      Object.values(get().sharedCards).find(match)
    );
  },

  applyChanges(types, accountId) {
    /*
     * Shared books and cards live in accounts that are not the reader's own,
     * but they are drawn beside the reader's own — so a change to a shared
     * account has to reload the shared cache, not the own one. The account
     * that changed is what the push dispatch hands over.
     */
    if (accountId && accountId !== get().accountId) {
      const s = useSession.getState().session;
      const shared = s?.accounts?.[accountId]?.isPersonal === false;
      if (shared && (types.has("AddressBook") || types.has("ContactCard")))
        void get().loadShared();
      return;
    }
    if (types.has("AddressBook")) {
      void get().loadBooks();
      void get().loadShared();
    }
    if (types.has("ContactCard") && get().loaded) void get().syncCards();
  },
}));

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
      selection: { accountId: null, bookId: "all" },
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
