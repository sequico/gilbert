/**
 * The Master's own session, opened the one way every admin door opens it.
 *
 * Every surface that acts as the Master — the agent's own, the knowledge base,
 * workorders and Global contacts — needs the same things from the identity
 * door: the installation's session (`agentSession`) and, where a caller must be
 * an administrator, the read that answers it. The conditional-write token every
 * door's FileNode writes take (`requireState`) is here too. All of them live
 * here once, so a refusal is translated the same way everywhere and a change
 * reaches every door; each door only states which surface it is (the words its
 * sentence uses) and builds its own error type.
 */

import type { Ctx } from "./appFolder.js";
import { filesAccountId } from "./appFolder.js";
import { agentSession, IdentityAdminError, ownIdentityAccount } from "./identityAdmin.js";
import type { LiveSession } from "./sessions.js";
import { fetchAccountIntrospection, isStalwartAdmin, upstreamFor } from "./upstream.js";

/** A module's own refusal, built from the identity door's code and sentence. */
export type RefuseWith = (code: string, message: string, status: number) => Error;

/**
 * The account's FileNode state as the conditional-write token, or a refusal.
 *
 * A write that cannot be made conditional — because the account stated no state
 * — is a write that would silently replace one another writer just made, so it
 * is refused rather than sent unconditionally, the same `no_state` refusal the
 * installation document's own writer makes. The sentence and the code live here
 * once; each door builds its own error type through `refuse`, so a caller reads
 * a code that names that surface's own state rather than another one's message.
 */
export function requireState(state: string, refuse: RefuseWith): string {
  if (!state)
    throw refuse(
      "no_state",
      "The account would not state the state of its Files, so this write could not be made conditional — and a write that cannot be refused when the document moved is a write that can replace one somebody else just made. Nothing was written.",
      502,
    );
  return state;
}

/**
 * The same refusal, bound to one surface's own error type.
 *
 * The doors that write documents — identities and Global contacts, the
 * knowledge base, workorders — each raise their own error, and each wants this
 * token under that type. Binding it here means the shape of that binding is
 * written once rather than once per door, so a later change to how the refusal
 * is raised reaches all of them.
 */
export function stateRefuser(
  ErrorClass: new (code: string, message: string, status: number) => Error,
): (state: string) => string {
  return (state) =>
    requireState(state, (code, message, status) => new ErrorClass(code, message, status));
}

/**
 * The Master's own session for an admin write, or the caller's own refusal.
 *
 * `agentSession` raises `IdentityAdminError`; it is translated here through
 * `refuse` so the routes have one error shape per surface and a caller reads a
 * code that names that surface's own state rather than another one's message.
 * `what` is the surface as the sentence names it (e.g. `"workorders"`).
 */
export async function openMasterSession(
  admin: LiveSession,
  what: string,
  refuse: RefuseWith,
): Promise<Ctx> {
  try {
    return await agentSession(admin);
  } catch (err) {
    if (err instanceof IdentityAdminError)
      throw refuse(
        err.code,
        err.code === "agent_not_configured"
          ? `This deployment names no agent, so ${what} cannot be reached.`
          : `The installation's agent could not be used for ${what}: ${err.message}`,
        err.status,
      );
    throw err;
  }
}

/**
 * The Master's own account and its session: the registry's one writer.
 *
 * `files` says whether the Files account is preferred over the session's own
 * personal account — true for a door whose documents live in the app folder
 * (the knowledge base, workorders), false for one whose data is the account
 * itself (Global contacts).
 */
export async function openMasterAccount(
  admin: LiveSession,
  opts: {
    what: string;
    missingCode: string;
    missingMessage: string;
    files: boolean;
    refuse: RefuseWith;
  },
): Promise<{ ctx: Ctx; accountId: string }> {
  const ctx = await openMasterSession(admin, opts.what, opts.refuse);
  const accountId = opts.files
    ? filesAccountId(ctx) || ownIdentityAccount(ctx)
    : ownIdentityAccount(ctx);
  if (!accountId) throw opts.refuse(opts.missingCode, opts.missingMessage, 409);
  return { ctx, accountId };
}

/**
 * Whether the caller is an installation administrator, read the way the
 * administration's own route reads it.
 *
 * An unreadable introspection is non-admin: this only decides what a view
 * offers, while `requireAdmin` stays the enforcement on every write.
 */
export async function administrator(session: LiveSession): Promise<boolean> {
  try {
    const intro = await fetchAccountIntrospection(
      session.authorization,
      upstreamFor(session.username),
    );
    return isStalwartAdmin(intro.permissions);
  } catch (err) {
    console.warn(
      `[gilbert] could not read whether ${session.username} administers the installation:`,
      (err as Error).message,
    );
    return false;
  }
}
