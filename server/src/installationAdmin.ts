/**
 * The installation's own document, as the administration surface reads and
 * publishes it.
 *
 * `bootstrap.ts` reads the document once, at boot, and hands it to `config.ts`;
 * this module is the administrator's door onto the same file. It signs in as
 * nothing — the `Ctx` arrives as an argument — but the context it is handed
 * **is the Master's**: `app.ts` reaches that account by the same impersonation
 * the policy publish uses (`impersonateAs`), so what is read and written here
 * is the document the next boot of this installation runs on, whoever is doing
 * the administering. A deployment that names no Master has no such account,
 * and `app.ts` refuses the door as a value rather than opening it onto somebody
 * else's Files. It serves nothing: each function returns a result and `app.ts`
 * owns the HTTP shape. The document's rules stay where they already are:
 * validation is `shared/installation.ts`'s validator (the boot's own) and the
 * write is `installation.ts`'s `writeInstallation`, so a publish cannot produce
 * a document this build would refuse to boot from.
 *
 * Two facts every answer carries, because they are the ones an administrator
 * would otherwise have to guess:
 *
 * - **Where** it lives. `account` is the Files account the document was read
 *   from or written to, `master` is the address that account belongs to — the
 *   one the installation signs in as at boot (ADR 0003) — and `location` says
 *   it in words. There is no longer a case in which this is *not* the
 *   installation's own document: a deployment with no Master to read from is
 *   refused before anything is read or written.
 * - **When** a publish applies. Nothing here reloads `config.ts`: the running
 *   process keeps the configuration it booted with, and the next boot reads
 *   what was just written. That is said in words rather than reported as a
 *   success with no time in it, because "saved" and "in force" are different
 *   claims and only the second is what an administrator is being asked to
 *   believe.
 *
 * The write is conditional in two directions, and neither of them trusts the
 * text that was submitted. It carries the state the account states **after**
 * its app folder is known to exist — creating that folder is itself a write,
 * and a token read before it would make this publish lose a race with its own
 * folder creation — so a document that moved is refused with its own code and
 * the stored document is left exactly as it was. And the epoch it writes from
 * is the *stored* document's, so a save made from a stale editor cannot move
 * the stored epoch backwards.
 *
 * A refusal is a value, never a throw: the one refusal this module can meet
 * before it reaches Stalwart — an account with no Files to hold the document —
 * is a fact about the account, and a surface that answered a 500 for it would
 * report a bug where there is an installation nobody can administer yet.
 */
import { type Ctx, ensureAppFolder, filesAccountId, readAppFileAt } from "./appFolder.js";
import {
  appFolderInstallationStore,
  InstallationError,
  type InstallationStore,
  installationLocation,
  writeInstallation,
} from "./installation.js";
import { isStateMismatch } from "./jmap.js";
import { appDocumentJson } from "./shared/appDocument.js";
import {
  INSTALLATION_EPOCH_START,
  INSTALLATION_FILE,
  type InstallationDocument,
  isUsableAppSecret,
  parseInstallationDocumentDetailed,
} from "./shared/installation.js";

/**
 * A refusal, as the route answers it: a status, a machine-readable code and a
 * message meant for the administrator.
 *
 * The statuses are the ones this surface can answer with: a document that is
 * not one (400), an account this session may not act as (403, 404), a
 * deployment with no Master to read from or an account with nowhere to keep the
 * document (409), and Stalwart refusing to read or write (502).
 */
export interface InstallationRefused {
  status: 400 | 403 | 404 | 409 | 502;
  error: string;
  message: string;
}

/**
 * The document as the account holds it.
 *
 * `present` is the question "is there one at all" answered on its own, because
 * an installation that has never booted has no document and an administrator
 * needs to be told that rather than shown an empty editor that looks like a
 * document somebody wiped.
 */
export interface InstallationView {
  /** Whether the account holds a document at all. */
  present: boolean;
  /** The document byte for byte as it is stored, or null when there is none. */
  document: string | null;
  /**
   * Why a boot would refuse the stored document, or null when it would not.
   *
   * The judgement is the boot's own (`installation.ts`'s reader): the text is
   * not a document, or it carries no app secret. The text is still handed back
   * with it — a document that cannot be read is exactly the one a person has
   * to repair, and hiding it would leave the editor as the only place it
   * exists.
   */
  problem: string | null;
  /** The Files account whose app folder holds it — the Master's own, reached by impersonation. */
  account: string;
  /** The address that account belongs to: the Master whose own document a boot reads. */
  master: string;
  /** Where it is, in words: `gilbert/installation.json in account …`. */
  location: string;
}

