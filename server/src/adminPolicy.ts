import { type Ctx, readAppJsonAt, writeAppFile } from "./appFolder.js";
import { isStateMismatch } from "./jmap.js";
import { isRecord } from "./shared/json.js";
import {
  PUBLISH_JOB_FILE,
  type PublishJob,
  type PublishUnreached,
} from "./shared/publishJob.js";

/*
 * The document's name is re-exported, so a module that reads a job through the
 * reader that lives here names the file here. The job's *shape* is not: it is
 * `shared/publishJob.ts`, and `app.ts` imports it from there.
 */
export { PUBLISH_JOB_FILE };

/**
 * The installation-wide settings policy, as the administration surface edits
 * it (ADR 0001), and the job each publish records about itself.
 *
 * The policy is `{ defaults, enforced, changes }` (issue #207), published into
 * every individual account's own app folder rather than kept in one file or
 * environment variable — see `writeAccountPolicy`/`readAccountPolicy` below.
 * An account no publish has reached carries no document at all, which is what
 * its reader reports as this empty policy. A copy a publish did write carries
 * `published` as well: which job wrote it, and when, so the account can be
 * compared against the job's record.
 *
 * The job (`PublishJob`) is one document per publishing administrator, in that
 * administrator's own app folder: what one publish reached, what it did not and
 * why, and the population it measured itself against. It lives in the account
 * rather than in the process, so the administration reads the same answer after
 * a restart as the publish that made it answered with.
 */

export interface PolicyChangeDocument {
  version: string;
  settings: Record<string, unknown>;
}

/**
 * Which publish put this copy of the policy into the account.
 *
 * Every account's document says which job wrote it and when, so "the policy I
 * am following" and "the publish that reached me" are the same fact: an
 * administrator comparing an account against a job can tell a copy that job
 * made from one an earlier one left, and a copy a job's conditional write was
 * refused for keeps the id of the publish it really came from.
 */
export interface PolicyPublished {
  /** The publishing job's id: the same one the job document carries. */
  id: string;
  /** When that publish started, as the job recorded it. */
  at: string;
}

export interface PolicyDocument {
  defaults: Record<string, unknown>;
  enforced: Record<string, unknown>;
  changes: PolicyChangeDocument[];
  /**
   * Absent on a document no publish wrote — the empty policy an account with
   * no copy follows — and on one written before this field existed.
   */
  published?: PolicyPublished;
}

/**
 * The policy an account with no document has: none, said in the document's own
 * shape so every reader can hold one type rather than two.
 */
export const EMPTY_POLICY: PolicyDocument = { defaults: {}, enforced: {}, changes: [] };

/** One publish's provenance, read back out of a stored document. */
function readPolicyPublished(v: unknown): PolicyPublished | undefined {
  if (!isRecord(v)) return undefined;
  const id = typeof v.id === "string" ? v.id.trim() : "";
  const at = typeof v.at === "string" ? v.at.trim() : "";
  return id && at ? { id, at } : undefined;
}

/** The one test for "this is an address", imported from the shared tree. */
export { isEmailAddress as isAddress } from "./shared/address.js";

/**
 * One reading of a policy section (`defaults`, `enforced`), shared by the boot
 * reader in `config.ts` and the editor here.
 *
 * A JSON null is absent — the boot reader's `?? {}` for a document that says
 * `"defaults": null`. A plain object is the section. Anything else is refused
 * with the reason: a scalar cast into an object loads as settings that are not
 * there, so the document is an error wherever it is read.
 */
export function readPolicySection(
  name: string,
  v: unknown,
): Record<string, unknown> | string {
  if (v == null) return {};
  if (isRecord(v)) return v;
  return `"${name}" must be an object`;
}

/**
 * Parse and validate one policy document text.
 *
 * Strict JSON; an
 * object at the top; `defaults` and `enforced` optional objects (a JSON null
 * reads as absent, exactly like the boot reader's `?? {}`); `changes` an
 * optional list whose entries each carry a unique non-empty `version` and a
 * plain-object `settings`. Unknown top-level keys are ignored, as the boot
 * reader ignores them.
 *
 * The two sections go through `readPolicySection`, which both readers share: a
 * scalar where an object belongs is refused here and refused at boot, so a
 * hand-written document cannot slip past the editor and corrupt settings on
 * load.
 */
