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
