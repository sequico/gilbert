/**
 * The installation document: read it, and create it when it is absent.
 *
 * The document itself — its sections, its defaults and the environment
 * variable each default came from — is `shared/installation.ts`, because the
 * web tier reads the same shape. This module is the server's half: where the
 * document lives, how it is read, and the one write this code does on its own
 * (the first boot, which creates it).
 *
 * **It signs in as nothing.** The JMAP access arrives as an injected
 * dependency (`InstallationStore`), which is what lets the boot's ordering be
 * the boot's business (`bootstrap.ts`): the Master's session is opened there,
 * once, and handed here.
 *
 * The store the boot uses is an app folder in the account's own Files
 * (`appFolder.ts`) — the same place the synced settings, the published policy
 * and the agent's documents live. An installation's configuration is durable
 * exactly because it is one more document in Stalwart: nothing about it lives
 * on the container, so replacing the container loses nothing. That is the
 * whole point, and it is why the app secret is written here rather than passed
 * in.
 */

import { randomBytes } from "node:crypto";
import {
  appFolderState,
  type Ctx,
  ensureAppFolder,
  filesAccountId,
  readAppFileAt,
  writeAppFileIn,
} from "./appFolder.js";
import { errorMessage } from "./shared/errors.js";
import {
  INSTALLATION_EPOCH_START,
  INSTALLATION_FILE,
  INSTALLATION_VERSION,
  type InstallationDocument,
  installationDefaults,
  isUsableAppSecret,
  parseInstallationDocumentDetailed,
} from "./shared/installation.js";

/**
 * A log line, one per event worth reading at boot.
 *
 * The boot has no HTTP surface and no port yet, so a line here and an exit
 * code are the only channels there are.
 */
export type InstallationLog = (line: string) => void;

/**
 * Where the installation document is read from and written to.
 *
 * The dependency the boot injects, and the seam the tests use: everything this
 * module needs from Stalwart is these four things and nothing else.
 */
export interface InstallationStore {
  /** The account the document belongs to; named in every message this module writes. */
  readonly accountId: string;
  /** The document's own bytes as stored, or null when there is no document. */
  read(): Promise<string | null>;
  /** The account's FileNode state: the compare-and-set token a conditional write carries. */
  state(): Promise<string>;
  /** Write the whole document, conditionally on `ifInState` when one is given. */
  write(doc: InstallationDocument, opts?: { ifInState?: string }): Promise<void>;
}

/** A refusal from this module: the boot cannot go on until a person acts. */
export class InstallationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationError";
  }
}

/** Where the document is, in words, for a message an operator reads. */
export function installationLocation(accountId: string): string {
  return `gilbert/${INSTALLATION_FILE} in account ${accountId || "(unknown)"}`;
}

/**
 * The app-folder store for one signed-in session — in practice the Master's.
 *
 * The account is resolved from the session itself (`filesAccountId`, the same
 * door the client uses for the settings document), so the document lands in
 * the account's own Files and is readable by whoever holds that account, which
 * is what "the installation's own account" means on Stalwart's side.
 */
export function appFolderInstallationStore(ctx: Ctx): InstallationStore {
  const accountId = filesAccountId(ctx);
  if (!accountId)
    throw new InstallationError(
      "The session that signed in has no Files account, so the installation document has nowhere to live. " +
        "Every account on this Stalwart should have one; check the server's version and the principal's capabilities.",
    );
  return {
    accountId,
    async read() {
      const found = await readAppFileAt(ctx, accountId, INSTALLATION_FILE);
      return found ? found.text : null;
    },
    async state() {
      return appFolderState(ctx, accountId);
    },
    async write(doc, opts) {
      // The app folder's own top level, where the settings-shaped documents
      // live: this one is read before any account has been opened, so it must
      // not be inside a tree that a first boot has not created yet.
      const folderId = await ensureAppFolder(ctx, accountId);
      await writeAppFileIn(ctx, accountId, folderId, INSTALLATION_FILE, doc, opts);
    },
  };
}

/**
 * A fresh app secret.
 *
 * 32 bytes, base64 — the same secret `config.ts` generated for a development
 * boot, and the same one an operator would have put in `APP_SECRET`. It is the
 * key sessions are sealed with and the salt is derived from, so it is written
 * into the document and never printed.
 */
export function generateAppSecret(): string {
  return randomBytes(32).toString("base64");
}

/** The document as it was read, and whether this call is the one that created it. */
export interface LoadedInstallation {
  document: InstallationDocument;
  /** True when this boot wrote the document: the first boot of the installation. */
  created: boolean;
  /** The account it was read from or written to. */
  accountId: string;
}

