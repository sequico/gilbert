/**
 * The one test for "this session account is a group mailbox".
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
