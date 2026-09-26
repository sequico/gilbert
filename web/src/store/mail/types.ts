import {
  type Comparator,
  EMAIL_FULL_HEADER_PROPS,
  type Email,
  type EmailFilter,
  type Id,
  type Identity,
  type Mailbox,
  type MailboxRole,
  type Quota,
  type Thread,
  type VacationResponse,
} from "@/jmap/types";
import type { ArchiveGranularity } from "@/lib/archiveDate";
import type { KeywordCounts } from "@/lib/keywordCounts";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import type { DeleteOutcome } from "@/lib/mailDelete";
import { SPAM_HEADER_PROPS } from "@/lib/spamScore";

/*
 * Named explicitly so `shareWith` comes back, which a mailbox does not
 * otherwise return -- not on 0.16.19 and not on 0.16.21, where `Calendar/get`
 * and `AddressBook/get` do hand over every property unasked. See the note on
 * CALENDAR_PROPS and the KNOWN-ISSUES entry. So does `Files`, which names its
 * own properties.
 *
 * It matters here for one narrow but real case. Sharing a mail folder is
 * withdrawn because Stalwart stores the share and never delivers it, and the
 * only way left to clear one already made is the "Stop sharing" entry, which
 * appears only when a folder looks shared. Without this it never looked shared,
 * so the escape hatch for the exact situation it was built for was invisible.
 */
export const MAILBOX_PROPS = [
  "id",
  "name",
  "parentId",
  "role",
  "sortOrder",
  "totalEmails",
  "unreadEmails",
  "totalThreads",
  "unreadThreads",
  "myRights",
  "isSubscribed",
  "shareWith",
];

export const LIST_PROPS = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "hasAttachment",
  "from",
  "to",
  "subject",
  "receivedAt",
  "sentAt",
  "size",
  "preview",
];

export const FULL_PROPS = [
  ...LIST_PROPS,
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "cc",
  "bcc",
  "replyTo",
  "bodyStructure",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
  ...EMAIL_FULL_HEADER_PROPS,
  ...SPAM_HEADER_PROPS,
];

export const BODY_PROPS = [
  "partId",
  "blobId",
  "size",
  "name",
  "type",
  "charset",
  "disposition",
  "cid",
  "language",
  "location",
  "subParts",
  "headers",
];

export interface ListQuery {
  key: string;
  filter: EmailFilter;
  sort: Comparator[];
  collapseThreads: boolean;
  mailboxId: string | null;
  label?: string;
}

export interface ListState extends ListQuery {
  ids: Id[];
  total: number;
  queryState: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  exhausted: boolean;
}

export interface MailState {
  accountId: Id | null;
  /** The reader's own mail account. Group mailboxes open without moving it. */
  ownAccountId: Id | null;
  /** Mailbox accounts the sidebar can open: own first, then groups. */
  mailAccounts: MailAccountInfo[];
  /** Folder trees per account, so the sidebar can show every box at once. */
  accountTrees: Record<Id, Record<Id, Mailbox>>;
  mailboxes: Record<Id, Mailbox>;
  mailboxState: string | null;
  mailboxesLoaded: boolean;
  emails: Record<Id, Email>;
  fullIds: Record<Id, true>;
  emailState: string | null;
  threads: Record<Id, Thread>;
  identities: Identity[];
  /**
   * Identity/get per account, cached by account id.
   *
   * `identities` below is one *view* of this: the account on screen. Settings
   * needs a second view at the same time -- the reader's own list, which lives
   * in the account that sends for them and is rarely the account they are
   * browsing -- and both are read from this one cache, so the two surfaces
   * cannot disagree about what an account's identities are (ADR 0007).
   */
  identitiesByAccount: Record<Id, Identity[]>;
  /**
   * What a group mailbox has **assigned to the reader**, by account id
   * (ADR 0007): the identity that is theirs there.
   *
   * Only the assignment is kept, because it is the one thing the client cannot
   * work out: which of the group's identities an administrator gave this member
   * is a fact the group's account records. The group's **own** identity — what
   * an unassigned member sends as — is not a second fact, it is step 2 of the
   * cascade, derived where the cascade is applied from the address the session
   * calls the account, by the one function both tiers share.
   *
   * A missing entry is "not read yet", which is not the same as
   * `assignedId: null` — "read, and nothing is assigned". Both are applied by
   * the one cascade, and an entry that has not landed yet is no assignment:
   * the view offers the group's own identity until the answer arrives rather
   * than an empty From, which the composer reports as a group that holds no
   * identity at all.
   */
  assignmentByAccount: Record<Id, { assignedId: string | null }>;
  quotas: Quota[];
  /**
   * The account `quotas` is the storage of. The sidebar bar follows the account
   * on screen, so it asks again when this is not the active one; a group's
   * quota is the group's own (ADR 0023, RFC 9425).
   */
  quotaAccountId: Id | null;
  vacation: VacationResponse | null;
  list: ListState | null;
  selected: Record<Id, true>;
  /** How much mail each counted keyword holds, for the sidebar. */
  labelCounts: Record<string, KeywordCounts>;
  /**
   * The selection means "everything the current query matches", not the rows
   * that happen to be loaded. Ticking the header box selects the loaded page;
   * this is the deliberate second step past it.
   */
  selectedAll: boolean;
  anchorId: Id | null;
  loadingThreads: Record<Id, true>;
  lastSeenInboxEmailIds: Id[] | null;
  /** Ids of the last conversation that finished loading (for the reading pane). */
  lastThreadEmailIds: Id[];
  openThreadId: Id | null;
  setOpenThread(id: Id | null): void;

