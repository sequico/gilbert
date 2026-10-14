/**
 * The identities an administrator sets, and the assignment a member reads
 * (ADR 0007).
 *
 * A person's identities, a group's identities and roster, the signature HTML
 * kept in the account's own Files, and the identity the signed-in member sends
 * as in one group. The refusal helper is exported because the Global contacts
 * routes answer with it too.
 */

import type { Context, Hono } from "hono";
import {
  groupIdentity,
  IdentityAdminError,
  identityAddress,
  memberGroupAssignment,
  personIdentities,
  removeGroupIdentity,
  removePersonIdentity,
  setPersonDefaultIdentity,
  setUserIdentityLock,
  storeSignatureHtml,
  writeGroupIdentity,
  writePersonIdentity,
} from "../identityAdmin.js";
import { normalizeUsername } from "../sessions.js";
import type { Env } from "./shared.js";
import {
  identityLockCache,
  readJson,
  requireAdmin,
  requireSession,
  upstreamFailure,
} from "./shared.js";

/** A refusal from these surfaces: the code and the sentence, or upstream's. */
export function identityFailure(c: Context, err: unknown) {
  if (err instanceof IdentityAdminError)
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  return upstreamFailure(c, err);
}

export function registerIdentityRoutes(api: Hono<Env>): void {
  // ---------- Identities an administrator sets (ADR 0007) ----------

  /**
   * A person's identities, and the one write that reaches them.
   *
   * The write is an impersonation of that person from the administrator's own
   * session: no new credential, and Stalwart's permission model stays the whole
   * of the gate. `impersonation: "denied"` is an answer, not a failure — an
   * app-password session cannot impersonate at all, and the surface says so
   * instead of showing an account with no identities.
   */
  api.get("/admin/identities/user", requireSession, requireAdmin, async (c) => {
    try {
      return c.json(
        await personIdentities(c.get("session"), c.req.query("address") ?? ""),
      );
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  api.post("/admin/identities/user", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ address?: unknown; id?: unknown; patch?: unknown }>(c);
    try {
      const written = await writePersonIdentity(
        c.get("session"),
        typeof body?.address === "string" ? body.address : "",
        typeof body?.id === "string" && body.id ? body.id : null,
        body?.patch,
      );
      return c.json({ ok: true, id: written.id });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  api.post("/admin/identities/user/delete", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ address?: unknown; id?: unknown }>(c);
    try {
      await removePersonIdentity(
        c.get("session"),
        typeof body?.address === "string" ? body.address : "",
        typeof body?.id === "string" ? body.id : "",
      );
      return c.json({ ok: true });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * The lock an administrator applies to a person's identity (ADR 0007,
   * ADR 0001).
   *
   * Recorded in that account's own app folder, by impersonation — the same
   * door `setPersonDefaultIdentity` writes through. Applying one ends
   * nothing: a lock is a rule about what the product offers, so the session
   * that writes one sees it at once (ADR 0007, the cache below is cleared
   * for exactly that) and a session already open sees it the next time it
   * reads its own.
   */
  api.post("/admin/identities/user/lock", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ address?: unknown; locked?: unknown }>(c);
    try {
      const address = identityAddress(
        typeof body?.address === "string" ? body.address : "",
      );
      const locked = body?.locked === true;
      await setUserIdentityLock(c.get("session"), address, locked);
      identityLockCache.delete(normalizeUsername(address));
      return c.json({ ok: true, locked });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * The identity an account sends from by default (ADR 0007).
   *
   * Not a Stalwart property: it is one key of the client's own settings
   * document, in that account's app folder, so the administrator and the
   * account's own Identities & signatures section read and write one value
   * rather than two that can disagree. `identityId: null` clears it, which is
   * the same state as never having chosen.
   */
  api.post("/admin/identities/user/default", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ address?: unknown; identityId?: unknown }>(c);
    try {
      const identityId =
        typeof body?.identityId === "string" && body.identityId ? body.identityId : null;
      const written = await setPersonDefaultIdentity(
        c.get("session"),
        typeof body?.address === "string" ? body.address : "",
        identityId,
      );
      return c.json({ ok: true, identityId: written });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * A group's identities, its roster, and the assignment that binds a member to
   * one of them (ADR 0007).
   *
   * Written as the installation's agent, always: Stalwart refuses to impersonate
   * a group mailbox, and the agent is the principal that exists for this. Where
   * the agent is not a member of the group, `granted: false` says so and names
   * the grant that is missing rather than a permission error that would read as
   * a bug.
   *
   * A group holds **one identity per member** — the group's own address, each
   * member's own display name and signature — and `assignments` says which
   * member sends as which of them: the binding is a record, not a display name
   * compared on both sides. A member absent from it sends as the group's own
   * identity, `groupSenderId`. `members` is the roster those identities belong
   * to: `null` when the registry could not be read, which is an answer rather
   * than a failure. The POST writes one identity **and assigns it** — `member`
   * names the address, `id` the identity to write, `null` meaning "the one this
   * member already holds, else a new one".
   */

  api.get("/admin/identities/group", requireSession, requireAdmin, async (c) => {
    try {
      return c.json(await groupIdentity(c.get("session"), c.req.query("name") ?? ""));
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  api.post("/admin/identities/group", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{
      name?: unknown;
      member?: unknown;
      id?: unknown;
      patch?: unknown;
    }>(c);
    try {
      const written = await writeGroupIdentity(
        c.get("session"),
        typeof body?.name === "string" ? body.name : "",
        typeof body?.member === "string" ? body.member : "",
        typeof body?.id === "string" && body.id ? body.id : null,
        body?.patch,
      );
      return c.json({ ok: true, id: written.id });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * Remove one of a group's identities, as the agent (ADR 0007).
   *
   * What a member was assigned, deleted: they fall back to the group's own
   * identity, which is what a member with no identity of their own sends as.
   * The group's own identity is refused by name, since everybody falls back to
   * it.
   */
  api.post("/admin/identities/group/delete", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ name?: unknown; id?: unknown }>(c);
    try {
      await removeGroupIdentity(
        c.get("session"),
        typeof body?.name === "string" ? body.name : "",
        typeof body?.id === "string" ? body.id : "",
      );
      return c.json({ ok: true });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * The identity the signed-in member sends as in one group (ADR 0007).
   *
   * The composer's own question, answered as the member rather than as an
   * administrator: `assignedId` is the identity the administration assigned
   * them, an id of the group's account that the caller resolves against the list
   * it already holds. The group's **own** identity — what an unassigned member
   * sends as — is not answered here: it is step 2 of the cascade, a rule the
   * client derives from the address the session calls the account, by the one
   * function both tiers import (`@gilbert/shared/identityAssignment`), so it
   * cannot be spelt differently on either side of the wire.
   *
   * Read through the agent, because it is the group's own document: a member
   * reaches the group's Files through the group surfaces and never by reading
   * another account directly.
   */
  api.get("/identities/assignment", requireSession, async (c) => {
    try {
      const view = await memberGroupAssignment(
        c.get("session"),
        c.req.query("group") ?? "",
      );
      if ("ok" in view) return c.json({ error: view.error, need: view.need }, 403);
      return c.json(view);
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * The full HTML of an over-sized signature, kept in the account's own Files.
   *
   * The account whose identity it is owns the copy — the person's or the
   * group's — because that is where their own client looks for it when it reads
   * the marker back. The client builds the marker; this only stores the file.
   */
  api.post(
    "/admin/identities/signature-html",
    requireSession,
    requireAdmin,
    async (c) => {
      const body = await readJson<{
        kind?: unknown;
        target?: unknown;
        identityId?: unknown;
        html?: unknown;
      }>(c);
      try {
        const kind = body?.kind === "group" ? "group" : "user";
        const blobId = await storeSignatureHtml(
          c.get("session"),
          kind,
          typeof body?.target === "string" ? body.target : "",
          typeof body?.identityId === "string" ? body.identityId : "",
          typeof body?.html === "string" ? body.html : "",
        );
        return c.json({ blobId });
      } catch (err) {
        return identityFailure(c, err);
      }
    },
  );
}
