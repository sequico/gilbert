/**
 * The sentence an agent surface reads as, composed from its code.
 *
 * The admin surface answers with a code and its parameters
 * (`AgentErrorReason`), never with the sentence itself: an English sentence from
 * the server is one no catalogue can ever translate. The sentence is composed
 * here — one entry per code, so a code added on the server without a sentence
 * here does not compile, and a code answered before this file learns it falls
 * back to whatever prose the body carried.
 *
 * The sentences are the catalogue's keys: English in, English out, and a
 * language whose catalogue does not carry one reads the English — the declared
 * fallback, with the translations owed rather than assumed. `detail` is never
 * translated or invented: it is what the server that refused said.
 */
import type {
  AgentErrorReason,
  AgentStatusReason,
  ManualRunRefusal,
} from "@gilbert/agent/views";
import { t } from "@/lib/i18n";

/**
 * Why an automation a person asked for did not start, in the reader's language.
 *
 * The code carries the reason rather than five codes carrying one each (the
 * sentence map below is keyed by the *code*, and one code with a parameter is
 * how a family of answers stays one entry there). Each of these is a sentence
 * a person can act on: something to arm, something to notice about what the
 * automation looks at, or nothing to run it on.
 */
export const MANUAL_RUN_REFUSALS: Record<ManualRunRefusal, string> = {
  rule_not_found: "there is no such automation in this group any more",
  rule_not_armed:
    '"{rule}" is not armed: an automation that is off runs for nobody, whoever asks',
  rule_not_email:
    '"{rule}" is not about mail. A chat automation is asked for by mentioning the agent in the group\'s chat, and a timed one runs on its own clock',
  no_message:
    "there is no message to run it on: this group's inbox holds none, or the one named is gone",
  message_not_matched:
    '"{rule}" passes this message over: its own filter decides, and this one it does not match',
};

/**
 * One English sentence per code, with `{parameter}` holes.
 *
 * The table is the one place these sentences live: an admin refusal
 * (`AgentErrorReason`) and the fleet's own status (`AgentStatusReason`) read
 * from it, so a code cannot be worded one way in a refusal and another in the
 * panel that reports the same thing. `satisfies` is the mechanism, not the
 * prose: the compiler refuses this object when a code of either union is
 * missing from it, and `Object.keys` is then the runtime list of codes this
 * surface knows how to answer for.
 */
export const AGENT_ERROR_SENTENCES = {
  agent_not_configured:
    "This deployment names no agent, so the agents are not operational: set GILBERT_AGENT_ADDRESS to the agent's own address and GILBERT_AGENT_PASSWORD to that account's password, in the environment that starts the server and its agent, then restart both.",
  agent_credentials_rejected:
    "The server refused the agent's credential, so the agents are not operational: {detail}. Check that GILBERT_AGENT_ADDRESS and GILBERT_AGENT_PASSWORD name the agent's own address and its account password, then restart the server and its agent.",
  agent_unreachable: "The agent's session could not be opened: {detail}",
  agent_files_account_missing:
    "The agent {address} has no account holding its own Files, so there is nothing for it to read or write.",
  agent_not_found: "The server has no account at that address: {detail}",
  agent_document_not_current:
    "A stored agent document is not in the shape this build writes, and it could not be replaced: {detail}",
  forbidden: "This administrator may not act as that agent: {detail}",
  duplicate_rule:
    'Two automations share the id "{id}". Ids must be unique: a job records the id and the version it was created from.',
  rule_not_a_document: "Automation #{index} is not a rule document Gilbert can run.",
  rule_cannot_run: '"{name}" cannot run: {problems}.',
  provider_not_an_object:
    "The provider must be an object naming a provider, a model and a base URL, or null to clear the installation's model.",
  provider_incomplete: "The provider must name a provider, a model and a base URL.",
  api_key_required:
    "The provider needs an api key, issued for the endpoint it is entered against.",
  api_key_required_after_move:
    "The provider moves to {movedTo}, so its api key has to be entered again: a key is issued for the endpoint it was entered against.",
  base_url_invalid: "The base URL is not a URL.",
  base_url_not_https:
    "The base URL must use https: the api key travels in a header, and plain http would send it in the clear.",
  notebook_not_an_object: "A notebook write must name the facts it sends.",
  notebook_too_many: "A notebook holds at most {max} facts.",
  notebook_fact_too_long: "A fact is at most {max} characters.",
  max_output_tokens_invalid:
    "The ceiling on one answer must be between 1 and {max} tokens.",
  max_chain_hops_invalid: "How many hops a chain may run must be between 1 and {max}.",
  max_pages_invalid:
    "How many pages one run may hand the model must be between 1 and {max}.",
  base_url_private:
    "The base URL points at {host}, which is inside the network: an agent must not be pointed at an address that is not a model provider.",
  instruction_too_long:
    "One piece of prose an agent carries is at most {max} characters; this one is {length}.",
  review_mode_unknown:
    "That is not a review policy this build knows: pick one of the three.",
  policy_not_an_object: "The policy could not be read from what was sent.",
  no_provider:
    "This installation has no model configured, so there is nothing to read a draft with: set the provider under Agents first.",
  reading_failed: "The model could not be asked to read this draft: {detail}",
  envelope_too_long:
    "What the draft belongs to is at most {max} characters; this is {length}.",
  authoring_budget_spent:
    "This installation has already asked the model to read {max} drafts this month, which is the ceiling it set for itself: it starts again next month, or an operator raises GILBERT_AGENT_AUTHORING_MAX_PER_MONTH.",
  group_labels_unreadable:
    "This group's labels.json holds entries Gilbert cannot read. The agent's labels were not added, rather than overwriting them.",
  manual_run_refused: "That automation did not start: {reason}.",
  agents_unreadable: "Could not read the agent's own records: {detail}",
} as const satisfies Record<AgentErrorReason["code"] | AgentStatusReason["code"], string>;

/** The codes this surface composes a sentence for: the catalogue's own keys. */
export const AGENT_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.keys(AGENT_ERROR_SENTENCES),
);

/**
 * The sentence for a code of the agent vocabulary, parameters filled.
 *
 * The table above is complete by the compiler's word (`satisfies`), so this
 * cannot fail for a code either union declares.
 */
export function agentSentence(
  code: AgentErrorReason["code"] | AgentStatusReason["code"],
  params: Record<string, unknown>,
): string {
  return t(AGENT_ERROR_SENTENCES[code], params as Record<string, string | number>);
}

/**
 * The sentence for a code this surface may not know, or null.
 *
 * Null is the honest answer for a body this surface does not know: the caller
 * reads whatever prose the body carried instead of inventing a sentence for a
 * code that means something else.
 */
export function agentSentenceFor(
  code: string,
  params: Record<string, unknown>,
): string | null {
  return code in AGENT_ERROR_SENTENCES
    ? agentSentence(code as AgentErrorReason["code"] | AgentStatusReason["code"], params)
    : null;
}

/** The sentence a refusal reads as, composed from the code its body carries. */
export function agentErrorSentence(body: Record<string, unknown>): string | null {
  const code = typeof body.error === "string" ? body.error : "";
  // A refusal with a reason inside it is the one code whose sentence needs its
  // own parameter translated first: the reason is a catalogue key too, so a
  // language that carries it reads it, and one that does not reads the English.
  if (code === "manual_run_refused") {
    const why = String(body.why ?? "");
    const reason = MANUAL_RUN_REFUSALS[why as ManualRunRefusal] ?? why;
    return agentSentence(code, {
      reason: t(reason, { rule: String(body.rule ?? "") }),
    });
  }
  return agentSentenceFor(code, body);
}
