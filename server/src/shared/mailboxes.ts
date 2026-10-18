/**
 * The mailboxes of one account, as the two readers that need them ask.
 *
 * The group classifier asks which folders an account holds, to tell a group
 * mailbox from a calendar; the agent's search resolves a folder name to an id
 * against the same answer. One call shape, because a property one of them
 * needs and the other does not is how the two come to disagree about the same
 * folder tree.
 */

import type { JmapClient } from "../jmap.js";
import { JMAP_MAIL } from "../jmap.js";

/** One mailbox as `Mailbox/get` answers it, before either reader shapes it. */
export interface MailboxRecord {
  id?: unknown;
  name?: unknown;
  role?: unknown;
  parentId?: unknown;
}

export async function mailboxesOf(
  client: JmapClient,
  accountId: string,
): Promise<MailboxRecord[]> {
  const res = await client.call<{ list?: MailboxRecord[] }>(
    "Mailbox/get",
    { accountId, ids: null, properties: ["id", "name", "role", "parentId"] },
    [JMAP_MAIL],
  );
  return res.list ?? [];
}