/** What a publish wrote, and when it applies. */
export interface InstallationPublished {
  /** The Files account whose app folder now holds the document. */
  account: string;
  /** The address that account belongs to: the Master whose own document a boot reads. */
  master: string;
  /** Where that is, in words. */
  location: string;
  /** The document as it is now stored: byte for byte what the next read returns. */
  document: string;
  /** The epoch the stored document carries. Every write takes the next one. */
  epoch: number;
  /**
   * When it takes effect: the document is read at boot, so a publish is never
   * live in the process that made it.
   */
  applies: "next-boot";
  /** The same answer as one sentence, for the surface to show as it is. */
  message: string;
}

/** Read the document the boot reads, or a refusal when there is nowhere to read it from. */
export async function readInstallationForAdmin(
  ctx: Ctx,
): Promise<{ view: InstallationView } | { refused: InstallationRefused }> {
  const accountId = filesAccountId(ctx);
  if (!accountId) return { refused: noFilesAccount() };
  const where = installationLocation(accountId);

  let found: Awaited<ReturnType<typeof readAppFileAt>>;
  try {
    found = await readAppFileAt(ctx, accountId, INSTALLATION_FILE);
  } catch (err) {
    return {
      refused: {
        status: 502,
        error: "read_failed",
        message: `The installation document (${where}) could not be read: ${messageOf(err)}`,
      },
    };
  }

  if (!found)
    return {
      view: {
        present: false,
        document: null,
        problem: null,
        account: accountId,
        master: ctx.username,
        location: where,
      },
    };
  return {
    view: {
      present: true,
      document: found.text,
      problem: readingProblem(found.text),
      account: accountId,
      master: ctx.username,
      location: where,
    },
  };
}

/**
 * Validate one document text and write it into the account a boot reads.
 *
 * The order is the policy publisher's order (`adminPolicy.ts`, ADR 0001) and
 * for the same reason: a document that is not one is refused **before**
 * anything is written, so a typo cannot replace a working installation's
 * configuration with a copy the next boot would refuse. `writeInstallation` is
 * the writer rather than a second one, so the two rules it owns apply here too
 * — the epoch moves on by one, and a document with no usable app secret is
 * refused rather than written (every stored session is sealed with that
 * secret).
 *
 * The epoch is **derived, not accepted**: the document handed to the writer
 * carries the epoch of the text the account holds right now, whatever the
 * submitted text says in its own `epoch` field. A save from an editor opened
 * before somebody else's publish therefore cannot move the stored epoch
 * backwards — it moves it on by one from what is really there.
 *
 * The write is conditional on the account's own FileNode state, read after the
 * app folder is known to exist (creating that folder is itself a write, and a
 * token read before it would make this publish lose a race with its own folder
 * creation — the reason `AgentStore.provision` runs before a worker's first
 * conditional write, and why the policy publish reads its token there too). A
 * document that moved after that read is refused with its own code, and the
 * stored document keeps every byte and every epoch it had: nothing is
 * overwritten silently. An account that will not state its state at all is
 * refused as well, because a write that cannot be told the document moved is a
 * write that can replace one this publish never saw.
 *
 * What comes back says what happened and when it applies; nothing about the
 * running process is reloaded and no session is invalidated, because nothing
 * about the running process changed.
 */
