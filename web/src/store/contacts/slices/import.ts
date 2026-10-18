import { batchedSet, chunk, client, setErrorMessage } from "@/jmap/client";
import type { ContactCard, GetResponse, Id, QueryResponse, SetError } from "@/jmap/types";
import { contactDisplayName } from "@/lib/contacts";
import { parseLdif, uidFromDn } from "@/lib/ldif";
import { cardFromLdif } from "@/lib/mozillaAb";
import { accountOfBook } from "../shared";
import type { ContactsGet, ContactsSet, ContactsState } from "../types";

/**
 * Create cards in batches the server will take.
 *
 * `ContactCard/set` is refused whole over `maxObjectsInSet` -- the server does
 * not take the first 500 and drop the rest, it creates nothing and answers
 * `requestTooLarge` -- so an address book big enough to cross the ceiling
 * imports nothing at all. The same failure the calendar import meets, found on a
 * real 800 KB export (upstream issue #173).
 *
 * `maxObjectsInSet` is what the session advertises and 500 where a server does
 * not say; splitting by it rather than by a constant follows a deployment that
 * has tuned the limit.
 *
 * Both imports come through here, which is what makes the LDIF import the same
 * as the vCard import from `ContactCard/set` down.
 */

/**
 * The UIDs an address book already holds.
 *
 * Read once per import rather than once per card, and narrowed to the target
 * book from `addressBookIds` here rather than through a filter. It asks for the
 * total as well, because the loop stops when the position reaches it, and it
 * reads each page back by its ids rather than naming the query's answer by
 * reference: this is a query and the gets it needs, not the one page
 * `queryThenGet` builds.
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
  /* Creates and updates share one budget: `batchedSet` is where that loop
   * lives, and the sentence a half-finished import throws comes with it. */
  const { created, updated, refused } = await batchedSet<ContactCard>({
    method: "ContactCard",
    accountId,
    create,
    update,
    noun: "contacts",
  });
  return { created, updated, refused };
}

/**
 * vCard and LDIF files filed into a book.
 *
 * A slice of the contacts store: the state is assembled in `../index`, and this
 * function only says what this job does with `get`.
 */
export function importSlice(
  _set: ContactsSet,
  get: ContactsGet,
): Pick<ContactsState, "importVCard" | "importLdif"> {
  return {
    async importVCard(text, addressBookId) {
      const accountId = accountOfBook(
        addressBookId,
        get().books,
        get().accountId,
        get().sharedBooks,
      );
      if (!accountId) throw new Error("That address book is not available");
      const up = await client.upload(
        accountId,
        new Blob([text], { type: "text/vcard" }),
        {
          type: "text/vcard",
        },
      );
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
        else await get().reloadShared();
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
        else await get().reloadShared();
      }
    },
  };
}
