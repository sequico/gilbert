/**
 * Where an outbound document lives, and who may reach it (ADR 0040).
 *
 * A campaign belongs to a group, so it is stored in that group's own account and
 * every member of the group reaches it by membership — never by a share, and
 * never by a copy in the caller's own account. The route serves as the Master
 * (a member of every group the installation grants it on, ADR 0005) and asks the
 * caller's **own** session about membership first, live, so a member removed
 * from the group loses the list at once.
 *
 * The do-not-call list is the installation's, not a campaign's: one document in
 * the Master's own account, beside the installation's settings.
 */

import {
  groupNotGrantedRefuser,
  openMasterAccount,
  openMasterSession,
} from "../adminSession.js";
import { type Ctx, ensureFolderPath } from "../appFolder.js";
import { memberGroupAccess } from "../groupAccess.js";
import { groupAccountId } from "../identityAdmin.js";
import type { LiveSession } from "../sessions.js";
import { OUTBOUND_FOLDER } from "../shared/outbound.js";
import { OutboundError } from "./errors.js";

/** A group the Master's own session does not hold, said in this area's words. */
const groupNotGranted = groupNotGrantedRefuser(OutboundError);

/**
 * A group's outbound folder, having checked that the caller is a member of that
 * group.
 *
 * The membership read comes first and is the member door's own; only then is
 * the Master's session opened, and the group must be in it too, or there is
 * nothing to write as.
 */
export async function campaignAccount(
  admin: LiveSession,
  group: string,
): Promise<{ ctx: Ctx; accountId: string; folderId: string }> {
  const access = await memberGroupAccess(admin, group, { need: "outbound" });
  if (!access.ok) {
    throw new OutboundError(
      access.error,
      `Outbound calling for "${group.trim() || group}" is out of reach: you may not be a member of that group, or the mail server did not answer about it.`,
      403,
    );
  }
  const ctx = await openMasterSession(admin, "outbound calling", (code, message, status) =>
    new OutboundError(code, message, status),
  );
  const accountId = groupAccountId(ctx, group);
  if (!accountId) throw groupNotGranted(group.trim() || group, "its outbound calls cannot be read or written");
  const folderId = await ensureFolderPath(ctx, accountId, OUTBOUND_FOLDER);
  return { ctx, accountId, folderId };
}

/** The installation's do-not-call list: the Master's own account, and its folder. */
export async function doNotCallAccount(
  admin: LiveSession,
): Promise<{ ctx: Ctx; accountId: string; folderId: string }> {
  const { ctx, accountId } = await openMasterAccount(admin, {
    what: "the do-not-call list",
    missingCode: "no_installation_account",
    missingMessage: "The Master's own account could not be read, so the do-not-call list cannot be reached.",
    files: true,
    refuse: (code, message, status) => new OutboundError(code, message, status),
  });
  const folderId = await ensureFolderPath(ctx, accountId, OUTBOUND_FOLDER);
  return { ctx, accountId, folderId };
}
