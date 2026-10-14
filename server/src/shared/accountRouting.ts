/**
 * Which account a request goes to, and which account the reader is looking at.
 *
 * A JMAP session lists more than one account whenever anything is shared with
 * you: the sharer's account appears alongside your own, carrying whichever
 * capabilities they shared. Three different questions are asked of that list,
 * and they have three different answers -- which is why they are named here,
 * once, for both tiers:
 *
 *   - **where my own state lives** -> `ownAccountForCapability`. Gilbert keeps
 *     its settings, signature images and push registration in the account's
 *     Files, and a shared file account advertises the file capability by
 *     definition: the obvious rule, "use whichever account is selected if it
 *     can do this", writes your settings into the other person's storage the
 *     moment you change one while looking at their folder.
 *   - **what the reader is looking at** -> `accountForCapability`, which honours
 *     the switcher and is the client's alone: a session on the server has no
 *     selection.
 *   - **where an object the session names lives** -> `processAccountForCapability`,
 *     which is what a process without a switcher reads: the account the session
 *     names for the capability, then a personal one advertising it, then any
 *     one that does.
 *
 * The two share one sentence: a capability the account does not advertise must
 * not be read from that account anyway. A session with no primary account for
 * something would otherwise aim it at whoever was selected -- someone else --
 * and falling back to nothing is the honest answer: the feature is unavailable,
 * which is true, rather than pointed at a stranger's data.
 */

export interface SessionLike {
  /**
   * JMAP's accounts and its primaries, as either tier holds them. Both are
   * present on every session this is asked with -- a `Ctx`'s upstream session
   * and the client's typed one -- so they are required here, and the values are
   * read field by field below because neither tier types them the same way.
   */
  accounts: Record<string, unknown>;
  primaryAccounts: Record<string, unknown>;
}

interface AccountShape {
  isPersonal?: unknown;
  accountCapabilities?: Record<string, unknown>;
}

/**
 * Whether an account is the reader's own rather than a group's.
 *
 * The literal `true`, not "anything that is not `false`". RFC 8620 makes
 * `isPersonal` a boolean and every conforming server sends it, so the two rules
 * answer alike on a real session; they part on an account record that omits it,
 * and this one calls that account a group's. The safe direction is the point:
 * an account Gilbert cannot prove is somebody's own is one nobody's own state
 * may land in, and the group classifier (`isGroupAccountRecord`) reads the
 * mirror of this rule.
 */
const personal = (account: unknown): boolean =>
  (account as AccountShape | undefined)?.isPersonal === true;

/**
 * Whether an account advertises a capability.
 *
 * The value's truthiness, because a capability map carries an object or a
 * boolean and `{}` is how a server answers "yes" (RFC 8620). A `null` value is
 * not a capability, and a key alone is not proof of one.
 */
const advertises = (account: unknown, capability: string): boolean =>
  Boolean((account as AccountShape | undefined)?.accountCapabilities?.[capability]);

/** Every account the session lists, in the order it lists them. */
function listed(session: SessionLike | null | undefined): Array<[string, unknown]> {
  return Object.entries(session?.accounts ?? {});
}

/** The id the session names for a capability, where it names one. */
function primaryFor(session: SessionLike | null | undefined, capability: string): string {
  const primary = session?.primaryAccounts[capability];
  return typeof primary === "string" ? primary : "";
}

/**
 * The reader's own account for this capability, whatever they are looking at.
 *
 * Use for the reader's own state -- synced settings, signature images, push
 * registration, their own identities. These belong to them and follow them, and
 * must not land in an account somebody shared just because it happens to be on
 * screen.
 */
export function ownAccountForCapability(
  session: SessionLike | null | undefined,
  capability: string,
): string | null {
  if (!session) return null;
  const primary = primaryFor(session, capability);
  // A primary account is the reader's own by definition, but check rather than
  // assume: a server that named a shared one here would otherwise be trusted.
  if (primary && personal(session.accounts[primary])) return primary;
  const own = listed(session).find(
    ([, account]) => personal(account) && advertises(account, capability),
  );
  return own?.[0] ?? null;
}

/**
 * The account to read and write for this capability, honouring the switcher.
 *
 * Use for anything the reader is looking at: their mail, a shared calendar,
 * somebody's files. Not for anything of the reader's own -- see above.
 */
export function accountForCapability(
  session: SessionLike | null | undefined,
  selectedId: string | null,
  capability: string,
): string | null {
  if (!session) return null;
  const selected = selectedId ? session.accounts[selectedId] : undefined;
  if (selected && advertises(selected, capability)) return selectedId;
  const primary = primaryFor(session, capability);
  if (primary) return primary;
  // No primary, and the selection cannot serve this. Falling back to the
  // selection would aim the request at a shared account for something nobody
  // shared; only one of the reader's own accounts may stand in.
  if (personal(selected)) return selectedId;
  return null;
}

/**
 * The account an object the session names lives in: the capability's primary,
 * a personal account advertising it, or any account that does.
 *
 * Use where a process reads an object the *session* points at -- the directory,
 * the registry -- and has no particular selection to honour. The primary comes
 * first unasked, because that is what a primary is for: JMAP names it as the
 * account to use for that capability.
 */
export function processAccountForCapability(
  session: SessionLike | null | undefined,
  capability: string,
): string {
  const primary = primaryFor(session, capability);
  if (primary) return primary;
  let fallback = "";
  for (const [id, account] of listed(session)) {
    if (!advertises(account, capability)) continue;
    // Personal first: the first match can be a share that advertises the
    // capability too, and reading the server's own object through a stranger's
    // share is the wrong answer with no visible cause.
    if (personal(account)) return id;
    if (!fallback) fallback = id;
  }
  return fallback;
}
