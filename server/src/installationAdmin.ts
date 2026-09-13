/**
 * The installation's own document, as the administration surface reads and
 * publishes it.
 *
 * `bootstrap.ts` reads the document once, at boot, and hands it to `config.ts`;
 * this module is the administrator's door onto the same file. It signs in as
 * nothing — the caller's `Ctx` arrives as an argument, the way every other
 * store here takes one — and it serves nothing: each function returns a result
 * and `app.ts` owns the HTTP shape. The document's rules stay where they
 * already are: validation is `shared/installation.ts`'s validator (the boot's
 * own) and the write is `installation.ts`'s `writeInstallation`, so a publish
 * cannot produce a document this build would refuse to boot from.
 *
 * Two facts every answer carries, because they are the ones an administrator
 * would otherwise have to guess:
 *
 * - **Where** it lives. `filesAccountId` is the account the caller's own
 *   session holds — the account the client's documents live in — so the
 *   document is read from and written to the administrator's own `gilbert` app
 *   folder. For the session that signs in as the Master (ADR 0003), which is
 *   the account the boot reads, that is exactly the document the installation
 *   runs on; an administrator who is not that account is publishing into their
 *   own Files, and every answer names the account it acted on rather than
 *   implying more.
 * - **When** a publish applies. Nothing here reloads `config.ts`: the running
 *   process keeps the configuration it booted with, and the next boot reads
 *   what was just written. That is said in words rather than reported as a
 *   success with no time in it, because "saved" and "in force" are different
 *   claims and only the second is what an administrator is being asked to
 *   believe.
 *
 * A refusal is a value, never a throw: the one refusal this module can meet
 * before it reaches Stalwart — an account with no Files to hold the document —
 * is a fact about the account, and a surface that answered a 500 for it would
 * report a bug where there is an installation nobody can administer yet.
 */
import { type Ctx, filesAccountId, readAppFileAt } from "./appFolder.js";
import { agentAddress } from "./config.js";
import {
  appFolderInstallationStore,
  InstallationError,
  type InstallationStore,
  installationLocation,
  writeInstallation,
} from "./installation.js";
import { normalizeUsername } from "./sessions.js";
import { appDocumentJson } from "./shared/appDocument.js";
import {
  INSTALLATION_FILE,
  type InstallationDocument,
  isUsableAppSecret,
  parseInstallationDocumentDetailed,
} from "./shared/installation.js";

/**
 * Whether the account an answer is about is the one the installation's boot
 * reads its document from.
 *
 * `GILBERT_AGENT_ADDRESS` names the Master — the account `bootstrap.ts` signs
 * in as, and the one whose `gilbert` app folder the document is read from — and
 * `config.agent.address` is that same value in a process that booted. An
 * administrator whose session is not that account is still publishing a real
 * document, into a real account; what the answer must not do is let them
 * believe the installation boots from it. A deployment that named no Master at
 * all (a test, a tool, a process that never booted) has no answer, which is
 * `"unknown"` rather than a `"no"` — the same reason `bootstrap.ts` refuses to
 * start without the handshake.
 */
export type BootsFrom = "yes" | "no" | "unknown";

export function bootDocumentAccount(address: string, master = agentAddress()): BootsFrom {
  const named = normalizeUsername(master);
  if (!named) return "unknown";
  return normalizeUsername(address) === named ? "yes" : "no";
}

/**
 * A refusal, as the route answers it: a status, a machine-readable code and a
 * message meant for the administrator.
 */
export interface InstallationRefused {
  status: 400 | 409 | 502;
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
  /** The account whose app folder it lives in. */
  account: string;
  /** The Master's own address — the account a boot signs in as — or null when this deployment named none. */
  master: string | null;
  /** Whether the account on screen is that Master's, whose own document a boot reads. */
  bootsFrom: BootsFrom;
  /** The same, in the words a message uses: `gilbert/installation.json in account …`. */
  location: string;
}

/** What a publish wrote, and when it applies. */
export interface InstallationPublished {
  /** The account whose app folder now holds the document. */
  account: string;
  /** The Master's own address — the account a boot signs in as — or null when this deployment named none. */
  master: string | null;
  /** Whether the account just written to is that Master's, whose own document a boot reads. */
  bootsFrom: BootsFrom;
  /** Where that is, in words. */
  location: string;
  /** The document as it is now stored: byte for byte what the next read returns. */
  document: string;
  /** The epoch the stored document carries. Every write takes the next one. */
  epoch: number;
  /**
   * When it takes effect: the document is read at boot, so a publish is never
   * live in the process that made it. `bootsFrom` says whether this account is
   * the one a boot reads — the answer for the account the installation signs
   * in as — and the message names the Master instead when it is not.
   */
  applies: "next-boot";
  /** The same answer as one sentence, for the surface to show as it is. */
  message: string;
}

/** Read the document, or a refusal when there is nowhere to read it from. */
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
        ...whereThisIs(ctx),
        location: where,
      },
    };
  return {
    view: {
      present: true,
      document: found.text,
      problem: readingProblem(found.text),
      account: accountId,
      ...whereThisIs(ctx),
      location: where,
    },
  };
}

/**
 * Which account holds the document, and whether a boot reads that account's
 * own copy. Part of every answer, because an administrator whose session is
 * not the Master's is otherwise reading a document that looks authoritative
 * and is not the one the installation runs on.
 */
function whereThisIs(ctx: Ctx): { master: string | null; bootsFrom: BootsFrom } {
  const master = agentAddress();
  return { master: master || null, bootsFrom: bootDocumentAccount(ctx.username) };
}

/**
 * Validate one document text and write it into the caller's own app folder.
 *
 * The order is the policy publisher's order (`adminPolicy.ts`, ADR 0001) and
 * for the same reason: a document that is not one is refused **before**
 * anything is written, so a typo cannot replace a working installation's
 * configuration with a copy the next boot would refuse. `writeInstallation` is
 * the writer rather than a second one, so the two rules it owns apply here
 * too — the epoch moves on by one, and a document with no usable app secret is
 * refused rather than written (every stored session is sealed with that
 * secret).
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

  let written: InstallationDocument;
  try {
    written = await writeInstallation(store, parsed.doc);
  } catch (err) {
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
        message: `The installation document could not be written to ${installationLocation(store.accountId)}: ${messageOf(err)}`,
      },
    };
  }

  const where = installationLocation(store.accountId);
  const whereThisIsRead = whereThisIs(ctx);
  /*
   * What was written, and when it applies. A publish from an account the boot
   * does not sign in as is still a real document in a real account, but saying
   * "the next boot reads what was just written" of it would be a lie about
   * which account the installation boots from, so the answer names the Master
   * when the two differ.
   */
  const applies =
    whereThisIsRead.bootsFrom === "no"
      ? `Written to ${where}. This process keeps the configuration it booted with — the document is read at ` +
        `boot — but this installation's boot signs in as the Master, ${whereThisIsRead.master}, whose own ` +
        "document is the one it reads: what you just published is stored in this account, where a boot that " +
        "signs in as it reads it."
      : `Written to ${where}. This process keeps the configuration it booted with — the document is read at ` +
        "boot — so what you just published applies from the next boot of this installation, and nothing in " +
        "the running one has changed.";
  return {
    published: {
      account: store.accountId,
      ...whereThisIsRead,
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
