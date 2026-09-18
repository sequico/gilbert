/**
 * The MIME types Gilbert's own surfaces hand each other, in one place.
 *
 * Two families, here for two reasons.
 *
 * The **app-folder document** is `application/json`, and the type travels with
 * the blob: `writeAppJson` stores one under it and the reader asks for it back
 * by name, so the writer and the reader have to mean the same string. It was a
 * `TYPE` constant in each writer that needed one.
 *
 * The **drag payloads** are the four `application/x-gilbert-*` types a surface
 * offers a dragged thing under and its drop targets recognise it by. They are
 * private spellings on purpose: a file dragged in from the desktop must not be
 * mistaken for a FileNode, and a folder drop has to be told from a message drop
 * before either reads anything. A literal at each end of that conversation is
 * how a drop target comes to accept a type nothing sets — the two ends are a
 * drag source in one view and a drop handler in another, and nothing else
 * connects them.
 *
 * A vendor tree (`x-gilbert`) is the right place for them: these never leave
 * the tab that made them, so only the two ends have to agree, which is exactly
 * what one module buys.
 */

/** What an app-folder document is stored and fetched as, in both tiers. */
export const JSON_MIME = "application/json";

/** A dragged FileNode. */
export const NODE_MIME = "application/x-gilbert-filenode";

/** A dragged folder in the mailbox tree. */
export const FOLDER_MIME = "application/x-gilbert-folder";

/** A dragged selection of messages. */
export const EMAILS_MIME = "application/x-gilbert-emails";

/** A dragged Sieve rule. */
export const SIEVE_RULE_MIME = "application/x-gilbert-sieve-rule";
