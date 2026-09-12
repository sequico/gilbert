import { rename, writeFile } from "node:fs/promises";

/**
 * The installation-wide settings policy, as the administration surface edits
 * it (ADR 0001 §4, ADR 0004). The document is the same shape upstream's boot
 * path reads — `{ defaults, enforced, changes }` (issue #207) — so a document
 * written here can seed `SETTINGS_POLICY_FILE` and vice versa. The upstream
 * reader is never forked: this module mirrors its rules so the two stay in
 * step, and the surface refuses what the boot reader would only half-accept.
 */

export interface PolicyChangeDocument {
  version: string;
  settings: Record<string, unknown>;
}

/**
 * The identities an administrator has taken over (ADR 0007 §4).
 *
 * `locked` names the accounts whose identity an administrator set: the product
 * offers such an account no Identities & signatures section at all, so what was
 * set here is what it shows and sends. An address, because that is what names
 * an account everywhere else in this document.
 *
 * The lock is a rule about **this product's surface**, not a boundary: Stalwart
 * has no per-field permission on an identity, so an account that speaks JMAP
 * directly can still write one. What the entry guarantees is that Gilbert
 * offers nobody the edit.
 */
export interface PolicyIdentities {
  locked: string[];
}

export interface PolicyDocument {
  defaults: Record<string, unknown>;
  enforced: Record<string, unknown>;
  changes: PolicyChangeDocument[];
  identities?: PolicyIdentities;
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
  const parsedIdentities = parseIdentities(whole.identities);
  if (parsedIdentities && "problem" in parsedIdentities)
    return { problem: parsedIdentities.problem };
  return {
    doc: {
      defaults,
      enforced,
      changes,
      ...(parsedIdentities ? { identities: parsedIdentities.identities } : {}),
    },
  };
}

/**
 * The identity half of the document, checked field by field, or null when the
 * document says nothing about identities at all.
 *
 * An empty `locked` list and an absent one mean the same thing — nobody is
 * locked — so the empty form parses to a record with nothing in it and
 * `policyDocumentText` writes neither. A present-but-unusable entry is an error
 * at save time, like every other field here.
 */
function parseIdentities(
  v: unknown,
): { identities: PolicyIdentities } | { problem: string } | null {
  if (v == null) return null;
  if (!isRecord(v))
    return { problem: '"identities" must be an object with a "locked" list.' };
  const raw = v.locked;
  if (raw === undefined) return { identities: { locked: [] } };
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string"))
    return { problem: '"identities.locked" must be a list of account addresses.' };
  const locked: string[] = [];
  for (const entry of raw) {
    const address = entry.trim().toLowerCase();
    if (!isAddress(address))
      return {
        problem: `"identities.locked" names something that is not an address: ${entry}.`,
      };
    if (!locked.includes(address)) locked.push(address);
  }
  return { identities: { locked } };
}

/** The document text the editor shows, stable keys and two-space indent. */
export function policyDocumentText(policy: PolicyDocument): string {
  const locked = policy.identities?.locked ?? [];
  return JSON.stringify(
    {
      defaults: policy.defaults ?? {},
      enforced: policy.enforced ?? {},
      changes: policy.changes ?? [],
      ...(locked.length ? { identities: { locked } } : {}),
    },
    null,
    2,
  );
}

/**
 * Atomically replace `SETTINGS_POLICY_FILE` with the published document, so a
 * restart of the process keeps the change (ADR 0004 §2). Write to a sibling
 * temp file, then rename into place.
 */
export async function persistPolicyFile(file: string, raw: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
  await rename(tmp, file);
}
