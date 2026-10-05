import type { Id, Mailbox } from "@/jmap/types";

/**
 * The folders of a group mailbox a member is not subscribed to.
 *
 * A subscription is read state kept for one principal, and Stalwart hands a
 * freshly added member every folder of the group **unsubscribed** -- including
 * the ones that were there long before they were added. A folder created
 * afterwards arrives unsubscribed too, for every member but whoever made it.
 * Nothing about membership writes it, so a member's own record has to be
 * brought up to what membership means; this is the answer to *what* has to be
 * written, and `adoptMailboxes` in the mail store is where it is written.
 *
 * Asked only about a tree that is not the reader's own. Their own mailbox keeps
 * its subscriptions, because there "unsubscribed" is something they said.
 *
 * The answer is about the folders in hand, not a diff against the server: a
 * folder that arrived subscribed is simply not in the list. That is what makes
 * it safe to ask on every read of the tree, which is what keeps it true for a
 * folder nobody's client has seen before.
 */
export function unsubscribedFolders(tree: Record<Id, Mailbox>): Id[] {
  return Object.values(tree)
    .filter((m) => !m.isSubscribed)
    .map((m) => m.id);
}
