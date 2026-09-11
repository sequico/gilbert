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
 * What the worker does in each group, when the installation says so.
 *
 * The agent itself is not here: the deployment names it, in the environment of
 * whoever starts the server and the worker (`GILBERT_AGENT_ADDRESS` beside
 * `GILBERT_AGENT_PASSWORD`), so there is one place an address and its password
 * come from and no durable document to disagree with it.
 */
export interface PolicyAgent {
  /**
   * Narrowing only: the areas are intersected with the ones the deployment
   * serves, so a document can never widen what an operator allowed. A group the
   * document does not name is served as the deployment says.
   */
  groups?: Record<string, { areas?: string[] }>;
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
  agent?: PolicyAgent;
  identities?: PolicyIdentities;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** The one test for "this is an address", for every field that names one. */
export function isAddress(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
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
  const parsedAgent = parseAgent(whole.agent);
  if (parsedAgent && "problem" in parsedAgent) return { problem: parsedAgent.problem };
  const parsedIdentities = parseIdentities(whole.identities);
  if (parsedIdentities && "problem" in parsedIdentities)
    return { problem: parsedIdentities.problem };
  return {
    doc: {
      defaults,
      enforced,
      changes,
      ...(parsedAgent ? { agent: parsedAgent.agent } : {}),
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

/**
 * The per-group record the document carries, or the problem with what it says,
 * or null when it carries none.
 *
 * A record with no groups is nothing: the deployment's own list is in force for
 * every group, which is the state an installation that has narrowed nothing is
 * in. A present-but-unusable value is an error at save time, like every other
 * field here: a policy that half-applies is worse than one that is refused.
 */
function parseAgent(v: unknown): { agent: PolicyAgent } | { problem: string } | null {
  if (v == null) return null;
  if (!isRecord(v)) return { problem: '"agent" must be an object of groups.' };
  const groups = parseAgentGroups(v.groups);
  if ("problem" in groups) return { problem: groups.problem };
  if (!Object.keys(groups.groups).length) return null;
  return { agent: { groups: groups.groups } };
}

/**
 * The per-group part of the agent record, checked name by name.
 *
 * A group is named the way the product names groups (a lowercased address), and
 * an empty area list is how "as the deployment serves it" is written down — so
 * clearing a narrowing is a value an editor can express rather than a deletion.
 */
function parseAgentGroups(
  v: unknown,
): { groups: Record<string, { areas?: string[] }> } | { problem: string } {
  if (v == null) return { groups: {} };
  if (!isRecord(v)) return { problem: '"agent.groups" must be an object of groups.' };
  const groups: Record<string, { areas?: string[] }> = {};
  for (const [rawName, entry] of Object.entries(v)) {
    const name = rawName.trim().toLowerCase();
    if (!isAddress(name))
      return {
        problem: `"agent.groups" names something that is not a group: ${rawName}.`,
      };
    if (entry == null) continue;
    if (!isRecord(entry)) return { problem: `"agent.groups.${name}" must be an object.` };
    const areas = entry.areas;
    if (areas === undefined) continue;
    if (!Array.isArray(areas) || areas.some((area) => typeof area !== "string"))
      return { problem: `"agent.groups.${name}.areas" must be a list of area names.` };
    const clean = [...new Set(areas.map((area) => String(area).trim()).filter(Boolean))];
    groups[name] = clean.length ? { areas: clean } : {};
  }
  return { groups };
}

/** The document text the editor shows, stable keys and two-space indent. */
export function policyDocumentText(policy: PolicyDocument): string {
  const locked = policy.identities?.locked ?? [];
  return JSON.stringify(
    {
      defaults: policy.defaults ?? {},
      enforced: policy.enforced ?? {},
      changes: policy.changes ?? [],
      ...(policy.agent ? { agent: policy.agent } : {}),
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
