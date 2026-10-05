import type { Id, Mailbox } from "@/jmap/types";

/**
 * Where Archive puts a conversation.
 *
 * A conversation comes back to life when a reply arrives: the reply lands in the
 * Inbox, while the rest of the thread is still in the folder the conversation
 * was filed under. Archiving it then means **putting it back where it was** --
 * that is the reader's own decision about where that conversation lives -- and
 * only a conversation that was never filed anywhere belongs in Archive.
 *
 * **One account at a time.** A thread is held inside one account, and two
 * accounts may each hold their own copy of the same conversation (a message to a
 * group and to the reader's own address is two deliveries, and two threads). So
 * everything here is read from the account the action is aimed at: the copy in
 * the group's account is filed there, the copy in the reader's own account here,
 * and neither decides anything about the other.
 */
export interface ConversedMessage {
  mailboxIds?: Record<Id, boolean> | null;
  /** When the message arrived: the newest filed one decides where "there" is. */
  receivedAt?: string | null;
}

/**
 * Whether a folder is somewhere mail is **filed**.
 *
 * The account's structural folders are not: Inbox is where mail arrives, Sent is
 * where every reply sits (nobody filed a conversation by sending it), and
 * Drafts, Junk and Trash are where mail waits to be dealt with. A folder with no
 * role is one somebody made and named, and Archive counts too -- it is where
 * filed mail ends up, and its dated children are ordinary folders under it.
 */
function isFilingFolder(mailbox: Mailbox | undefined): boolean {
  if (!mailbox) return false;
  return !mailbox.role || mailbox.role === "archive";
}

/**
 * The folder a conversation already lives in, or `null` when it was never filed.
 *
 * The folder of the **newest filed message** is the answer: a conversation that
 * moved from one case folder to another was last put in the second one, and the
 * newest reply -- the one that brought the conversation back to the Inbox -- is
 * in no filing folder at all, so it does not vote. When that message sits in
 * several filing folders at once, the one holding most of the thread wins, and
 * the id settles the rest, so the answer never depends on the order the folders
 * arrived in.
 */
export function filedFolderOf(
  messages: ReadonlyArray<ConversedMessage>,
  mailboxes: Record<Id, Mailbox>,
): Id | null {
  const filed = messages
    .map((message) => ({
      at: message.receivedAt ?? "",
      folders: Object.keys(message.mailboxIds ?? {}).filter((id) =>
        isFilingFolder(mailboxes[id]),
      ),
    }))
    .filter((entry) => entry.folders.length > 0);
  if (!filed.length) return null;

  filed.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const newest = filed[0]!;
  if (newest.folders.length === 1) return newest.folders[0]!;

  const held = new Map<Id, number>();
  for (const entry of filed)
    for (const folder of entry.folders) held.set(folder, (held.get(folder) ?? 0) + 1);
  const [winner] = [...newest.folders].sort((a, b) => {
    const byCount = (held.get(b) ?? 0) - (held.get(a) ?? 0);
    if (byCount) return byCount;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return winner ?? null;
}
