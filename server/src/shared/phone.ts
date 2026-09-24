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

/** Whether a stored value is a usable credential. */
export function isSipCredential(value: unknown): value is SipCredential {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SipCredential).address === "string" &&
    typeof (value as SipCredential).password === "string"
  );
}

/**
 * Read a credential document into its map, keyed by lower-cased identity email.
 *
 * The one parser both tiers use: the account reads its own document to
 * register, the administration reads the same document to show what an
 * identity holds. Malformed, absent or shapeless all answer the empty map —
 * "no credential" is a state, not a fault.
 */
export function parseSipCredentials(raw: unknown): Record<string, SipCredential> {
  if (typeof raw !== "object" || raw === null) return {};
  const identities = (raw as SipCredentialsDocument).identities;
  if (typeof identities !== "object" || identities === null) return {};
  const out: Record<string, SipCredential> = {};
  for (const [key, value] of Object.entries(identities))
    if (isSipCredential(value)) out[key.trim().toLowerCase()] = value;
  return out;
}

/**
 * The document after one identity's credential is set or cleared.
 *
 * `null`, or an empty address, removes the entry: an identity with no SIP
 * address is one the phone does not register, which is a state rather than a
 * credential of blanks. The one place a credential enters or leaves the
 * document, so the writer cannot spell the shape a second way.
 */
export function withSipCredential(
  current: Record<string, SipCredential>,
  email: string,
  credential: SipCredential | null,
): SipCredentialsDocument {
  const identities = { ...current };
  const key = email.trim().toLowerCase();
  const address = credential?.address?.trim() ?? "";
  if (credential && address) identities[key] = { address, password: credential.password };
  else delete identities[key];
  return { version: SIP_CREDENTIALS_VERSION, identities };
}
