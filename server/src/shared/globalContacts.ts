/**
 * The constants and shapes of Global contacts both tiers read (ADR 0023).
 *
 * The name of the installation's shared directory and the shape an
 * administrator writes a card through are decisions, not one tier's private
 * spelling: the client draws the book by that name, the server ensures it
 * carries it, and the administration sends these fields so a client cannot
 * write a key the directory does not mean to carry. Declared twice, either
 * would drift into two names for one thing.
 *
 * Type declarations and constants only: no runtime code reaches a bundle
 * through this file.
 */

/** The name the installation's Global contacts address book carries. */
export const GLOBAL_CONTACTS_BOOK_NAME = "Global contacts";

/**
 * What an administrator types for one Global contacts card (ADR 0023).
 *
 * A small, deliberate shape rather than a whole JSContact object: the
 * administration sends these fields and the server builds the card, so a
 * client cannot write a key the directory does not mean to carry. It is what
 * the contact editor reads and writes, declared once for both tiers.
 */
export interface GlobalContactInput {
  name: string;
  emails: string[];
  phones: string[];
  organization: string;
  notes: string;
}
