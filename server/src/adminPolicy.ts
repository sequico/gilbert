import { type Ctx, readAppJsonAt, writeAppFile } from "./appFolder.js";

/**
 * The installation-wide settings policy, as the administration surface edits
 * it (ADR 0001, ADR 0001, ADR 0001). `{ defaults, enforced, changes }`
 * (issue #207), published into every individual account's own app folder
 * rather than kept in one file or environment variable — see
 * `writeAccountPolicy`/`readAccountPolicy` below. `SETTINGS_DEFAULTS` /
 * `SETTINGS_ENFORCED` / `SETTINGS_CHANGES` (`config.ts`) read the same shape
 * from the environment, as the bootstrap an account falls back to before any
 * administrator has published one through this document.
 */

export interface PolicyChangeDocument {
  version: string;
  settings: Record<string, unknown>;
}

export interface PolicyDocument {
  defaults: Record<string, unknown>;
  enforced: Record<string, unknown>;
  changes: PolicyChangeDocument[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** The one test for "this is an address", for every field that names one. */
export function isAddress(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

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
 * Mirrors `readSettingsPolicy` in `server/src/config.ts`: strict JSON; an
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
  const changes: PolicyChangeDocument[] = [];
  if (whole.changes !== undefined) {
    if (!Array.isArray(whole.changes))
      return { problem: '"changes" must be an array of { version, settings }.' };
    const seen = new Set<string>();
    for (let i = 0; i < whole.changes.length; i++) {
      const entry = whole.changes[i];
      if (!isRecord(entry))
        return {
          problem: `changes[${i}] must be an object with "version" and "settings".`,
        };
      const version = typeof entry.version === "string" ? entry.version.trim() : "";
      if (!version) return { problem: `changes[${i}] has no "version".` };
      if (seen.has(version))
        return { problem: `Two changes share the version "${version}".` };
      seen.add(version);
      if (!isRecord(entry.settings))
        return {
          problem: `changes[${i}] ("${version}") has no "settings" object.`,
        };
      changes.push({ version, settings: entry.settings });
    }
  }
  return { doc: { defaults, enforced, changes } };
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const defaults = readPolicySection("defaults", r.defaults);
  if (typeof defaults === "string") return null;
  const enforced = readPolicySection("enforced", r.enforced);
  if (typeof enforced === "string") return null;
  const changes = Array.isArray(r.changes)
    ? r.changes.filter(
        (e): e is PolicyChangeDocument =>
          isRecord(e) && typeof e.version === "string" && isRecord(e.settings),
      )
    : [];
  return { defaults, enforced, changes };
}

/** Write the published policy into one account's own app folder. */
export async function writeAccountPolicy(
  ctx: Ctx,
  accountId: string,
  doc: PolicyDocument,
): Promise<void> {
  await writeAppFile(ctx, accountId, INSTALLATION_POLICY_FILE, {
    defaults: doc.defaults,
    enforced: doc.enforced,
    changes: doc.changes,
  });
}