export async function publishInstallation(
  ctx: Ctx,
  raw: string,
): Promise<{ published: InstallationPublished } | { refused: InstallationRefused }> {
  const parsed = parseInstallationDocumentDetailed(raw);
  if ("problem" in parsed)
    return {
      refused: {
        status: 400,
        error: "invalid_installation",
        message: parsed.problem,
      },
    };

  let store: InstallationStore;
  try {
    // Refuses (InstallationError) when this account has no Files to hold the
    // document: a fact about the account, answered rather than thrown.
    store = appFolderInstallationStore(ctx);
  } catch (err) {
    if (err instanceof InstallationError) return { refused: noFilesAccount() };
    return {
      refused: {
        status: 502,
        error: "upstream_error",
        message: `The installation document could not be written: ${messageOf(err)}`,
      },
    };
  }

  const where = installationLocation(store.accountId);

  // What is stored now — the epoch this write moves on from. Read before
  // anything is written, so no failure between here and the write can leave
  // the stored document disagreeing with the epoch this publish reports.
  let stored: string | null;
  try {
    stored = await store.read();
  } catch (err) {
    return {
      refused: {
        status: 502,
        error: "read_failed",
        message: `The installation document (${where}) could not be read: ${messageOf(err)}`,
      },
    };
  }

  /*
   * The app folder first, then the state: creating that folder is a write that
   * moves the account's FileNode state, so a token read before it exists would
   * refuse this publish's own conditional write. `ensureAppFolder` is the
   * writer's own step (`installation.ts`'s store runs it before every write),
   * taken here so the token below describes the folder the write is about to
   * land in.
   */
  try {
    await ensureAppFolder(ctx, store.accountId);
  } catch (err) {
    return {
      refused: {
        status: 502,
        error: "write_failed",
        message: `The installation document could not be written to ${where}: ${messageOf(err)}`,
      },
    };
  }

  let state: string;
  try {
    state = await store.state();
  } catch (err) {
    return {
      refused: {
        status: 502,
        error: "write_failed",
        message: `The installation document could not be written to ${where}: ${messageOf(err)}`,
      },
    };
  }
  if (!state)
    return {
      refused: {
        status: 502,
        error: "no_state",
        message:
          `The account holding the installation document (${where}) would not state the state of its Files, ` +
          "so this write could not be made conditional — and a write that cannot be refused when the " +
          "document moved is a write that can replace one somebody else just made. Nothing was written.",
      },
    };

  let written: InstallationDocument;
  try {
    written = await writeInstallation(
      store,
      { ...parsed.doc, epoch: storedEpoch(stored) },
      { ifInState: state },
    );
  } catch (err) {
    if (isStateMismatch(err))
      return {
        refused: {
          status: 409,
          error: "installation_moved",
          message:
            `The installation document (${where}) moved while this publish was in flight: the account ` +
            "changed after the state this write carried was read, so nothing was written. What is stored " +
            "there now is the document somebody else wrote — read it again and publish what you mean to " +
            "replace.",
        },
      };
    if (err instanceof InstallationError)
      return {
        refused: {
          status: 400,
          error: "invalid_installation",
          message: err.message,
        },
      };
    return {
      refused: {
        status: 502,
        error: "write_failed",
        message: `The installation document could not be written to ${where}: ${messageOf(err)}`,
      },
    };
  }

  const applies =
    `Written to ${where}. This process keeps the configuration it booted with — the document is read at ` +
    "boot — so what you just published applies from the next boot of this installation, and nothing in " +
    "the running one has changed.";
  return {
    published: {
      account: store.accountId,
      master: ctx.username,
      location: where,
      // The bytes the store was handed, which is what a read reads back
      // (`appDocumentJson` is the one JSON writer for an app-folder document).
      document: appDocumentJson(written),
      epoch: written.epoch,
      applies: "next-boot",
      message: applies,
    },
  };
}

/**
 * The epoch the stored text carries, which is what the next write moves on from.
 *
 * The document's own reader is asked first, so a stored document this build
 * can boot from answers with the epoch a boot would see — including the
 * default, for a document that states none. A document that is **there but
 * unreadable** is the case a person comes to this surface to repair, and it
 * still has an epoch when it states one a write can move on from: reading it
 * off directly keeps a repair from resetting the count. Anything else — no
 * document at all, text that is not JSON, a number no write could move on from
 * — starts from the epoch a first document starts at.
 */
function storedEpoch(text: string | null): number {
  const parsed = parseInstallationDocumentDetailed(text ?? "");
  if ("doc" in parsed) return parsed.doc.epoch;
  try {
    const raw = JSON.parse(text ?? "") as { epoch?: unknown };
    const epoch = raw?.epoch;
    if (
      typeof epoch === "number" &&
      Number.isInteger(epoch) &&
      epoch >= INSTALLATION_EPOCH_START
    )
      return epoch;
  } catch {
    /* not JSON at all: there is no epoch to move on from */
  }
  return INSTALLATION_EPOCH_START;
}

/**
 * Why a boot would refuse this text, or null when it would not.
 *
 * The two halves are `installation.ts`'s reader: the shared validator, and the
 * app secret that might not be one. The messages are this module's, because
 * they are shown beside the document rather than logged at a boot that has no
 * port to report through.
 */
function readingProblem(text: string): string | null {
  const parsed = parseInstallationDocumentDetailed(text);
  if ("problem" in parsed) return parsed.problem;
  if (!isUsableAppSecret(parsed.doc.secret))
    return (
      'The document carries no app secret in "secret", so a boot would refuse it: ' +
      "every stored session is sealed with that secret, and an empty or placeholder value would sign " +
      "everyone out at the next restart."
    );
  return null;
}

/** The refusal an account with nowhere to keep the document gets. */
function noFilesAccount(): InstallationRefused {
  return {
    status: 409,
    error: "no_files_account",
    message:
      "This account has no Files account to hold the installation document, so there is nowhere to read " +
      "it from or write it to. Every account on this Stalwart should have one; check the server's version " +
      "and the principal's capabilities.",
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
