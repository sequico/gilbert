/**
 * The sentence a credential refusal reads as, composed from its code.
 *
 * The server answers with a code and its parameters (`CredentialRefusalCode`),
 * never with the sentence itself: an English sentence from the server is one no
 * catalogue can ever translate. The sentence is composed here — one entry per
 * code, so a code added on the server without a sentence here does not compile,
 * and a code this surface does not know falls back to whatever prose the body
 * carried. The sentences are the catalogue's keys: English in, English out, and
 * a language whose catalogue does not carry one reads the English — the
 * declared fallback, with the translations owed rather than assumed. `detail`
 * is never translated or invented: it is what the server that refused said.
 */
import type { CredentialRefusalCode } from "@gilbert/shared/groupAccess";
import { t } from "@/lib/i18n";

/** One English sentence per code, with the `{detail}` hole the server fills. */
const CREDENTIAL_REFUSAL_SENTENCES: Record<CredentialRefusalCode, string> = {
  agent_credentials_rejected:
    "The server refused the Master's credential, so the Master cannot be reached: {detail}. Check that GILBERT_AGENT_ADDRESS and GILBERT_AGENT_PASSWORD name the Master's own address and its account password, then restart the server.",
  agent_unreachable: "The Master's session could not be opened: {detail}",
};

/**
 * The sentence a refusal reads as, composed from the code its body carries, or
 * null for a code this surface does not know.
 *
 * Null is the honest answer for a body this surface does not know: the caller
 * reads whatever prose the body carried instead of inventing a sentence for a
 * code that means something else.
 */
export function agentErrorSentence(body: Record<string, unknown>): string | null {
  const code = typeof body.error === "string" ? body.error : "";
  return Object.hasOwn(CREDENTIAL_REFUSAL_SENTENCES, code)
    ? t(
        CREDENTIAL_REFUSAL_SENTENCES[code as CredentialRefusalCode],
        body as Record<string, string | number>,
      )
    : null;
}
