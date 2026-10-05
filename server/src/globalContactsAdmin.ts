import { randomUUID } from "node:crypto";
import type { Ctx } from "./appFolder.js";
import {
  agentSession,
  IdentityAdminError,
  ownIdentityAccount,
  refusalOf,
} from "./identityAdmin.js";
import { JMAP_CONTACTS, JmapClient } from "./jmap.js";
import type { LiveSession } from "./sessions.js";
import {
  GLOBAL_CONTACTS_BOOK_NAME,
  type GlobalContactInput,
  type GlobalContactView,
} from "./shared/globalContacts.js";

/**
 * The Global contacts directory, written and read as the Master (ADR 0023).
 *
 * The directory is the installation's, owned by the Master and read by every
 * account through a server route; only an administrator writes it, and both go
 * through this door, which acts as the Master — the installation's agent
 * credential, or impersonation from the administrator's session. A client JMAP
 * call cannot be the door because a reader is not a member of the Master's
 * account, and a `shareWith` cannot name every account: Stalwart caps a share
 * at 10 principals per item (ADR 0023, live-probed 2026-10-02).
 */

/** The Master's session and its own account, or a refusal. */
async function masterAccount(
  admin: LiveSession,
): Promise<{ ctx: Ctx; accountId: string }> {
  const ctx = await agentSession(admin);
  const accountId = ownIdentityAccount(ctx);
  if (!accountId)
    throw new IdentityAdminError(
      "no_identity_account",
      "The installation's own account could not be read, so Global contacts cannot be written.",
      409,
    );
  return { ctx, accountId };
}

/** The refusal, in the identity door's own shape, so the route maps it. */
function bookRefusal(err: unknown, what: string): IdentityAdminError {
  if (err instanceof IdentityAdminError) return err;
  return new IdentityAdminError(
    "global_contacts_book",
    `${what}: ${err instanceof Error ? err.message : String(err)}`,
    502,
  );
}

/**
 * The directory book's id, or null — and a read that fails is not "no book".
 *
 * A transient failure answered as an empty list would have the caller create a
 * second "Global contacts"; the failure is raised instead, so the write stops
 * rather than duplicating the directory.
 */
async function findGlobalContactsBook(
  client: JmapClient,
  accountId: string,
): Promise<string | null> {
  try {
    const res = await client.call<{
      list?: Array<{ id?: unknown; name?: unknown }>;
    }>("AddressBook/get", { accountId, ids: null, properties: ["id", "name"] }, [
      JMAP_CONTACTS,
    ]);
    const found = (res.list ?? []).find(
      (book) => book.name === GLOBAL_CONTACTS_BOOK_NAME && typeof book.id === "string",
    );
    return found ? (found.id as string) : null;
  } catch (err) {
    throw bookRefusal(err, "The directory's address book could not be read");
  }
}

/**
 * The Global contacts book's id, creating the book on first use.
 *
 * Found by name — the one the shared constant declares — because that name is
 * the decision (`gilbert-global-contacts`). A create the server refused is not a failure
 * until the book is looked for again: a sibling already carrying the name is
 * the directory, and adopting it is what keeps it one book.
 */
export async function globalContactsBookId(ctx: Ctx, accountId: string): Promise<string> {
  const client = new JmapClient(ctx);
  const found = await findGlobalContactsBook(client, accountId);
  if (found) return found;
  const set = await client.call<{ created?: Record<string, { id?: unknown }> }>(
    "AddressBook/set",
    { accountId, create: { b: { name: GLOBAL_CONTACTS_BOOK_NAME } } },
    [JMAP_CONTACTS],
  );
  const id = set.created?.b?.id;
  if (typeof id === "string") return id;
  const after = await findGlobalContactsBook(client, accountId);
  if (after) return after;
  throw new IdentityAdminError(
    "global_contacts_book",
    "The directory's address book could not be created.",
    502,
  );
}

/** The directory book's id, or a 404 — for a caller that must not create it. */
async function requiredGlobalContactsBook(
  client: JmapClient,
  accountId: string,
): Promise<string> {
  const found = await findGlobalContactsBook(client, accountId);
  if (!found)
    throw new IdentityAdminError(
      "global_contacts_book",
      "The Global contacts directory has no address book yet.",
      404,
    );
  return found;
}

