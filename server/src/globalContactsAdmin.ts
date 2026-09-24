import { randomUUID } from "node:crypto";
import type { Ctx } from "./appFolder.js";
import {
  agentSession,
  IdentityAdminError,
  ownIdentityAccount,
  refusalOf,
} from "./identityAdmin.js";
import { JMAP_CONTACTS, JMAP_PRINCIPALS, JmapClient } from "./jmap.js";
import type { LiveSession } from "./sessions.js";
import { GLOBAL_CONTACTS_BOOK_NAME, type GlobalContactInput } from "./shared/phone.js";

/**
 * The Global contacts directory, written as the Master (ADR 0023).
 *
 * The directory is the installation's, owned by the Master, shared read-only
 * with every account; only an administrator writes it, and this is the door
 * they write through. The write is made as the Master — the installation's
 * agent credential, or impersonation from the administrator's session — which
 * is the same door a group's identity is written through, and it is a server
 * route rather than a client JMAP call because a read-only share grants the
 * administrator's own session nothing to write with.
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
 * the decision (`gilbert-phone`). A create the server refused is not a failure
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

/**
 * Share the directory read-only with every principal the Master can name.
 *
 * The decision is one rule that reaches every account, including one created
 * later; whether Stalwart has such a wildcard share is what the ADR leaves owed
 * a live probe, so this is the best-known shape: every principal read through
 * the standard door, merged into the book's existing share so a principal
 * beyond the enumeration's page keeps its grant. It runs on every write, which
 * is what brings an account created since the last one in. An enumeration that
 * names nobody, and a share the server refuses, both fail loudly: a directory
 * nobody can read is not a directory.
 */
async function shareWithEveryone(
  ctx: Ctx,
  accountId: string,
  bookId: string,
): Promise<void> {
  const client = new JmapClient(ctx);
  const principals = await client.call<{ list?: Array<{ id?: unknown }> }>(
    "Principal/query",
    { accountId, limit: 1000 },
    [JMAP_PRINCIPALS],
  );
  const wanted: Record<string, { mayRead: boolean }> = {};
  for (const principal of principals.list ?? [])
    if (typeof principal.id === "string" && principal.id !== accountId)
      wanted[principal.id] = { mayRead: true };
  if (!Object.keys(wanted).length)
    throw new IdentityAdminError(
      "global_contacts_share",
      "No principal could be enumerated, so the directory could not be shared with anyone.",
      502,
    );

  const current = await client.call<{
    list?: Array<{ shareWith?: unknown }>;
  }>("AddressBook/get", { accountId, ids: [bookId], properties: ["id", "shareWith"] }, [
    JMAP_CONTACTS,
  ]);
  const existing = (current.list?.[0]?.shareWith ?? {}) as Record<string, unknown>;
  const shareWith = { ...existing, ...wanted };
  const res = await client.call<{ notUpdated?: Record<string, unknown> }>(
    "AddressBook/set",
    { accountId, update: { [bookId]: { shareWith } } },
    [JMAP_CONTACTS, JMAP_PRINCIPALS],
  );
  const refused = res.notUpdated?.[bookId];
  if (refused)
    throw new IdentityAdminError(
      "global_contacts_share",
      refusalOf(refused as { type?: unknown; description?: unknown }) ||
        "The directory could not be shared.",
      502,
    );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter(Boolean);
}

/**
 * The card fields the server writes, from the editor's small shape.
 *
 * An empty list clears the property (`null`, which JMAP removes) rather than
 * leaving what was there: the administrator typed what the card should hold,
 * and a stale address sitting beside the edited ones is the silent surprise.
 */
function cardFields(input: GlobalContactInput): Record<string, unknown> {
  const emails = strings(input.emails);
  const phones = strings(input.phones);
  const organization = text(input.organization);
  const notes = text(input.notes);
  const objects = (values: string[], key: (v: string) => Record<string, unknown>) =>
    values.length ? Object.fromEntries(values.map((v, i) => [`k${i}`, key(v)])) : null;
  return {
    name: { full: text(input.name) },
    emails: objects(emails, (address) => ({ address })),
    phones: objects(phones, (number) => ({ number })),
    organizations: organization ? { o0: { name: organization } } : null,
    notes: notes ? { n0: { note: notes } } : null,
  };
}

/** Create or update one card in the directory, answering its id. */
export async function writeGlobalContact(
  admin: LiveSession,
  id: string | null,
  input: GlobalContactInput,
): Promise<string> {
  const { ctx, accountId } = await masterAccount(admin);
  const bookId = await globalContactsBookId(ctx, accountId);
  // Every write re-applies the universal share, so an account created since
  // the last one is brought in.
  await shareWithEveryone(ctx, accountId, bookId);
  const client = new JmapClient(ctx);
  const fields = cardFields(input);
  try {
    if (id) {
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
 * directory's.
 */
export async function destroyGlobalContact(
  admin: LiveSession,
  id: string,
): Promise<void> {
  const { ctx, accountId } = await masterAccount(admin);
  const bookId = await globalContactsBookId(ctx, accountId);
  const client = new JmapClient(ctx);
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
