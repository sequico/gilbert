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
import {
  contactDisplayName,
  contactFieldLabel,
  isGlobalContactsBook,
} from "@/lib/contacts";
import type { SharedBook } from "@/store/contacts";

/** Every number a card carries, the preferred one first, each with its label. */
export function contactNumbers(
  card: ContactCard,
): Array<{ number: string; label: string }> {
  return Object.values(card.phones ?? {})
    .filter((phone) => Boolean(phone.number?.trim()))
    .slice()
    .sort((a, b) => (a.pref ?? 1) - (b.pref ?? 1))
    .map((phone) => ({
      number: phone.number.trim(),
      label: contactFieldLabel(phone.label, phone.contexts, phone.features),
    }));
}

/** Every number a card carries, the preferred one first. */
export function contactPhoneNumbers(card: ContactCard): string[] {
  return contactNumbers(card).map((entry) => entry.number);
}

/** The number the phone dials for a contact, or null when it carries none. */
export function dialTarget(card: ContactCard): string | null {
  return contactPhoneNumbers(card)[0] ?? null;
}

/**
 * The contact a call's remote matches, with the number's own label, or null.
 *
 * The one rule that turns a number back into a person, so the call log and any
 * other surface resolve a number the same way: match on digits, because the SIP
 * leg spells a number differently from the card that holds it.
 */
export function contactMatchFor(
  cards: ContactCard[],
  remote: string,
): { name: string; label: string } | null {
  const digits = remote.replace(/\D/g, "");
  if (!digits) return null;
  for (const card of cards)
    for (const entry of contactNumbers(card))
      if (entry.number.replace(/\D/g, "") === digits)
        return { name: contactDisplayName(card), label: entry.label };
  return null;
}

export interface DialerSource {
  /** Stable key for React and for the selection. */
  id: string;
  /** What the source is called on screen. */
  label: string;
  /** Which kind of source this is, so a surface can filter by it. */
  kind: "global" | "group" | "personal";
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
      kind: "global",
      accountId: book.accountId,
      cards: cardsInBook(input.cardsIn(book.accountId), book.book.id),
    });

  for (const group of input.groups) {
    const cards = input.cardsIn(group.accountId);
    if (cards.length)
      sources.push({
        id: `group:${group.accountId}`,
        label: group.name,
        kind: "group",
        accountId: group.accountId,
        cards,
      });
  }

  if (input.ownCards.length)
    sources.push({
      id: "personal",
      label: input.personalLabel,
      kind: "personal",
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
