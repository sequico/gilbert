/**
 * The installation's Global contacts directory, client half (ADR 0023).
 *
 * The directory is owned by the Master, so no session reaches it: it is read
 * through the route that answers every account, and written only by an
 * administrator through the route that acts as the Master. `id: null` creates.
 */
import type {
  GlobalContactInput,
  GlobalContactView,
} from "@gilbert/shared/globalContacts";
import { apiFetch } from "@/jmap/client";

/**
 * The synthetic account id the directory is held under in the store.
 *
 * The directory is served through a route rather than held in any session
 * account, so the client installs it — and its cards — under this one sentinel.
 * Every shared-book surface keys it by this, `accountOfCard` answers it for a
 * directory card, and no JMAP write path may ever take it for a real account:
 * the generic contact editor refuses it and the administration's own route is
 * the only door (ADR 0023).
 */
export const GLOBAL_CONTACTS_ACCOUNT_ID = "global";

/** The id of the directory's one address book, as the store draws it. */
export const GLOBAL_CONTACTS_BOOK_ID = "global-contacts";

/**
 * The installation's directory, read through the route that acts as the Master
 * (ADR 0023).
 *
 * A member's session cannot reach the directory's book, so it is fetched here
 * rather than discovered as a shared book. A failed fetch is the caller's to
 * handle; the cards are the administrator's small shape, widened to JSContact
 * cards where the store installs them.
 */
export async function fetchGlobalContacts(): Promise<GlobalContactView[]> {
  const res = await apiFetch<{ ok: true; contacts: GlobalContactView[] }>(
    "/api/global-contacts",
  );
  return res.contacts ?? [];
}

/** Create or update one card, answering its id. */
export async function saveGlobalContact(
  id: string | null,
  card: GlobalContactInput,
): Promise<string> {
  const res = await apiFetch<{ ok: true; id: string }>("/api/admin/global-contacts", {
    method: "POST",
    body: JSON.stringify({ id, card }),
  });
  return res.id;
}

/** Remove one card from the directory. */
export async function deleteGlobalContact(id: string): Promise<void> {
  await apiFetch<{ ok: true }>("/api/admin/global-contacts/delete", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}