export function parsePolicyDocument(raw: string): PolicyDocument | null {
  const result = parsePolicyDocumentDetailed(raw);
  return "problem" in result ? null : result.doc;
}

/**
 * Parse and validate, saying exactly what is wrong when it fails.
 *
 * Returns `{ doc }` for a valid document, or `{ problem }` with a message an
 * editor can show the administrator (the endpoint answers 400 with it).
 */
/** The `changes` array, validated the one way both readers of the document use. */
function readPolicyChanges(value: unknown): PolicyChangeDocument[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return '"changes" must be an array of { version, settings }';
  const out: PolicyChangeDocument[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (!isRecord(entry))
      return `changes[${i}] must be an object with "version" and "settings"`;
    const version = typeof entry.version === "string" ? entry.version.trim() : "";
    if (!version) return `changes[${i}] has no "version"`;
    if (seen.has(version)) return `Two changes share the version "${version}"`;
    seen.add(version);
    if (!isRecord(entry.settings))
      return `changes[${i}] ("${version}") has no "settings" object`;
    out.push({ version, settings: entry.settings });
  }
  return out;
}

export function parsePolicyDocumentDetailed(
  raw: string,
): { doc: PolicyDocument } | { problem: string } {
  let whole: unknown;
  try {
    whole = JSON.parse(raw);
  } catch (err) {
    const where = err instanceof Error ? ` (${err.message})` : "";
    return { problem: `Not valid JSON${where}.` };
  }
  if (!isRecord(whole))
    return {
      problem: "The document must be a JSON object with defaults, enforced and changes.",
    };
  const defaults = readPolicySection("defaults", whole.defaults);
  if (typeof defaults === "string") return { problem: `${defaults}.` };
  const enforced = readPolicySection("enforced", whole.enforced);
  if (typeof enforced === "string") return { problem: `${enforced}.` };
  const changesOrProblem = readPolicyChanges(whole.changes);
  if (typeof changesOrProblem === "string") return { problem: `${changesOrProblem}.` };
  return { doc: { defaults, enforced, changes: changesOrProblem } };
}

