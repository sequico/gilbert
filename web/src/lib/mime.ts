/**
 * The MIME types Gilbert's own surfaces hand each other, in one place: the
 * **drag payloads**.
 *
 * The app-folder document's own type is deliberately not here. It is what both
 * tiers store a document as and fetch one back by name, so it is declared once
 * in `@gilbert/shared/appFolder` (`APP_DOCUMENT_TYPE`) and imported where it is
 * needed, rather than spelled again beside these.
 *
 * The drag payloads are the four `application/x-gilbert-*` types a surface
 * offers a dragged thing under and its drop targets recognise it by. They are
 * private spellings on purpose: a file dragged in from the desktop must not be
 * mistaken for a FileNode, and a folder drop has to be told from a message drop
 * before either reads anything. The two ends of that conversation are a drag
 * source in one view and a drop handler in another, with nothing but this string
 * connecting them, so a drop target that spells it differently accepts a type
 * nothing sets.
 *
 * A vendor tree (`x-gilbert`) is the right place for them: these never leave
 * the tab that made them, so only the two ends have to agree, which is exactly
 * what one module buys.
 */

/** A dragged FileNode. */
export const NODE_MIME = "application/x-gilbert-filenode";

/** A dragged folder in the mailbox tree. */
export const FOLDER_MIME = "application/x-gilbert-folder";

/** A dragged selection of messages. */
export const EMAILS_MIME = "application/x-gilbert-emails";

/** A dragged Sieve rule. */
export const SIEVE_RULE_MIME = "application/x-gilbert-sieve-rule";
