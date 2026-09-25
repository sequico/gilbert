/**
 * The constants and shapes of the phone feature both tiers read (ADR 0023,
 * ADR 0024).
 *
 * The name of the installation's shared directory and the document an account
 * holds its per-identity SIP accounts in are decisions, not one tier's private
 * spelling: the client draws and dials Global contacts by that name, the server
 * ensures the book carries it, and the administrator writes the credential
 * document the client reads. Declared twice, either would drift into two names
 * for one thing.
 *
 * Type declarations and constants only: no runtime code reaches a bundle
 * through this file except the string literals and the small parsers, which is
 * what the declaration is for.
 */

/** The name the installation's Global contacts address book carries. */
export const GLOBAL_CONTACTS_BOOK_NAME = "Global contacts";

/** The document holding per-identity SIP accounts in an account's app folder. */
export const SIP_CREDENTIALS_FILE = "sip.json";

/** The schema this build writes into that document. */
export const SIP_CREDENTIALS_VERSION = 2;

/**
 * The media port range the bridge opens inbound (ADR 0023).
 *
 * The one thing a deployment must open for the phone: the administration shows
 * this range, and the deployment's Janus is configured to it. Declared once so
 * the line an administrator reads and the bridge's own configuration cannot
 * drift apart without changing here.
 */
export const BRIDGE_MEDIA_PORTS = "10000-10200";

/**
 * The port the bridge's STUN responder listens on (ADR 0023).
 *
 * The browser asks it for the address the network gives it, so ICE has a
 * server-reflexive candidate for this bridge instead of relying only on
 * peer-reflexive discovery. Declared once: the client's `iceServers`, the
 * responder's own configuration and the line an administrator reads all come
 * from here.
 */
export const BRIDGE_STUN_PORT = 3478;

/**
 * One identity's SIP account (ADR 0023).
 *
 * A server, a user name and a password — the three things a registrar asks
 * for. Nothing here is the address of record: `sip:<username>@<server>` is
 * derived from these, so a deployment states each part once and the phone
 * cannot register at one server while being known by another.
 */
export interface SipCredential {
  /** The registrar's host: `pbx.example.com` or `pbx.example.com:5061`. */
  server: string;
  /** The user the registrar authenticates. */
  username: string;
  /** The secret it authenticates with; empty where the registrar asks for none. */
  password: string;
}

/**
 * The credential document: one account per identity, keyed by the identity's
 * email — which is what the account's own administration names an identity by,
 * and stable across identity re-creation in a way an id is not.
 */
export interface SipCredentialsDocument {
  version: number;
  identities: Record<string, SipCredential>;
}

/**
 * What an administrator types for one Global contacts card (ADR 0024).
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

/** Whether a stored value is a usable account: a server and a user name. */
export function isSipCredential(value: unknown): value is SipCredential {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SipCredential).server === "string" &&
    typeof (value as SipCredential).username === "string" &&
    typeof (value as SipCredential).password === "string"
  );
}

/**
 * Read a credential document into its map, keyed by lower-cased identity email.
 *
 * The one parser both tiers use: the server reads the document to register, the
 * administration reads the same document to show what an identity holds.
 * Malformed, absent or shapeless all answer the empty map — "no credential" is
 * a state, not a fault. A document in an earlier shape (an `address`/`password`
 * pair) is not this shape and reads as empty: the schema changed deliberately,
 * and the next write replaces it with the current one.
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
 * The document after one identity's account is set or cleared.
 *
 * `null`, or an entry that names no server or no user, removes it: an identity
 * that names nothing to register with is one the phone does not register, which
 * is a state rather than an account of blanks. The one place an account enters
 * or leaves the document, so the writer cannot spell the shape a second way.
 */
export function withSipCredential(
  current: Record<string, SipCredential>,
  email: string,
  credential: SipCredential | null,
): SipCredentialsDocument {
  const identities = { ...current };
  const key = email.trim().toLowerCase();
  const server = credential?.server?.trim() ?? "";
  const username = credential?.username?.trim() ?? "";
  if (credential && server && username)
    identities[key] = { server, username, password: credential.password };
  else delete identities[key];
  return { version: SIP_CREDENTIALS_VERSION, identities };
}
