/**
 * The dialer's sources (ADR 0023): the contacts the mini list offers, separated
 * the way the Contacts view separates them.
 *
 * A pure function of what the contacts store already holds, so the separation
 * is one rule that tests can pin and the surface only renders. The order is the
 * decision's: **Global contacts, each group, the reader's personal books, and
 * everything together**.
 */
import { GLOBAL_CONTACTS_BOOK_NAME } from "@gilbert/shared/phone";
import type { ContactCard } from "@/jmap/types";
import { isGlobalContactsBook } from "@/lib/contacts";
import type { SharedBook } from "@/store/contacts";

export interface DialerSource {
  /** Stable key for React and for the selection. */
  id: string;
  /** What the source is called on screen. */
  label: string;
  /** Whether this is the installation's own shared directory. */
  global: boolean;
  /**
   * The account the source's cards live in. A card id is unique inside its
   * account and nowhere else, so this is half of a card's identity — and the
   * reason the "all" list must not de-duplicate on the bare id.
   */
  accountId: string;
  cards: ContactCard[];
}

export interface DialerInput {
  /** The reader's own cards, from every book they own. */
  ownCards: ContactCard[];
  /** Books shared with the reader, with the account each lives in. */
  sharedBooks: SharedBook[];
  /** A group account's cards, keyed by account id. */
  cardsIn: (accountId: string) => ContactCard[];
  /** The group mailboxes the reader is a member of. */
  groups: Array<{ accountId: string; name: string }>;
  /** The label the reader's own source carries. */
  personalLabel: string;
  /** The account the reader's own cards live in, for the (account, id) key. */
  ownAccountId: string;
}

/** The cards filed in one book. */
function cardsInBook(cards: ContactCard[], bookId: string): ContactCard[] {
  return cards.filter((c) => c.addressBookIds?.[bookId]);
}

/**
 * The sources, in the order they are shown.
 *
 * Global contacts first — it is the directory everyone shares — then each group
 * the reader belongs to, then their own books. The "all" source is not here:
 * the surface draws that one itself, over every source at once, so the reader's
 * own cards are not counted twice.
 */
export function dialerSources(input: DialerInput): DialerSource[] {
  const sources: DialerSource[] = [];

  for (const book of input.sharedBooks.filter((b) => isGlobalContactsBook(b.book)))
    sources.push({
      id: `global:${book.accountId}:${book.book.id}`,
      label: GLOBAL_CONTACTS_BOOK_NAME,
      global: true,
      accountId: book.accountId,
      cards: cardsInBook(input.cardsIn(book.accountId), book.book.id),
    });

  for (const group of input.groups) {
    const cards = input.cardsIn(group.accountId);
    if (cards.length)
      sources.push({
        id: `group:${group.accountId}`,
        label: group.name,
        global: false,
        accountId: group.accountId,
        cards,
      });
  }

  if (input.ownCards.length)
    sources.push({
      id: "personal",
      label: input.personalLabel,
      global: false,
      accountId: input.ownAccountId,
      cards: input.ownCards,
    });

  return sources;
}

/**
 * Every card the dialer can offer, across its sources, without duplicates.
 *
 * A card is de-duplicated by the pair (account, id), not the id alone: ids are
 * unique only inside an account, so a Global or group card and a personal one
 * that happen to share an id are two different people.
 */
export function allDialerCards(sources: DialerSource[]): ContactCard[] {
  const seen = new Set<string>();
  const cards: ContactCard[] = [];
  for (const source of sources)
    for (const card of source.cards) {
      const key = `${source.accountId}:${card.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push(card);
    }
  return cards;
}
