/**
 * Who may move a contact from one account to another — the one rule.
 *
 * A contact card is an object of one account: a personal book's card is the
 * reader's, a group mailbox's card is the **group's**, filed in the account the
 * group owns (ADR 0005). Moving one between accounts is therefore not a filing
 * change: the card goes where the target account lives, and it belongs to
 * whoever that account belongs to afterwards. That is the step this rule is
 * about, and it is an installation administrator's, for the reason ADR 0015
 * gives about a group's mail — the group's data is not one member's to hand
 * over, and there is no rank inside a group that would say which member's it
 * is.
 *
 * Three things a reader may do are deliberately **not** a move, and none of
 * them is refused by this rule:
 *
 *   - filing a **new** card into a group's book, which is how group data is
 *     created and is what a member is for (ADR 0005);
 *   - editing a card where it lives, group books included;
 *   - changing which book of **one account** holds it, which changes nothing
 *     about whose it is.
 *
 * **It is a rule, not a boundary.** Another JMAP client on the same accounts
 * moves the same card without asking this code.
 *
 * **It answers a code, never a sentence.** The sentence is composed where it is
 * shown, so the catalogue in force reaches it.
 *
 * Nothing here reads a store: the two accounts and the admin flag are handed
 * in, which is what lets the rule be exercised without a running app.
 */
import type { Id } from "@/jmap/types";

/** Why a move between accounts is refused. */
export type ContactMoveRefusal = "contact_move_admin";

export interface ContactMoveContext {
  /** The account holding the card as it is now. */
  fromAccountId: Id | null;
  /** The account holding the address book it is going to. */
  toAccountId: Id | null;
  /** The session's admin flag (ADR 0001). */
  isAdmin: boolean;
}

/**
 * Whether this is a move at all, in the sense this rule means: the card changes
 * the account it lives in.
 *
 * An account nobody could name is not one of them — a caller that has not found
 * the card's account has a failure of its own to report, and it is not this
 * rule's.
 */
export function movesBetweenAccounts(
  fromAccountId: Id | null,
  toAccountId: Id | null,
): boolean {
  return Boolean(fromAccountId && toAccountId && fromAccountId !== toAccountId);
}

/** Why this move is refused, or `null` where it may be taken. */
export function contactMoveRefusal(ctx: ContactMoveContext): ContactMoveRefusal | null {
  if (!movesBetweenAccounts(ctx.fromAccountId, ctx.toAccountId)) return null;
  return ctx.isAdmin ? null : "contact_move_admin";
}

/** Whether this move may be taken here. */
export function mayMoveContact(ctx: ContactMoveContext): boolean {
  return contactMoveRefusal(ctx) === null;
}
