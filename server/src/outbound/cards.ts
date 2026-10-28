/**
 * The group's cards, by the number each one carries (ADR 0040).
 *
 * A paste asks one question per line — is this number already somebody the group
 * knows — and asking the mail server that question per card is neither cheap nor
 * possible: `ContactCard/query` cannot filter by phone. So the answer is one index
 * in the group's own app folder, keyed by the canonical number.
 *
 * The index is a cache and never a second truth: it records the card store's own
 * state at the moment it was built, and a state that has moved makes it stale, so
 * the next read rebuilds it from the cards. A card whose phone cannot be read as a
 * number is simply not in it — the index is for matching, not for repairing a
 * contact's data.
 */

import type { Ctx } from "../appFolder.js";
import { JMAP_CONTACTS, JmapClient } from "../jmap.js";
import type { CardIndexDoc } from "../shared/outbound.js";
import { readCardIndexDoc, writeCardIndex } from "./documents.js";
import { OutboundError } from "./errors.js";
import { normaliseNumber } from "./phone.js";

/** A card as this module needs it: its id, and the phones it carries. */
interface CardShape {
  id?: unknown;
  phones?: Record<string, { number?: unknown }>;
}

/** The account's card state, the stamp the index is rebuilt against. */
async function cardState(client: JmapClient, accountId: string): Promise<string> {
  const res = await client.call<{ state?: unknown }>(
    "ContactCard/get",
    { accountId, ids: [] },
    [JMAP_CONTACTS],
  );
  return typeof res.state === "string" ? res.state : "";
}

/** Every number the group's cards carry, canonical, with the card that carries it. */
async function buildIndex(
  client: JmapClient,
  accountId: string,
  state: string,
  now: Date,
): Promise<CardIndexDoc> {
  const res = await client.call<{ list?: CardShape[] }>(
    "ContactCard/get",
    { accountId, ids: null, properties: ["id", "phones"] },
    [JMAP_CONTACTS],
  );
  const cards: Record<string, string> = {};
  for (const card of res.list ?? []) {
    if (typeof card.id !== "string") continue;
    for (const phone of Object.values(card.phones ?? {})) {
      if (typeof phone.number !== "string") continue;
      const number = normaliseNumber(phone.number);
      // The first card to carry a number keeps it: two cards sharing a switchboard
      // are one number, and the row points at one of them rather than at neither.
      if (number.ok && !(number.e164 in cards)) cards[number.e164] = card.id;
    }
  }
  return { version: 1, cardState: state, cards, builtAt: now.toISOString() };
}

/**
 * The name of the book a card created by a call is put in.
 *
 * The group's own address book is the one a member already reads and writes; a
 * group with none gets this one, named the way a person would name it, rather than
 * a book per caller or a book the product hides.
 */
const OUTBOUND_BOOK_NAME = "Contacts";

/** The group's address book, created when the group has none at all. */
async function bookId(client: JmapClient, accountId: string): Promise<string> {
  const read = await client.call<{ list?: Array<{ id?: unknown }> }>(
    "AddressBook/get",
    { accountId, ids: null, properties: ["id", "name"] },
    [JMAP_CONTACTS],
  );
  const found = (read.list ?? []).find((book) => typeof book.id === "string");
  if (found) return found.id as string;

  const set = await client.call<{ created?: Record<string, { id?: unknown }> }>(
    "AddressBook/set",
    { accountId, create: { b: { name: OUTBOUND_BOOK_NAME } } },
    [JMAP_CONTACTS],
  );
  const created = set.created?.b?.id;
  if (typeof created !== "string") {
    throw new OutboundError(
      "card_book_unavailable",
      "The group has no address book and one could not be created, so the card this call needs was not written.",
      502,
    );
  }
  return created;
}

/**
 * The card a first call creates, carrying the number that was dialled.
 *
 * Created at the call and never by an import (ADR 0040): a list of three hundred
 * numbers must not become three hundred entries in the group's address book, and a
 * list nobody dialled must leave nothing behind. The words around the number in
 * the paste become the card's first note, because they are what the caller knew
 * before the conversation started.
 */
export async function createCardFor(
  ctx: Ctx,
  accountId: string,
  { number, note }: { number: string; note: string | null },
): Promise<string> {
  const client = new JmapClient(ctx);
  const book = await bookId(client, accountId);
  const card = {
    "@type": "Card",
    version: "1.0",
    addressBookIds: { [book]: true },
    phones: { p1: { "@type": "Phone", number } },
    ...(note ? { notes: { n1: { "@type": "Note", note } } } : {}),
  };
  const set = await client.call<{ created?: Record<string, { id?: unknown }> }>(
    "ContactCard/set",
    { accountId, create: { c: card } },
    [JMAP_CONTACTS],
  );
  const created = set.created?.c?.id;
  if (typeof created !== "string") {
    throw new OutboundError(
      "card_not_created",
      "The call was recorded, but the card it should belong to could not be written.",
      502,
    );
  }
  return created;
}

/**
 * The group's card index, rebuilt when the cards have moved since it was built.
 *
 * The rebuild is a write, so it is written under the same conditional write as
 * every other document here: two imports arriving together build it once each and
 * one of them wins, which is the same answer either way.
 */
export async function readCardIndex(
  ctx: Ctx,
  accountId: string,
): Promise<Record<string, string>> {
  const client = new JmapClient(ctx);
  const state = await cardState(client, accountId);
  const held = await readCardIndexDoc(ctx, accountId);
  if (held && held.cardState === state) return held.cards;

  const index = await buildIndex(client, accountId, state, new Date());
  await writeCardIndex(ctx, accountId, index);
  return index.cards;
}
