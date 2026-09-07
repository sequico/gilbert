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

export interface PolicyDocument {
  defaults: Record<string, unknown>;
  enforced: Record<string, unknown>;
  changes: PolicyChangeDocument[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

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
 * One deliberate difference: where the boot reader would silently cast a
 * scalar `defaults`/`enforced` into an object, the surface refuses the
 * document — a policy that would corrupt settings on load is an error at
 * save time, not at sign-in.
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
  const pick = (name: string, v: unknown): Record<string, unknown> | string => {
    if (v == null) return {};
    if (isRecord(v)) return v;
    return `"${name}" must be an object.`;
  };
  const defaults = pick("defaults", whole.defaults);
  if (typeof defaults === "string") return { problem: defaults };
  const enforced = pick("enforced", whole.enforced);
  if (typeof enforced === "string") return { problem: enforced };
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
