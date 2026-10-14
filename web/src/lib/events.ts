/**
 * The events the app raises at itself.
 *
 * Every one of these crosses a component boundary: the shell raises one, a
 * view that may not be mounted listens for it. A listener naming an event the
 * raiser does not raise fails with nothing to show for it — the click lands,
 * the view is not there, no error, and the button is simply dead. So each name
 * is written once, here, and both ends import it.
 *
 * These are in-page events. Nothing here is stored: a name that appears in a
 * document Stalwart keeps, or in the reader's settings, is a contract and is
 * named where it is written.
 */
export const EVENTS = {
  /** The shell's "New contact" command, for a Contacts view not yet mounted. */
  newContact: "gilbert:new-contact",
  /** The shell's "New event" command, for a Calendar view not yet mounted. */
  newEvent: "gilbert:new-event",
  /** The shell's "Upload" command, for a Files view not yet mounted. */
  filesUpload: "gilbert:files-upload",
  /** A contact file chosen in the sidebar's menu. Detail: `{ file, bookId }`. */
  contactsImport: "gilbert:contacts-import",
  /** Export asked for in the sidebar's menu. Detail: `{ accountId, bookId }`. */
  contactsExport: "gilbert:contacts-export",
  /** Reply to the message on screen. Detail: the reply mode. */
  reply: "gilbert:reply",
  /** Move to the next or previous message. Detail: the direction. */
  messageNav: "gilbert:msg-nav",
  /** A chat notification's click. Detail: the conversation to open. */
  openChat: "gilbert:open-chat",
} as const;
