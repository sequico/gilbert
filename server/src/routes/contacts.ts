/**
 * The Global contacts directory (ADR 0019): written as an administrator, read
 * by every session.
 *
 * One directory, owned by the Master and reached through the same door a
 * group's identity is written through, so no caller holds it and both the
 * write here and the read are made as the Master. The refusal helper is the
 * identity routes' own, imported from them.
 */

import type { Hono } from "hono";
import {
  destroyGlobalContact,
  isEmptyGlobalContact,
  readGlobalContacts,
  writeGlobalContact,
} from "../globalContactsAdmin.js";
import {
  agentSession,
  IdentityAdminError,
  ownIdentityAccount,
} from "../identityAdmin.js";
import type { GlobalContactInput } from "../shared/globalContacts.js";
import { identityFailure } from "./identities.js";
import type { Env } from "./shared.js";
import { readJson, requireAdmin, requireSession } from "./shared.js";

export function registerContactRoutes(api: Hono<Env>): void {
  /**
   * The Global contacts directory (ADR 0019), written and read as the Master.
   *
   * The directory is the installation's, owned by the Master and reached by
   * every account through the read route below, so the caller's own session
   * holds nothing of it and both the write here and that read are made as the
   * Master — the installation's agent credential, or impersonating the Master —
   * the same door a group's identity is used through. `id: null` creates; the
   * server builds the card from the editor's small shape, so a client cannot
   * write a key the directory does not mean to carry.
   */
  const globalContactInput = (raw: unknown): GlobalContactInput => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const list = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    return {
      name: typeof r.name === "string" ? r.name : "",
      emails: list(r.emails),
      phones: list(r.phones),
      organization: typeof r.organization === "string" ? r.organization : "",
      notes: typeof r.notes === "string" ? r.notes : "",
    };
  };

  api.post("/admin/global-contacts", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ id?: unknown; card?: unknown }>(c);
    try {
      const card = globalContactInput(body?.card);
      if (isEmptyGlobalContact(card))
        throw new IdentityAdminError(
          "invalid_identity",
          "A Global contacts card needs a name or a way to reach the person.",
          400,
        );
      const id = await writeGlobalContact(
        c.get("session"),
        typeof body?.id === "string" && body.id ? body.id : null,
        card,
      );
      return c.json({ ok: true, id });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  api.post("/admin/global-contacts/delete", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ id?: unknown }>(c);
    try {
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      if (!id)
        throw new IdentityAdminError(
          "invalid_identity",
          "Which Global contacts card should be deleted?",
          400,
        );
      await destroyGlobalContact(c.get("session"), id);
      return c.json({ ok: true });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * Global contacts (ADR 0019), read by every session.
   *
   * The directory is the Master's, so the reader's own session holds nothing of
   * it; the route reads it as the Master and answers any authenticated session,
   * the same door the administrator writes through. A deployment with no usable
   * agent has no directory to read and answers none rather than a refusal the
   * reader cannot act on.
   */
  api.get("/global-contacts", requireSession, async (c) => {
    try {
      const ctx = await agentSession(c.get("session"));
      const accountId = ownIdentityAccount(ctx);
      if (!accountId) return c.json({ ok: true, contacts: [] });
      return c.json({ ok: true, contacts: await readGlobalContacts(ctx, accountId) });
    } catch (err) {
      // A deployment with no agent has no directory to read: that is an answer
      // of none, not a refusal the reader cannot act on. Every other failure is
      // surfaced — an unreadable directory is not an empty one.
      if (err instanceof IdentityAdminError && err.code === "agent_not_configured")
        return c.json({ ok: true, contacts: [] });
      return identityFailure(c, err);
    }
  });
}
