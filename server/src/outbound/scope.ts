/**
 * Where an outbound document lives, and who may reach it (ADR 0040).
 *
 * A campaign belongs to a group, so it is stored in that group's own account and
 * every member reaches it by membership — never by a share, never by a copy in
 * the caller's own account, and never through the installation's agent: the
 * session that reads and writes is the caller's own. The membership read is live,
 * so a member removed from the group loses the list at once, and a group the
 * installation's agent holds no grant on works exactly like any other.
 *
 * The do-not-call list is the group's, beside the campaigns that honour it: a
 * promise not to call is kept by the group doing the calling.
 */

import type { Ctx } from "../appFolder.js";
import { memberGroupAccess } from "../groupAccess.js";
import type { LiveSession } from "../sessions.js";
import { OutboundError } from "./errors.js";

/**
 * A group's outbound documents, reached as the caller.
 *
 * The member door is the only one this area opens, and what it answers with is
 * enough: the account is where the campaigns, the rows and the do-not-call list
 * live, and the session beside it is the one that reads and writes them.
 */
export async function campaignAccount(
  admin: LiveSession,
  group: string,
): Promise<{ ctx: Ctx; accountId: string }> {
  const access = await memberGroupAccess(admin, group, { need: "outbound" });
  if (!access.ok) {
    throw new OutboundError(
      access.error,
      `Outbound calling for "${group.trim() || group}" is out of reach: you may not be a member of that group, or the mail server did not answer about it.`,
      403,
    );
  }
  return { ctx: access.ctx, accountId: access.accountId };
}