/**
 * Make the directory exist, as the Master.
 *
 * Run at boot so the directory is there for every reader without anyone
 * creating it: a thing the product needs is made to happen, not asked for with
 * a button. Idempotent — an existing book is found and left in place — and safe
 * to run on every boot, because the alternative is a feature that is absent
 * until an administrator happens to do the right thing.
 */
export async function ensureGlobalContacts(ctx: Ctx, accountId: string): Promise<void> {
  await globalContactsBookId(ctx, accountId);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter(Boolean);
}

/**
 * Read the directory's cards, as the route serves them to any session.
 *
 * The Master's account holds the directory, so its cards are the directory's:
 * each is answered as the small shape both tiers read (`GlobalContactView`) —
 * the one name, the addresses, the numbers, the organisation and the note,
 * flattened so a reader draws the directory without parsing the JSContact card
 * vocabulary. An account with no cards answers none; nothing is created here.
 */
export async function readGlobalContacts(
  ctx: Ctx,
  accountId: string,
): Promise<GlobalContactView[]> {
  const client = new JmapClient(ctx);
  // The directory is its own book: the account may hold other books (the agent
  // writes here too), and their cards are not the directory.
  const bookId = await findGlobalContactsBook(client, accountId);
  if (!bookId) return [];
  const res = await client.call<{
    list?: Array<{
      id?: unknown;
      addressBookIds?: Record<string, unknown>;
      name?: { full?: unknown };
      emails?: Record<string, { address?: unknown }>;
      phones?: Record<string, { number?: unknown }>;
      organizations?: Record<string, { name?: unknown }>;
      notes?: Record<string, { note?: unknown }>;
    }>;
  }>(
    "ContactCard/get",
    {
      accountId,
      ids: null,
      properties: [
        "id",
        "addressBookIds",
        "name",
        "emails",
        "phones",
        "organizations",
        "notes",
      ],
    },
    [JMAP_CONTACTS],
  );
  const out: GlobalContactView[] = [];
  for (const card of res.list ?? []) {
    if (!card.addressBookIds?.[bookId]) continue;
    const id = typeof card.id === "string" ? card.id : "";
    if (!id) continue;
    out.push({
      id,
      name: text(card.name?.full),
      emails: strings(Object.values(card.emails ?? {}).map((email) => email.address)),
      phones: strings(Object.values(card.phones ?? {}).map((phone) => phone.number)),
      organization: text(Object.values(card.organizations ?? {})[0]?.name),
      notes: text(Object.values(card.notes ?? {})[0]?.note),
    });
  }
  return out;
}

/**
 * The card fields the server writes, from the editor's small shape.
 *
 * On create, an empty property is **omitted**: `null` is the `/set` idiom for
 * removing a value, and whether a server accepts it on a create is not pinned,
 * so a new card carries only what it has. On update it is sent as `null`, which
 * is what clears a property the administrator deleted — a stale address beside
 * the edited ones is the silent surprise.
 */
function cardFields(
  input: GlobalContactInput,
  opts: { clear: boolean },
): Record<string, unknown> {
  const emails = strings(input.emails);
  const phones = strings(input.phones);
  const organization = text(input.organization);
  const notes = text(input.notes);
  const objects = (values: string[], key: (v: string) => Record<string, unknown>) =>
    values.length
      ? Object.fromEntries(values.map((v, i) => [`k${i}`, key(v)]))
      : opts.clear
        ? null
        : undefined;
  const fields: Record<string, unknown> = { name: { full: text(input.name) } };
  for (const [name, value] of Object.entries({
    emails: objects(emails, (address) => ({ address })),
    phones: objects(phones, (number) => ({ number })),
    organizations: organization
      ? { o0: { name: organization } }
      : opts.clear
        ? null
        : undefined,
    notes: notes ? { n0: { note: notes } } : opts.clear ? null : undefined,
  }))
    if (value !== undefined) fields[name] = value;
  return fields;
}

/** Whether a card the administrator typed says anything at all. */
export function isEmptyGlobalContact(input: GlobalContactInput): boolean {
  return (
    !input.name.trim() &&
    !input.emails.some((e) => e.trim()) &&
    !input.phones.some((p) => p.trim()) &&
    !input.organization.trim() &&
    !input.notes.trim()
  );
}

