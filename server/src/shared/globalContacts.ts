/**
 * The constants and shapes of Global contacts both tiers read (ADR 0023).
 *
 * The name of the installation's directory and the shapes a card is read and
 * written through are decisions, not one tier's private spelling: the server
 * names the book by that constant, and the route answers and accepts these
 * fields, so a client cannot write a key the directory does not mean to carry.
 * Declared twice, either would drift into two names for one thing.
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

/**
 * A Global contacts card as both tiers read it (ADR 0023).
 *
 * The directory is served through a route, and this is the shape the route
 * answers: the fields a reader draws and a search matches, flattened from the
 * JSContact card the Master holds, so the client never parses the server's card
 * vocabulary. It is `GlobalContactInput` plus the card's id — the small shape,
 * with the one field a reader needs to refer to the card again.
 */
export interface GlobalContactView {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  organization: string;
  notes: string;
}
