/**
 * The constants and shapes of the phone feature both tiers read (ADR 0023).
 *
 * The name of the installation's shared directory and the document an account
 * holds its per-identity SIP credentials in are decisions, not one tier's
 * private spelling: the client draws and dials Global contacts by that name,
 * the server ensures the book carries it, and the administrator writes the
 * credential document the client reads. Declared twice, either would drift into
 * two names for one thing.
 *
 * Type declarations and constants only: no runtime code reaches a bundle
 * through this file except the two string literals, which is what the
 * declaration is for.
 */

/** The name the installation's Global contacts address book carries. */
export const GLOBAL_CONTACTS_BOOK_NAME = "Global contacts";

/** The document holding per-identity SIP credentials in an account's app folder. */
export const SIP_CREDENTIALS_FILE = "sip.json";

/** The schema this build writes into that document. */
export const SIP_CREDENTIALS_VERSION = 1;

/** One identity's SIP credential (ADR 0023). */
export interface SipCredential {
  /** The address of record, `sip:user@domain` or a bare address. */
  address: string;
  /** The secret the registrar authenticates it with. */
  password: string;
}

/**
 * The credential document: one credential per identity, keyed by the identity's
 * email — which is what the account's own administration names an identity by,
 * and stable across identity re-creation in a way an id is not.
 */
export interface SipCredentialsDocument {
  version: number;
  identities: Record<string, SipCredential>;
}

/** Whether a stored value is a usable credential. */
export function isSipCredential(value: unknown): value is SipCredential {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SipCredential).address === "string" &&
    typeof (value as SipCredential).password === "string"
  );
}