/** Create or update one card in the directory, answering its id. */
export async function writeGlobalContact(
  admin: LiveSession,
  id: string | null,
  input: GlobalContactInput,
): Promise<string> {
  const { ctx, accountId } = await masterAccount(admin);
  const client = new JmapClient(ctx);
  const fields = cardFields(input, { clear: id !== null });
  try {
    if (id) {
      // The id must name a card the directory holds. The route is the
      // enforcement door: updating any id it is handed would adopt a card from
      // somewhere else into the directory. The book is looked up, never
      // created — an update for a directory that does not exist is a 404.
      const bookId = await requiredGlobalContactsBook(client, accountId);
      const got = await client.call<{
        list?: Array<{ addressBookIds?: Record<string, unknown> }>;
      }>(
        "ContactCard/get",
        { accountId, ids: [id], properties: ["id", "addressBookIds"] },
        [JMAP_CONTACTS],
      );
      if (!got.list?.[0]?.addressBookIds?.[bookId])
        throw new IdentityAdminError(
          "global_contact",
          "That card is not in the Global contacts directory.",
          404,
        );
      const res = await client.call<{ notUpdated?: Record<string, unknown> }>(
        "ContactCard/set",
        {
          accountId,
          update: { [id]: { ...fields, addressBookIds: { [bookId]: true } } },
        },
        [JMAP_CONTACTS],
      );
      const refused = res.notUpdated?.[id];
      if (refused)
        throw new IdentityAdminError(
          "global_contact",
          refusalOf(refused as { type?: unknown; description?: unknown }),
          400,
        );
      return id;
    }
    const bookId = await globalContactsBookId(ctx, accountId);
    const res = await client.call<{
      created?: Record<string, { id?: unknown }>;
      notCreated?: Record<string, unknown>;
    }>(
      "ContactCard/set",
      {
        accountId,
        create: {
          c: {
            "@type": "Card",
            version: "1.0",
            uid: randomUUID(),
            kind: "individual",
            addressBookIds: { [bookId]: true },
            ...fields,
          },
        },
      },
      [JMAP_CONTACTS],
    );
    const refused = res.notCreated?.c;
    if (refused)
      throw new IdentityAdminError(
        "global_contact",
        refusalOf(refused as { type?: unknown; description?: unknown }),
        400,
      );
    const created = res.created?.c?.id;
    if (typeof created !== "string")
      throw new IdentityAdminError(
        "global_contact",
        "The mail server accepted the contact but returned no id.",
        502,
      );
    return created;
  } catch (err) {
    if (err instanceof IdentityAdminError) throw err;
    throw new IdentityAdminError(
      "global_contact",
      err instanceof Error ? err.message : String(err),
      502,
    );
  }
}

/**
 * Remove one card from the directory.
 *
 * The id is checked against the directory book first: the Master's account is
 * read and written by this client alone today, and a route that destroys any id
 * it is handed is one typo away from deleting something that was not the
 * directory's. The book is looked up, never created: a delete for a directory
 * that does not exist is a 404, not a reason to make one.
 */
export async function destroyGlobalContact(
  admin: LiveSession,
  id: string,
): Promise<void> {
  const { ctx, accountId } = await masterAccount(admin);
  const client = new JmapClient(ctx);
  const bookId = await requiredGlobalContactsBook(client, accountId);
  const got = await client.call<{
    list?: Array<{ addressBookIds?: Record<string, unknown> }>;
  }>("ContactCard/get", { accountId, ids: [id], properties: ["id", "addressBookIds"] }, [
    JMAP_CONTACTS,
  ]);
  if (!got.list?.[0]?.addressBookIds?.[bookId])
    throw new IdentityAdminError(
      "global_contact",
      "That card is not in the Global contacts directory.",
      404,
    );
  const res = await client.call<{ notDestroyed?: Record<string, unknown> }>(
    "ContactCard/set",
    { accountId, destroy: [id] },
    [JMAP_CONTACTS],
  );
  const refused = res.notDestroyed?.[id];
  if (refused)
    throw new IdentityAdminError(
      "global_contact",
      refusalOf(refused as { type?: unknown; description?: unknown }),
      400,
    );
}
