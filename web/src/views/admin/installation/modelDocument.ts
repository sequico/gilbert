import { isRecord } from "@gilbert/shared/json";
import { installationModel } from "@/lib/installationAdmin";

/**
 * The three things a save can say about the model's key, which is never shown.
 *
 * `kept` is a field that says nothing: untouched, or typed into and emptied
 * again — the two are the same save, and both leave the stored key exactly as it
 * is. `none` is the operator saying the provider needs none — a model on the
 * deployment's own network — which clears the stored key. A value is the key to
 * write. The document tells the three apart by the field itself, and
 * `installationAdmin.ts` reads it that way: no `apiKey` at all, or an empty one,
 * keeps the stored key; the `null` the switch below sends says the provider
 * needs none; a value is that key.
 */
export type KeyDraft =
  | { kind: "kept" }
  | { kind: "none" }
  | { kind: "key"; value: string };

/** The text as a JSON object, or null when it is not one. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const whole: unknown = JSON.parse(text);
    return isRecord(whole) ? whole : null;
  } catch {
    return null;
  }
}

/**
 * The document text with fields of the model's provider set.
 *
 * The text is what this surface holds and publishes, so a field changed here is
 * a change to the document and the editor below shows what was written: the
 * model has one home, not a second one beside the document. A text that is not a
 * JSON object is left exactly as it is — the fields are dead while it is — and a
 * document with no `agent` section grows one.
 */
export function withModelField(
  text: string,
  patch: Partial<Record<"provider" | "model" | "baseUrl" | "apiKey", string | null>>,
): string {
  const whole = parseObject(text);
  if (!whole) return text;
  const agent = isRecord(whole.agent) ? whole.agent : {};
  const provider = isRecord(agent.provider) ? agent.provider : {};
  return JSON.stringify(
    { ...whole, agent: { ...agent, provider: { ...provider, ...patch } } },
    null,
    2,
  );
}

/**
 * The document with the installation's own line of prose set.
 *
 * The line is `agent.instruction` — the outermost prose the agent is told, above
 * every group's own instruction (ADR 0031). It is edited here as a field, beside
 * the model, because it is the other thing of that section a person chooses
 * rather than looks up.
 */
export function withInstructionField(text: string, instruction: string): string {
  const whole = parseObject(text);
  if (!whole) return text;
  const agent = isRecord(whole.agent) ? whole.agent : {};
  return JSON.stringify(
    {
      ...whole,
      agent: { ...agent, instruction: instruction.trim() ? instruction : undefined },
    },
    null,
    2,
  );
}

/**
 * The document to publish, with the key the form states.
 *
 * The key never reaches the text this surface holds — the server takes it out
 * when it reads, and the form keeps its copy in memory only — so the two things
 * a save can state are written here, once, into what is sent: a value, or `null`
 * for a provider that needs none. A field left untouched or emptied states
 * nothing, and the text goes as it is. A document that names no provider has no
 * model, and so no key to carry or to clear.
 */
export function withModelKey(text: string, draft: KeyDraft): string {
  if (draft.kind === "kept") return text;
  if (!installationModel(text).provider) return text;
  return withModelField(text, { apiKey: draft.kind === "none" ? null : draft.value });
}
