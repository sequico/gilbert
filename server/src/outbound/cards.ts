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
