/**
 * What a tool's answer may not carry into a turn (ADR 0038).
 *
 * A tool reads the group's own account, and somebody may have pasted a password
 * into a document or a message. The answer is somebody else's text, so it is
 * **filtered once, at the door**, rather than trusted: a field named like a
 * credential loses its value before the answer reaches a prompt or the record,
 * and the run says that something was withheld so a reader is not left to wonder
 * why a field is empty.
 *
 * This is a name-based filter, not a secret detector: `{"password": "…"}` and
 * `{"apiKey": "…"}` are caught, a key pasted inside a paragraph of prose is not.
 * Upgrade when a document is known to carry one that a name cannot find: the
 * callers are `runTool` in the loop and the decision turn's own reads, and both
 * would take a stricter filter in the same place.
 */

/** The names a value is not allowed to travel under. */
const SECRET_NAMES =
  /^(password|passwd|secret|token|api[-_]?key|authorization|credential|private[-_]?key)$/i;

/** What a field keeps in place of its value. */
export const WITHHELD = "[withheld]";

/**
 * A credential pasted inside somebody's prose, emptied in place.
 *
 * The field filter cannot see this one: a message is a single string, and
 * `password: hunter2` is not a field named `password`. The pattern is
 * deliberately narrow — a secret word, a colon or an equals sign, a value with no
 * space — so ordinary prose is left alone. It is a net, not a guarantee, and its
 * limit is the same one the field filter declares.
 */
const SECRET_IN_TEXT =
  /\b(password|passwd|secret|token|api[-_]?key|authorization)\b(\s*[:=]\s*)([^\s,;]+)/gi;

/** A text with a credential-shaped assignment emptied, for the prompt and the record. */
export function redactText(text: string): string {
  return text.replace(
    SECRET_IN_TEXT,
    (_all: string, name: string, separator: string) => `${name}${separator}${WITHHELD}`,
  );
}

/** An answer with its credential-shaped fields emptied, and what was withheld. */
export function redactSecrets(value: unknown): { value: unknown; withheld: string[] } {
  const withheld: string[] = [];
  const walk = (held: unknown, path: string): unknown => {
    if (Array.isArray(held)) return held.map((one, at) => walk(one, `${path}[${at}]`));
    if (!held || typeof held !== "object") return held;
    const out: Record<string, unknown> = {};
    for (const [key, one] of Object.entries(held as Record<string, unknown>)) {
      /*
       * A field named like a credential loses its value when the value is text,
       * and when it is an object or a list: a `token` that holds
       * `{ access, refresh }` hides both under keys no name-based filter can
       * recognise. A number, a boolean and a blank string are left alone, because
       * a credential is not one of those and withholding them hides nothing.
       */
      const named = SECRET_NAMES.test(key);
      const container = one !== null && typeof one === "object";
      const text = typeof one === "string" && one.trim() !== "";
      if (named && (container || text)) {
        out[key] = WITHHELD;
        withheld.push(path ? `${path}.${key}` : key);
        continue;
      }
      out[key] = walk(one, path ? `${path}.${key}` : key);
    }
    return out;
  };
  return { value: walk(value, ""), withheld };
}
