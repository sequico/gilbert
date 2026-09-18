/**
 * The client's settings document, named once for both tiers.
 *
 * `settings.json` in an account's own app folder is the client's document, and
 * the client writes it whole on every save: a key its own schema does not own
 * does not survive the next save (which is why the identity lock is a file of
 * its own, `server/src/account.ts`). The exception is the one key the *server*
 * writes into it — the default sending identity an administrator sets
 * (ADR 0007) — and that key is a contract rather than a name: a client that
 * stops reading it loses the choice the administration made, and a server that
 * stops writing it makes that setting do nothing while looking healthy.
 *
 * So both strings are declared here, and both tiers import them: the file name
 * is what a reader of one tier opens and the other writes, and the key is the
 * one place the two tiers touch the same document.
 *
 * Constants only: no runtime code reaches a bundle through this file.
 */

/** The document the client keeps its settings in, inside the app folder. */
export const SETTINGS_FILE = "settings.json";

/**
 * The settings key naming the identity an account sends from by default.
 *
 * A field of the client's own `Settings` schema, keyed by account id, and the
 * one key in that document this server both reads and writes.
 */
export const DEFAULT_IDENTITY_KEY = "defaultIdentityByAccount";
