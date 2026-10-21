import type { StoreApi } from "zustand";
import type {
  AddressBook,
  ContactCard,
  EmailAddress,
  Id,
  Principal,
  SetError,
} from "@/jmap/types";
import type { CardAddress } from "@/lib/contactAddress";
import type { MergeFieldId, MergeSide } from "@/lib/contactMerge";

export interface Suggestion {
  name: string | null;
  email: string;
  source: "contact" | "gal" | "recent";
  contactId?: Id;
  photo?: string | null;
  /**
   * A group of contacts, offered as one choice that expands (ADR 0003).
   *
   * `accountId` is where its members live -- a uid means nothing outside the
   * account that holds it -- and `members` is what the row says, so the reader
   * knows how many people they are about to add. Such a suggestion has no
   * address of its own: a group is not a recipient.
   */
  group?: { accountId: Id; members: number };
}

/** A book somebody else shared, and the account it lives in. */
export interface SharedBook {
  accountId: Id;
  accountName: string;
  book: AddressBook;
}

/** Which book the contact list is showing. `accountId` null means the reader's. */
interface BookSelection {
  accountId: Id | null;
  bookId: Id | "all";
}

export interface ContactsState {
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
  /**
   * Which shared accounts could not be read, when some of them could not.
   *
   * A book missing from the sidebar reads as a book nobody shared, so the
   * answer for "nothing added yet" has to say *which* is the case. Null is the
   * ordinary state; the sidebar draws this instead of the empty sentence.
   */
  sharedLoadError: string | null;
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
  /**
   * Re-read the shared books after a write, past any load already in flight.
   *
   * `loadShared` is single-flight, so a caller that asks while one is running
   * is handed that run's answer — which may predate the write it just made.
   * This waits the running load out first, so the answer is the write's.
   */
  reloadShared(): Promise<void>;
  select(selection: BookSelection): void;
  /** Add a shared address book to, or remove it from, the reader's own view. */
  setBookSubscribed(accountId: Id, bookId: Id, subscribed: boolean): Promise<void>;
  /**
   * The account a card belongs to, null for the reader's own.
   *
   * A card of the installation's directory answers the sentinel account it is
   * installed under (ADR 0019), never the reader's own: its writes go through
   * the administration's route, so no caller may take that answer for a JMAP
   * account.
   */
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
   * The addresses behind a group, whichever surface asked (ADR 0003).
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
  /**
   * Write a card's fields. Throws when no account holds it -- a card with
   * nowhere to be written is a caller mistake, and returning quietly would let a
   * merge go on to destroy the card it never merged.
   */
  updateCard(card: CardAddress, patch: Record<string, unknown>): Promise<void>;
  /**
   * Merge two cards of one book into the one that survives.
   *
   * The merged card is written first, the references that named the card being
   * absorbed are re-pointed at the survivor, and only then is it destroyed -- so
   * a destroyed uid is never still named by a group's member list or a relation.
   * `primary` is the card that survives; each is named with the account it lives
   * in, because an id alone is not unique across accounts. `picks` answers the
   * one-slot fields the two disagree on -- see `lib/contactMerge` for which those
   * are.
   */
  mergeCards(
    primary: { card: ContactCard; accountId: Id | null },
    secondary: { card: ContactCard; accountId: Id | null },
    picks?: Partial<Record<MergeFieldId, MergeSide>>,
  ): Promise<{ destroyed: number; refused?: SetError }>;
  /**
   * Re-point every card that names `fromUid` -- a group's `members`, a card's
   * `relatedTo` -- at `toUid`, in one account, skipping the ids given.
   *
   * The account's cards are the ones the store holds; each card whose reference
   * moved is written back with that reference replaced, and nothing else of the
   * card is rebuilt. `fromUid` and `toUid` are the uids two cards merge across.
   */
  repointContactRefs(
    accountId: Id | null,
    fromUid: string,
    toUid: string,
    skip?: Id[],
  ): Promise<void>;
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
   * Save the addresses written to that no card holds yet, in the reader's own
   * "Collected" book, so every device suggests them. `own` is the sender's own
   * addresses, which are never collected, and `from` is the account the message
   * goes out from: only the reader's own collects. Answers how many cards were
   * created and, when the server refused some, the refusal — a count alone has
   * nowhere to say that the book nobody can write to failed silently.
   */
  collectRecipients(
    addrs: EmailAddress[],
    own: string[],
    from: Id | null,
  ): Promise<{ written: number; refused?: SetError }>;
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

/**
 * What `create` hands a slice: the store's own reader and writer.
 *
 * The store is assembled in `index.ts` from one function per job, and a slice
 * never imports the store it belongs to -- it is handed these two, which is what
 * keeps the modules acyclic and each one readable on its own.
 */
export type ContactsSet = StoreApi<ContactsState>["setState"];
export type ContactsGet = StoreApi<ContactsState>["getState"];
