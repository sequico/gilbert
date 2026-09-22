/**
 * Where an opened contact lives: its id, and the account holding it.
 *
 * Stalwart's object ids are the account's own, so the reader's own card and a
 * group's can carry the same id -- the reason the store keys every shared book
 * and card by `sharedKey(accountId, id)` rather than by id alone. The reader's
 * own map is keyed by id, so resolving a bare id answers with the reader's own
 * card and shadows the other account's: in a list that holds both, the same id
 * is two rows, clicking the second one navigates to the address already on
 * screen, and the detail keeps showing the card the reader was not looking at.
 *
 * An opened card is therefore addressed by **account and id**, carried in the
 * URL's own vocabulary: `?account=<id>` when it is another account's card, and
 * no qualifier for the reader's own, which is what every link written before
 * this means and keeps meaning.
 */
import type { ContactCard, Id } from "@/jmap/types";
import { accountOfSharedKey, sharedKey } from "@/lib/sharedKey";

/** The id a card is opened by, and the account holding it (null = the reader's own). */
export interface CardAddress {
  id: Id;
  accountId: Id | null;
}

/** The route a card is opened at. The reader's own card needs no qualifier. */
export function cardPath(address: CardAddress): string {
  return address.accountId
    ? `/contacts/${address.id}?account=${encodeURIComponent(address.accountId)}`
    : `/contacts/${address.id}`;
}

/**
 * The key an address is held under in a set -- one ticked row, one export row.
 *
 * The reader's own account is the empty prefix, which no account id is: two rows
 * carrying one id are two keys, so a tick says which of them the reader ticked.
 */
export function cardKey(address: CardAddress): string {
  return sharedKey(address.accountId ?? "", address.id);
}

/**
 * The address a route names.
 *
 * `ownAccountId` is what the session calls the reader's own account: a route
 * that names it is the reader's own card, the same as one that names no account
 * at all, so the two spellings cannot answer differently.
 */
export function cardAddressFrom(
  id: Id | undefined,
  search: string,
  ownAccountId: Id | null,
): CardAddress | null {
  if (!id) return null;
  const named = new URLSearchParams(search).get("account");
  if (!named || named === ownAccountId) return { id, accountId: null };
  return { id, accountId: named };
}

/**
 * The card an address names, and the account it was found in.
 *
 * The two maps the store holds, asked in the order the address says: the named
 * account's when it names one, and the reader's own otherwise. An address that
 * names no account and finds nothing of the reader's own is a link that arrived
 * by id alone -- a search result, a group card's member list, a bookmark -- so
 * it falls back to the account holding a card by that id, which is what such a
 * link has always meant.
 */
export function cardAt(
  cards: Record<Id, ContactCard>,
  sharedCards: Record<string, ContactCard>,
  address: CardAddress | null,
): { card: ContactCard; accountId: Id | null } | undefined {
  if (!address) return undefined;
  const { id, accountId } = address;
  if (accountId) {
    const held = sharedCards[sharedKey(accountId, id)];
    if (held) return { card: held, accountId };
  }
  if (cards[id]) return { card: cards[id], accountId: null };
  const hit = Object.entries(sharedCards).find(([key]) => key.endsWith(`:${id}`));
  return hit ? { card: hit[1], accountId: accountOfSharedKey(hit[0], id) } : undefined;
}
