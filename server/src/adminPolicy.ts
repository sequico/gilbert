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
 *
 * Returns null when the text is not a valid document, so the caller can
 * answer 400 instead of crashing.
 */
export function parsePolicyDocument(raw: string): PolicyDocument | null {
  let whole: unknown;
  try {
    whole = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(whole)) return null;
  const pick = (v: unknown): Record<string, unknown> | null =>
    v == null ? {} : isRecord(v) ? v : null;
  const defaults = pick(whole.defaults);
  const enforced = pick(whole.enforced);
  if (defaults === null || enforced === null) return null;
  const changes: PolicyChangeDocument[] = [];
  if (whole.changes !== undefined) {
    if (!Array.isArray(whole.changes)) return null;
    const seen = new Set<string>();
    for (const entry of whole.changes) {
      if (!isRecord(entry)) return null;
      const version = typeof entry.version === "string" ? entry.version.trim() : "";
      if (!version) return null;
      if (seen.has(version)) return null;
      seen.add(version);
      if (!isRecord(entry.settings)) return null;
      changes.push({ version, settings: entry.settings });
    }
  }
  return { defaults, enforced, changes };
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
