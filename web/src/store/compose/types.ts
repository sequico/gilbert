import type { StoreApi } from "zustand";
import type { Email, EmailAddress, Id, Identity } from "@/jmap/types";
import type { SharedContent } from "@/lib/shareTarget";
import type { Template } from "@/store/settings";

export interface ComposeAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  blobId: Id | null;
  progress: number;
  error: string | null;
  file?: File;
  cid?: string;
  inline?: boolean;
  abort?: AbortController;
}

/** A file in Files, enough of it to attach. */
export interface AttachableFile {
  accountId: Id;
  name: string;
  type: string | null;
  size: number | null;
  blobId: Id;
}

export type Priority = "high" | "normal" | "low";

/**
 * The undo window, in seconds: a product constant, not a setting.
 *
 * Every sender gets the same five-second hold before the message is submitted,
 * and nothing in the client or an installation policy changes it. It lives
 * here because the send path is the one reader.
 */
export const UNDO_SEND_SECONDS = 5;
/**
 * How a message is being answered, which decides who the draft is addressed to:
 * one partner for a reply, everyone for a reply all.
 */
export type ReplyMode = "reply" | "replyAll" | "forward";
export interface Draft {
  key: string;
  /**
   * The account the draft lives in, stamped when it is opened.
   *
   * A composer outlives a switch of mailbox, so the account on screen when a
   * save runs is not necessarily the one the draft belongs to. Saving it there
   * would create it in the wrong Drafts with an id from the other account.
   */
  accountId: Id;
  draftId: Id | null;
  identityId: Id | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  /** Per-message Reply-To (defaults to the identity's Reply-To). */
  replyTo: EmailAddress[];
  subject: string;
  html: string;
  text: string;
  format: "html" | "text";
  attachments: ComposeAttachment[];
  inReplyTo: string[] | null;
  references: string[] | null;
  relatedEmailId: Id | null;
  relatedKeyword: "$answered" | "$forwarded" | null;
  requestReceipt: boolean;
  priority: Priority;
  showCc: boolean;
  showBcc: boolean;
  showReplyTo: boolean;
  minimized: boolean;
  maximized: boolean;
  dirty: boolean;
  savedAt: number | null;
  saving: boolean;
  error: string | null;
  /** Original identity signature HTML currently embedded, to replace on identity switch. */
  signatureHtml: string;
  replyMode: ReplyMode | null;
  mailboxIdOnSend?: Id | null;
  /** When set, hand the message to the server held until this instant. */
  sendAt: number | null;
  /**
   * The Message-ID this draft goes out under, fixed at its first send and
   * kept if the draft comes back after a failure in the same session. It is
   * not persisted with the draft, so a reload before the retry mints a new
   * one. Sending it again asks the server first whether a message with this
   * id already went out.
   */
  sendMessageId?: string;
  /**
   * Set when a failed send left a copy on the server that could not be
   * removed, the cleanup request having been refused while the reply was
   * already lost. The next send of this draft destroys that copy and sends
   * again, rather than reading a surviving copy as proof the message went out.
   */
  sendOrphan?: boolean;
}

/**
 * The reply the app's one-tap affordances open: reply all.
 *
 * One definition, because the answer has to be the same wherever the app offers
 * the single-button reply -- a header button that reached the list and a reply
 * strip that reached the sender would be the same decision half-applied. It is
 * not a setting: it is what the app does, and every surface that offers a
 * choice says which action each choice is (see `reply`).
 */
export const REPLY_ALL: ReplyMode = "replyAll";
export const REPLY: ReplyMode = "reply";
export const DEFAULT_REPLY_MODE: ReplyMode = REPLY_ALL;

/**
 * The keys that answer a conversation, and which reply each one opens.
 *
 * One definition, so the pair cannot drift and a test can read it without
 * rendering the mail view. The plain reply is the plain key and the reply to
 * everyone is the one whose letter says so: `r` and `a`, which is also the
 * order they are offered in.
 */
export const REPLY_KEYS: ReadonlyArray<{
  keys: string;
  mode: ReplyMode;
  description: string;
}> = [
  { keys: "r", mode: REPLY, description: "Reply" },
  { keys: "a", mode: REPLY_ALL, description: "Reply all" },
];

/**
 * What `create` hands a slice: the store's own reader and writer.
 *
 * The store is assembled in `index.ts` from one function per job, and a slice
 * never imports the store it belongs to -- it is handed these two, which is what
 * keeps the modules acyclic and each one readable on its own.
 */
export type ComposeSet = StoreApi<ComposeState>["setState"];
export type ComposeGet = StoreApi<ComposeState>["getState"];

/**
 * The account, the persona and the folders a Send was pressed under, resolved
 * once and carried to the submission.
 *
 * The undo window is long enough to open another mailbox inside it, and every
 * id this send needs is one the *account* owns: the identity it is submitted
 * as, the folder the copy lands in, the folder a draft is taken out of. Read
 * afterwards, they describe whichever mailbox is on screen by then -- a send
 * through another account's identity, or one from no account at all. So they
 * are resolved when Send is pressed and travel with the send, which is also
 * what makes switching mailbox inside the window a change of view rather than
 * an Undo.
 */
export interface SendTarget {
  accountId: Id | null;
  identity: Identity | null;
  /** Where the copy lands: the account's Sent, or its Inbox when it has none. */
  sentId: Id | null;
  draftsId: Id | null;
}

export interface ComposeState {
  drafts: Draft[];
  activeKey: string | null;
  pendingSends: Record<
    string,
    {
      timer: number;
      toastId: number;
      draft: Draft;
      /** The undo window has closed and the send has begun; undo no longer applies. */
      started: boolean;
      run: () => Promise<void>;
    }
  >;
  /**
   * Send everything still inside its undo window, now. For signing out, while
   * the session can still send.
   */
  flushPendingSends(): Promise<void>;
  open(init?: Partial<Draft>): string;
  /** Open a draft holding what the operating system's share sheet sent us. */
  openFromShare(share: SharedContent): string;
  openDraftEmail(email: Email): Promise<string>;
  /** Open a message again as a mail that has not been sent yet. */
  composeAsNew(email: Email): Promise<string>;
  /**
   * The reply the app's one-tap affordances open.
   *
   * Reply all, and not a preference: answering the list is what a conversation
   * with more than one other person means, and a one-tap control cannot say
   * which of the two it did. The explicit "Reply" -- to the sender alone -- is
   * the item beside it wherever there is room for a choice, and every surface
   * that shows it says what it does.
   */
  reply(email: Email, mode: ReplyMode): Promise<string>;
  /** Forward the message whole, as an attachment, rather than quoted into a new one. */
  forwardAsAttachment(email: Email): string;
  update(key: string, patch: Partial<Draft>): void;
  close(key: string, opts?: { discard?: boolean }): Promise<void>;
  focus(key: string): void;
  addFiles(key: string, files: File[]): void;
  /** Attach files already in Files, by reference where the account allows it. */
  addFromFiles(key: string, nodes: AttachableFile[]): Promise<void>;
  removeAttachment(key: string, attId: string): void;
  saveDraft(key: string, opts?: { silent?: boolean }): Promise<Id | null>;
  send(key: string): Promise<void>;
  undoSend(key: string): void;
  setIdentity(key: string, identityId: Id): void;
  insertTemplate(
    key: string,
    template: Pick<Template, "html" | "to" | "cc" | "bcc"> & { subject?: string },
  ): void;
}
