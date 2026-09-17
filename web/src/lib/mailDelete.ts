/**
 * What a delete does here, and who may take one — the one rule (ADR 0015).
 *
 * A group mailbox is reached by membership rather than by a share, so the mail
 * server tells one member's delete from another's by nothing and offers no rank
 * inside a group. Whether a member may make a group's mail final is therefore
 * the client's rule, and this is it, in one place: every surface asks here
 * rather than deciding for itself, which is also what stops the surfaces from
 * disagreeing — they did, about whether Junk Mail counts alongside Deleted
 * Items when a delete is described as final.
 *
 * Three things end a message for good: deleting it while it sits in Deleted
 * Items or Junk Mail, emptying one of those two folders, and deleting a folder
 * together with the mail in it. What a member may not do in a group is any of
 * them. Everything else — moving, labelling, archiving, replying, forwarding —
 * is a change somebody can put right.
 *
 * **It is a rule, not a boundary.** The same account reached by another JMAP
 * client, by IMAP, or by the mail server's own administration destroys the same
 * mail without asking this code. A sentence about it names what is closed rather
 * than claiming a protection.
 *
 * **It answers codes, never sentences.** A string held here is a string no
 * catalogue can translate, so the surfaces compose what the reader reads from
 * their own language, which is the shape every other refusal in this product
 * has.
 *
 * Nothing in this file reads a store: the account, the session and the admin
 * flag are handed in. The mail store is one of its callers, so importing the
 * store here would be a cycle, and a rule that can only be exercised inside a
 * running app is the kind that stops being read.
 */
import type { Id } from "@/jmap/types";
import { isOwnMailAccount, type MailSessionLike } from "./mailAccounts";

/** What a delete does to a message: files it somewhere, or ends it. */
export type DeleteEffect = "move" | "final";

/**
 * Why a destroy is refused. One code per entry point, because the sentence the
 * reader needs differs: a refusal of a message is not a refusal of a folder.
 */
export type DeleteRefusal = "group_mail_final" | "group_mail_empty" | "group_mail_folder";

/** Which of the three entry points is asking. */
export type DestroyKind = "final" | "empty" | "folder";

const REFUSAL_BY_KIND: Record<DestroyKind, DeleteRefusal> = {
  final: "group_mail_final",
  empty: "group_mail_empty",
  folder: "group_mail_folder",
};

export interface DeleteContext {
  /** The account the action happens in — the mailbox on screen, not the reader's. */
  accountId: Id | null;
  /**
   * The session, for the one question that is answerable at any moment: whether
   * this account is the reader's own (`isOwnMailAccount`). The group classifier
   * is not asked here, because it answers "group" only once the account probe
   * has listed the account — see `mayDestroy`.
   */
  session: MailSessionLike | null;
  /** The session's admin flag (ADR 0001): decides this action for a person. */
  isAdmin: boolean;
}

/**
 * Whether a destroy may be taken in this account.
 *
 * An administrator may, anywhere: the rule exists so that a group's mail is
 * ended by somebody who owns the decision rather than by whoever happened to
 * have the folder open. The reader may in their own account, which is what
 * `isOwnMailAccount` answers and what makes this **fail closed**: it is a
 * question about the reader, so it is answerable before the account probe has
 * landed, and an account that is not provably theirs — a group, a share, an
 * account nobody has classified yet — is refused. Asking the group classifier
 * instead would answer "not a group" for an undiscovered group, which is the
 * window a boot and a reload on a group's address both sit in.
 */
export function mayDestroy(ctx: DeleteContext): boolean {
  if (ctx.isAdmin) return true;
  return isOwnMailAccount(ctx.session, ctx.accountId);
}

/** Why a destroy is refused here, or `null` where it may be taken. */
export function destroyRefusal(
  ctx: DeleteContext,
  kind: DestroyKind,
): DeleteRefusal | null {
  return mayDestroy(ctx) ? null : REFUSAL_BY_KIND[kind];
}

/** The folders whose role decides that a delete ends the message. */
export interface FinalFolders {
  trash?: Id | null;
  junk?: Id | null;
}

/**
 * The two final folders, found in the account's tree by the roles it carries.
 *
 * By role and not by name: a folder the reader renamed is still where Deleted
 * Items is, and a translation of "Junk Mail" must not move this answer.
 */
export function finalFoldersOf(
  mailboxes: Record<Id, { role?: string | null } | undefined> | null | undefined,
): FinalFolders {
  const byRole = (role: string): Id | null => {
    for (const [id, box] of Object.entries(mailboxes ?? {})) {
      if (box?.role === role) return id;
    }
    return null;
  };
  return { trash: byRole("trash"), junk: byRole("junk") };
}

/**
 * What deleting this message does, by the folders holding it.
 *
 * A message in Deleted Items or Junk Mail is one step past filing, so deleting
 * it is the end of it; anywhere else the same action files it in Deleted Items
 * and can be undone. Both folders count, which is the point of asking here: the
 * list, the message menu and the swipe used to answer this three ways.
 */
export function deleteEffect(
  email: { mailboxIds?: Record<Id, boolean> } | undefined,
  folders: FinalFolders,
): DeleteEffect {
  const held = email?.mailboxIds ?? {};
  for (const id of [folders.trash, folders.junk]) {
    if (id && held[id]) return "final";
  }
  return "move";
}

/**
 * Whether destroying this folder takes mail with it.
 *
 * Emptying a folder of nothing destroys nothing, and a group's tree stays the
 * group's to shape: the count the folder list already carries is the whole
 * question, so no query is made to answer it.
 */
export function folderDestroyTakesMail(
  folder: { totalEmails?: number } | undefined,
  removeEmails: boolean,
): boolean {
  return removeEmails && (folder?.totalEmails ?? 0) > 0;
}
