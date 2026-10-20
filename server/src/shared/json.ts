/**
 * The one test for "this is a JSON object", for every reader that takes a
 * document apart.
 *
 * Both tiers are handed documents they did not write — the server the
 * installation document and the policy, the browser the policy an
 * administrator published — and each reader begins by asking whether the value
 * in front of it is an object at all. An array is not one: `JSON.parse`
 * returns an array for `[...]`, and a field read off it would be silently
 * absent instead of wrong, which is the failure mode a validator exists to
 * turn into a refusal.
 *
 * It is here rather than beside each reader so that "an object" means one
 * thing in this tree, and so that a document one reader accepts is not a
 * document the next one rejects. Readers ask it as a guard — `if (!isRecord(v))
 * return false` — or as a narrowing check, and both spellings answer the same
 * question.
 *
 * Shared with the web tier (`@gilbert/shared/json`), which validates the same
 * documents from the client side.
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Whether a value is a map whose every value is a string.
 *
 * The shape behind the `{ by, at }` stamps the document families carry and the
 * instants beside them, and a workorder checklist's `variants`. One definition
 * for every reader, so a document one reader accepts is a document every reader
 * accepts.
 *
 * `isStringArray` is its sibling for the other half of what these documents
 * hold, and an empty map is a map: a document with nothing stamped yet is one
 * this build reads.
 */
/**
 * Whether a value is an instant this build can order a document by.
 *
 * The one check for the dates a stored document carries — a run's, a fact's,
 * the installation's claim (ADR 0032) — so "a date" in one document means what
 * it means in the next. It lives with the other predicates a document is read
 * through rather than in the run's own module: three documents ask it and none
 * of them owns it.
 */
export function isInstant(x: unknown): x is string {
  return typeof x === "string" && Number.isFinite(Date.parse(x));
}

export function isStringMap(v: unknown): v is Record<string, string> {
  return isRecord(v) && Object.values(v).every((value) => typeof value === "string");
}

/** Whether a value is a list whose every entry is a string. */
export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((entry) => typeof entry === "string");
}

/**
 * Whether two values serialize to the same JSON whatever order their keys are
 * in.
 *
 * `JSON.stringify` alone is not enough, and the case is the common one: a JMAP
 * map (`keywords`, `mailboxIds`, the entries of a contact) is a document whose
 * keys the server is free to answer in any order, so a shallow comparison
 * reports a change whenever the order moves — the wasted render the mail list
 * exists to avoid, and a merge that keeps one entry twice because the same
 * value was spelled with its keys the other way round.
 *
 * Shared with the web tier for exactly that reason: one reader's "the same
 * value" has to be the next reader's.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) =>
      x < y ? -1 : x > y ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
