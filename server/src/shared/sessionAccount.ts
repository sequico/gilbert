/**
 * The tests both tiers read about a session: which account is a group mailbox,
 * and whether the session's account administers the installation. Each question
 * is answered once here, so a reader that starts from one of them cannot
 * disagree with the next.
 *
 * A group mailbox is **non-personal** and named by an **address**. Whether it
 * actually answers as a mail store is a separate probe (`groupAccountsDetailed`
 * on the server, `discoverMailAccounts` in the client); this is the shape every
 * reader starts from, so the knowledge base, the chat picker and the agent's
 * group reach cannot disagree about which accounts are even candidates.
 *
 * The name is deliberately address-shaped rather than resolved: two accounts
 * are one group by address, not by string, and the caller that has a specific
 * group compares with `sameAddress` on top of this.
 */
export function isGroupAccountRecord(
  account: { name?: unknown; isPersonal?: unknown } | undefined,
): boolean {
  if (account?.isPersonal !== false) return false;
  if (typeof account.name !== "string") return false;
  return account.name.trim().indexOf("@") > 0;
}

/**
 * Whether an account is one the reader reaches **other than as their own**: a
 * share somebody made, or a group they are a member of.
 *
 * A different question from `isGroupAccountRecord` above, and a wider one — so
 * much so that asking the group question where this one belongs loses answers.
 * A share is whichever account the other person has, named what they named it;
 * a group is named by an address precisely because *two accounts are one group
 * by address*. A reader who substitutes one for the other therefore drops every
 * share whose account is not address-named: the shared calendars, the shared
 * books and the shared files all disappear, and nothing says why, because the
 * filter simply found no accounts.
 *
 * Where the question is "is this a group mailbox", ask `isGroupAccountRecord`.
 * Where it is "may this account be entered, whatever it is", ask this one.
 */
export function isSharedAccountRecord(
  account: { isPersonal?: unknown } | undefined,
): boolean {
  return account?.isPersonal === false;
}

/**
 * Whether the session says its account administers the installation.
 *
 * The flag is the session's own **view** of the marker, not the door: whether a
 * session may actually administer is a second question with its own answer
 * (`mayAdminister` in the client, `administrator` on the server), and the two
 * are deliberately apart. Every surface that shows or withholds an
 * administration control reads this one, so a flag that moves cannot leave one
 * of them behind.
 */
export function sessionIsAdmin(
  session: { gilbert?: { isAdmin?: unknown } } | null | undefined,
): boolean {
  return session?.gilbert?.isAdmin === true;
}