  setAccount(accountId: Id | null): void;
  /** Discover group mailboxes and fetch their folder trees. */
  discoverMailAccounts(): Promise<void>;
  /** Re-fetch one account's folder tree (a group mailbox changed elsewhere). */
  refreshAccountTree(accountId: Id): Promise<void>;
  /** Switch the active account to `accountId`, loading its mail and identities. */
  openAccount(accountId: Id): Promise<void>;
  loadMailboxes(): Promise<void>;
  roleId(role: MailboxRole): Id | null;
  /**
   * The account whose folder tree holds `mailboxId`, or null when no cached
   * tree does. A route names a folder and not the account it lives in; on a
   * cold load this is how that folder is resolved back to its owner.
   */
  accountOfMailbox(mailboxId: Id): Id | null;
  /**
   * ADR 0015: whether a destroy may be taken in the account on screen at all.
   *
   * The rule itself is `@/lib/mailDelete`, and this is the store's read of the
   * two inputs it needs — the account on screen, and the session's `isAdmin`
   * with the question `isOwnMailAccount` answers. Exposed so that a surface
   * asks once instead of each of them assembling the same three values, and
   * reads the same answer the guards on the effects use.
   */
  mayDestroyHere(): boolean;
  mailboxPath(id: Id): string;
  childrenOf(parentId: Id | null): Mailbox[];

  query(q: ListQuery, opts?: { reset?: boolean }): Promise<void>;
  loadMore(): Promise<void>;
  refreshList(): Promise<void>;

  getEmails(ids: Id[], full?: boolean): Promise<Email[]>;
  loadThread(threadId: Id): Promise<Email[]>;
  threadEmails(threadId: Id): Email[];
  threadIdsIn(threadId: Id, mailboxId: Id | null): Id[];

  setKeyword(ids: Id[], keyword: string, value: boolean): Promise<void>;
  markRead(ids: Id[], read: boolean): Promise<void>;
  star(ids: Id[], on: boolean): Promise<void>;
  move(
    ids: Id[],
    toMailboxId: Id,
    opts?: { fromMailboxId?: Id | null; silent?: boolean; label?: string },
  ): Promise<void>;
  addToMailbox(ids: Id[], mailboxId: Id, add: boolean): Promise<void>;
  trash(ids: Id[]): Promise<DeleteOutcome>;
  destroy(ids: Id[]): Promise<DeleteOutcome>;
  archive(ids: Id[]): Promise<void>;
  /** Archive into a dated subfolder of Archive, creating the folders as needed. */
  archiveByDate(ids: Id[], granularity: ArchiveGranularity): Promise<void>;
  spam(ids: Id[], isSpam: boolean): Promise<void>;
  emptyMailbox(mailboxId: Id): Promise<DeleteOutcome>;
  /** Mark every unread message in a mailbox read; optionally its subfolders too. */
  markMailboxRead(mailboxId: Id, includeChildren?: boolean): Promise<void>;
  /** The mailbox plus all of its descendants. */
  descendantMailboxIds(mailboxId: Id): Id[];