/**
 * Read the installation document, creating it on the first boot.
 *
 * A document that is **absent** is created: the defaults, an epoch to write
 * from, and a generated app secret, which is the one value that must not be a
 * literal anywhere and must not change between boots (a secret that changed
 * would sign every session out on every redeploy — the failure this document
 * exists to prevent).
 *
 * A document that is **there but unreadable** is refused, loudly, and left
 * exactly as it is. Replacing it with the defaults would look like a
 * successful boot and would silently discard an installation's configuration —
 * its routing table, its agent, its secret — which is the one outcome worse
 * than not starting.
 */
export async function readInstallation(
  store: InstallationStore,
  opts: { log?: InstallationLog } = {},
): Promise<LoadedInstallation> {
  const log = opts.log ?? (() => {});
  const where = installationLocation(store.accountId);
  const stored = await store.read().catch((err: unknown) => {
    throw new InstallationError(
      `The installation document (${where}) could not be read: ${errorMessage(err)}`,
    );
  });

  if (stored !== null)
    return {
      document: requiredDocument(stored, where),
      created: false,
      accountId: store.accountId,
    };

  const fresh = installationDefaults();
  fresh.epoch = INSTALLATION_EPOCH_START;
  fresh.secret = generateAppSecret();
  await store.write(fresh);

  /*
   * Read back what the store now holds.
   *
   * A first write cannot be made conditional: there is no state to compare
   * against, because the write that creates the folder the document sits in is
   * what moves the account's FileNode state. So two boots starting at once — a
   * rolling deploy brings the second container up before the first has
   * finished — can both create, and the second write wins. The stored document
   * is the one that counts: if it carries a different secret, this instance
   * must sign with that one, or half the sessions would be sealed with a key
   * nothing else has. Cheap (one extra read, on the first boot only) and the
   * alternative is silent.
   */
  const after = await store.read();
  if (after !== null) {
    const parsed = parseInstallationDocumentDetailed(after);
    if ("doc" in parsed && parsed.doc.secret !== fresh.secret) {
      log(
        `[gilbert] installation: ${where} was created by another boot while this one was starting; using the secret already stored`,
      );
      return { document: parsed.doc, created: false, accountId: store.accountId };
    }
  }

  log(
    `[gilbert] installation: created ${where} with the defaults and a freshly generated app secret — ` +
      "it is stored in the account's own Files, so a redeploy keeps it (nothing prints the secret)",
  );
  return { document: fresh, created: true, accountId: store.accountId };
}

/**
 * Write the document whole, with the next epoch, conditionally on a state when
 * one is given.
 *
 * The compare-and-set is the whole coordination JMAP offers here: a caller
 * that read the document at a FileNode state and writes with that token has
 * its write refused (`stateMismatch`) when anything in the account changed in
 * between, rather than overwriting a change it never saw. `epoch` makes the
 * same thing readable afterwards — a copy of the document says which write it
 * came from.
 */
export async function writeInstallation(
  store: InstallationStore,
  document: InstallationDocument,
  opts: { ifInState?: string } = {},
): Promise<InstallationDocument> {
  if (!Number.isInteger(document.epoch) || document.epoch < INSTALLATION_EPOCH_START)
    throw new InstallationError(
      `The document's epoch (${document.epoch}) is not a number this installation can write from.`,
    );
  const next: InstallationDocument = {
    ...document,
    version: INSTALLATION_VERSION,
    epoch: document.epoch + 1,
  };
  if (!isUsableAppSecret(next.secret))
    throw new InstallationError(
      "Refusing to write an installation document with no app secret: every stored session is sealed with it, " +
        "and an empty or placeholder value would sign everyone out at the next restart.",
    );
  await store.write(next, opts);
  return next;
}

/**
 * The stored text as a document, or a refusal saying what is wrong with it.
 *
 * "Unreadable" is one answer with two causes — not a document at all, or a
 * document without a secret — and both are refusals rather than a fallback.
 */
function requiredDocument(text: string, where: string): InstallationDocument {
  const parsed = parseInstallationDocumentDetailed(text);
  if ("problem" in parsed)
    throw new InstallationError(
      `The installation document (${where}) is not readable: ${parsed.problem} ` +
        "It has been left exactly as it is — fix it where it lives, or remove it to have the defaults written again; " +
        "booting from the defaults instead would silently discard this installation's configuration.",
    );
  if (!isUsableAppSecret(parsed.doc.secret))
    throw new InstallationError(
      `The installation document (${where}) carries no app secret. Sessions are sealed with that secret, so a boot ` +
        'cannot invent one: it would sign every stored session out. Write a long random value into "secret", or ' +
        "remove the document to have a new installation created with one.",
    );
  return parsed.doc;
}
