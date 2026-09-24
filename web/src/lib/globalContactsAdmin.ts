/**
 * Writing the installation's Global contacts directory (ADR 0023).
 *
 * Only an administrator writes it, and the write is made by the server as the
 * Master — the share grants the administrator's own session nothing to write
 * with — so these are routes rather than JMAP calls. `id: null` creates.
 */
import type { GlobalContactInput } from "@gilbert/shared/phone";
import { apiFetch } from "@/jmap/client";

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
