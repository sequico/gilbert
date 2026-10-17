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
 * The accounts of a session that are group candidates, by id and by the name they
 * are read under.
 *
 * One walk, two readers: the classifier that probes each candidate for a mail
 * store (`groupAccountsDetailed` on the server) and the pass that asks whether
 * those answers can have changed since the last one it took (`agent/supervisor.ts`).
 * A reader that spelled the walk a second time would compare two lists that were
 * never the same one, and a roster cached against the wrong list is a group that
 * is worked twice or not at all.
 *
 * One candidate per name, in the order the session lists them: a name two
 * accounts carry is one group, and the first of them is the one the answer comes
 * from — the same rule the classifier's own map is built by.
 */
export function groupCandidates(
  accounts: Record<string, unknown> | undefined | null,
): Array<[accountId: string, name: string]> {
  const out: Array<[string, string]> = [];
  for (const [accountId, account] of Object.entries(accounts ?? {})) {
    const record = account as { name?: unknown; isPersonal?: unknown };
    if (!isGroupAccountRecord(record)) continue;
    const name = (record.name as string).trim().toLowerCase();
    if (out.some(([, seen]) => seen === name)) continue;
    out.push([accountId, name]);
  }
  return out;
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
