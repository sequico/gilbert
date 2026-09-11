/**
 * The sentence an admin refusal reads as, composed from its code.
 *
 * The admin surface used to answer with the sentence itself, in English, which
 * is English no catalogue can ever translate. It answers with a code and its
 * parameters now (`AgentErrorReason`), and the sentence is composed here — one
 * entry per code, so a code added on the server without a sentence here does
 * not compile, and a code answered before this file learns it falls back to
 * whatever prose the body carried.
 *
 * The sentences are the catalogue's keys: English in, English out, and a
 * language whose catalogue does not carry one reads the English — the declared
 * fallback, with the translations owed rather than assumed. `detail` is never
 * translated or invented: it is what the server that refused said.
 */
import type { AgentErrorReason } from "@gilbert/agent/views";
import { t } from "@/lib/i18n";

/**
 * One English sentence per code, with `{parameter}` holes.
 *
 * `satisfies` is the mechanism, not the prose: the compiler refuses this object
 * when a code of `AgentErrorReason` is missing from it, and `Object.keys` is
 * then the runtime list of codes this surface knows how to answer for.
 */
export const AGENT_ERROR_SENTENCES = {
  agent_not_configured:
    "No agent is registered with this installation. Name its address in the field above, or set GILBERT_AGENT_ADDRESS and its app password where the installation is deployed and restart the server and the worker.",
  agent_unreachable: "The agent's session could not be opened: {detail}",
  agent_files_account_missing:
    "The agent {address} has no account holding its own Files, so there is nothing for it to read or write.",
  agent_not_found: "The server has no account at that address: {detail}",
  agent_credential_failed:
    "The address was recorded, but no credential could be provisioned for it: {detail}",
  forbidden: "This administrator may not act as that agent: {detail}",
  duplicate_rule:
    'Two automations share the id "{id}". Ids must be unique: a job records the id and the version it was created from.',
  rule_not_a_document: "Automation #{index} is not a rule document Gilbert can run.",
  rule_cannot_run: '"{name}" cannot run: {problems}.',
  providers_not_an_object:
    "The providers must be an object naming the T1 and/or T2 tiers.",
  unknown_tier: '"{key}" is not a tier: the tiers that call a model are T1 and T2.',
  tier_incomplete: "{tier} must name a provider, a model and a base URL.",
  tier_api_key_required:
    "{tier} needs an api key, issued for the endpoint it is entered against.",
  tier_api_key_required_after_move:
    "{tier} moves to {movedTo}, so its api key has to be entered again: a key is issued for the endpoint it was entered against.",
  tier_base_url_invalid: "{tier} has a base URL that is not a URL.",
  tier_base_url_not_https:
    "{tier} must use https: the api key travels in a header, and plain http would send it in the clear.",
  tier_base_url_private:
    "{tier} points at {host}, which is inside the network: a worker must not be pointed at an address that is not a model provider.",
  instruction_too_long:
    "A standing instruction is at most {max} characters; this one is {length}.",
  group_labels_unreadable:
    "This group's labels.json holds entries Gilbert cannot read. The agent's labels were not added, rather than overwriting them.",
} as const satisfies Record<AgentErrorReason["code"], string>;

/** The codes this surface composes a sentence for: the catalogue's own keys. */
export const AGENT_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.keys(AGENT_ERROR_SENTENCES),
);

/**
 * The sentence for a refusal, or null when the code is not one of these.
 *
 * Null is the honest answer for a body this surface does not know: the caller
 * reads whatever prose the body carries instead of inventing a sentence for a
 * code that means something else.
 */
export function agentErrorSentence(body: Record<string, unknown>): string | null {
  const code = typeof body.error === "string" ? body.error : "";
  const template = (AGENT_ERROR_SENTENCES as Record<string, string | undefined>)[code];
  if (!template) return null;
  return t(template, body as Record<string, string | number>);
}