  createMailbox(name: string, parentId: Id | null, role?: MailboxRole): Promise<Id>;
  /** Give something the Archive role -- adopting a folder already named for it, or making one. */
  ensureArchiveFolder(): Promise<Id>;
  updateMailbox(id: Id, patch: Partial<Mailbox>): Promise<void>;
  destroyMailbox(id: Id, removeEmails?: boolean): Promise<DeleteOutcome>;

  loadIdentities(): Promise<Identity[]>;
  /** Read one account's identities: the one fetch behind both views. */
  loadIdentitiesFor(accountId: Id): Promise<Identity[]>;
  /**
   * Read which identity a group mailbox has assigned to the reader (ADR 0007).
   *
   * Answered as the member, because it is their own assignment: the group's own
   * document, read through the group's access rule. Only a group mailbox has
   * one, and only the account on screen needs it.
   *
   * `force` is for the surfaces that show the assignment rather than act on it:
   * the administration writes it from another session, so a page that reads only
   * a missing entry would go on showing "nothing assigned" for the rest of the
   * session — the same rule the person's own identity section follows when it
   * reads its list again as it opens.
   */
  loadAssignmentFor(accountId: Id, opts?: { force?: boolean }): Promise<void>;
  /** The user's preferred identity (falls back to the first one). */
  defaultIdentity(): Identity | undefined;
  /** One account's preferred identity, whether or not it is the one on screen. */
  defaultIdentityFor(accountId: Id | null): Identity | undefined;
  /**
   * The identities of the account that **sends for the reader**, from the cache.
   *
   * `identities` is the account on screen, and in a group mailbox it is one
   * identity -- the reader's, or none at all until the administration has set
   * one. Anything asking "which addresses are mine?" wants this instead: the
   * account the session names for submission, whole. Empty until its list has
   * landed, which is a real answer -- an account with no identity has no address
   * to call its own.
   */
  ownIdentities(): Identity[];
  setDefaultIdentity(id: Id): void;
  saveIdentity(id: Id | null, patch: Partial<Identity>): Promise<void>;
  destroyIdentity(id: Id): Promise<void>;
  /**
   * Re-read every identity list this session holds.
   *
   * The administration writes identities through its own routes, not through
   * this store's client -- the server does it by impersonating the account
   * (ADR 0007) -- so the session that asked for the write is the one thing that
   * never hears about it. A list read before it is what Settings would go on
   * showing and what a reply would go on offering as a sender, so the writes
   * themselves ask for this once the server has accepted the change.
   */
  refreshIdentities(): Promise<void>;
  loadVacation(): Promise<void>;
  saveVacation(patch: Partial<VacationResponse>): Promise<void>;
  loadQuota(): Promise<void>;

  select(ids: Id[], on: boolean): void;
  clearSelection(): void;
  /** Refresh the per-label unread counts, in one request. */
  loadLabelCounts(): Promise<void>;
  selectAll(): void;
  /** Extend the selection from the loaded rows to everything the query matches. */
  selectAllMatching(): void;
  /** Every id the current query matches, walked a page at a time. */
  queryAllIds(): Promise<Id[]>;
  setAnchor(id: Id | null): void;

  applyChanges(types: Set<string>, signal?: AbortSignal): Promise<void>;
  /**
   * Route one account's push change: the active account's own flow, or a group
   * mailbox's -- which refreshes its tree and announces the mail it received.
   */
  applyAccountChanges(
    accountId: Id,
    types: Set<string>,
    signal?: AbortSignal,
  ): Promise<void>;
  importEml(
    blobId: Id,
    mailboxId: Id,
    keywords?: Record<string, boolean>,
  ): Promise<Id | null>;
}