/** The document text the editor shows, stable keys and two-space indent. */
export function policyDocumentText(policy: PolicyDocument): string {
  return JSON.stringify(
    {
      defaults: policy.defaults ?? {},
      enforced: policy.enforced ?? {},
      changes: policy.changes ?? [],
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ */
/* Where the document lives: one account's own app folder (ADR 0001)   */
/* ------------------------------------------------------------------ */

/**
 * The published policy, inside the account's own app folder.
 *
 * A file of its own, not a key of `settings.json` — the client whole-file
 * replaces that document on every save, so a key its own schema does not own
 * would not survive the account's next settings save (the same reason
 * `must-change-password.json`, `server/src/account.ts`, is its own file).
 */
export const INSTALLATION_POLICY_FILE = "installation-policy.json";

/**
 * This account's own copy of the published policy, or null when publishing
 * has never reached it (a corrupt or unreadable document reads the same way:
 * ADR 0001's rule that a bad document must not refuse a surface, applied here
 * too — the caller falls back to the environment's bootstrap policy).
 */
export async function readAccountPolicy(
  ctx: Ctx,
  accountId: string,
): Promise<PolicyDocument | null> {
  if (!accountId) return null;
  const raw = await readAppJsonAt(ctx, accountId, INSTALLATION_POLICY_FILE);
  if (!isRecord(raw)) return null;
  const r = raw;
  const defaults = readPolicySection("defaults", r.defaults);
  if (typeof defaults === "string") return null;
  const enforced = readPolicySection("enforced", r.enforced);
  if (typeof enforced === "string") return null;
  const changesOrProblem = readPolicyChanges(r.changes);
  if (typeof changesOrProblem === "string") return null;
  const published = readPolicyPublished(r.published);
  return {
    defaults,
    enforced,
    changes: changesOrProblem,
    ...(published ? { published } : {}),
  };
}

/**
 * Write the published policy into one account's own app folder.
 *
 * `ifInState` makes the write conditional on the FileNode state read from this
 * same account, which is the compare-and-set JMAP offers in place of a lock
 * (ADR 0003): a publish that read an account and then had the account move
 * under it is refused rather than overwriting a document it never saw.
 *
 * The caller reads that state **after** the app folder is known to exist: an
 * account whose folder this write has to create pays one write for the folder,
 * which moves the account's state, and a token read before it would make the
 * conditional write lose a race with its own call (the reason
 * `AgentStore.provision` runs before a worker's first conditional write).
 */
export async function writeAccountPolicy(
  ctx: Ctx,
  accountId: string,
  doc: PolicyDocument,
  opts: { ifInState?: string } = {},
): Promise<void> {
  await writeAppFile(
    ctx,
    accountId,
    INSTALLATION_POLICY_FILE,
    {
      defaults: doc.defaults,
      enforced: doc.enforced,
      changes: doc.changes,
      ...(doc.published ? { published: doc.published } : {}),
    },
    opts,
  );
}

/* -------------------------------------------------------------------------- */
/* The publish job: what one publish did, kept in the publisher's own account  */
/* so the administration surface reads the same answer back later              */
/* -------------------------------------------------------------------------- */

const isUnreached = (v: unknown): v is PublishUnreached =>
  isRecord(v) &&
  typeof v.address === "string" &&
  typeof v.code === "string" &&
  typeof v.message === "string";

/**
 * Whether what was read is a job document, rather than a document that happens
 * to be shaped like one: an unreadable job is not an answer about a publish.
 */
export function isPublishJob(raw: unknown): raw is PublishJob {
  if (!isRecord(raw)) return false;
  if (raw.v !== 1) return false;
  if (typeof raw.id !== "string" || !raw.id) return false;
  if (typeof raw.startedAt !== "string" || !raw.startedAt) return false;
  if (typeof raw.by !== "string") return false;
  if (typeof raw.complete !== "boolean") return false;
  const population = raw.population;
  if (
    !isRecord(population) ||
    typeof population.read !== "number" ||
    typeof population.complete !== "boolean" ||
    (population.total !== null && typeof population.total !== "number")
  )
    return false;
  if (!Array.isArray(raw.reached) || !raw.reached.every((a) => typeof a === "string"))
    return false;
  if (!Array.isArray(raw.unreached) || !raw.unreached.every(isUnreached)) return false;
  if (raw.directory !== undefined && typeof raw.directory !== "string") return false;
  return true;
}

/**
 * The last publish this account recorded, or null when it recorded none.
 *
 * Missing, unreadable and "there but not a job" are one answer here, the way
 * every unreadable document in this module reads: a surface shows the last
 * record it can read, and a corrupt file cannot take the administration down
 * (ADR 0001's rule about a bad document, applied to the job too).
 */
export async function readPublishJob(
  ctx: Ctx,
  accountId: string,
): Promise<PublishJob | null> {
  if (!accountId) return null;
  const raw = await readAppJsonAt(ctx, accountId, PUBLISH_JOB_FILE);
  return isPublishJob(raw) ? raw : null;
}

/**
 * Record a publish in the publisher's own app folder, replacing the last one.
 *
 * Unconditional on purpose: this is the latest publish's record, and a second
 * publish by the same administrator replaces it rather than being refused by a
 * state the first one moved.
 */
export async function writePublishJob(
  ctx: Ctx,
  accountId: string,
  job: PublishJob,
): Promise<void> {
  await writeAppFile(ctx, accountId, PUBLISH_JOB_FILE, job);
}

/**
 * Whether a write into one account that failed was that account moving under
 * the publish (`policy-moved`) or something else (`write-failed`).
 *
 * They are different facts to an administrator: the first says the account was
 * written by somebody else at that instant and still carries whatever publish
 * reached it before, the second says the write itself did not work. JMAP says
 * which one happened with its own error type (`stateMismatch`), and this is
 * the one place that reads it.
 */
export function refusalCodeFor(err: unknown): "policy-moved" | "write-failed" {
  return isStateMismatch(err) ? "policy-moved" : "write-failed";
}
