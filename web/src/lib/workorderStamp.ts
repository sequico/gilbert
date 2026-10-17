/**
 * How a step's signature reads in a workorder (ADR 0028).
 *
 * A step carries the last actor: a person's own address, or the agent, which is
 * not a person. The two read as two sentences, and this is the one place that
 * chooses between them, so no surface shows `gilbert-agent` as though it were
 * somebody's name.
 */
import { isAgentSignature } from "@gilbert/shared/agent";
import { t } from "@/lib/i18n";

/** The stamp under a settled step: who set it, and when. */
export function stepStamp(by: string, when: string): string {
  return isAgentSignature(by)
    ? t("Set by the agent on {when}", { when })
    : t("Set by {who} on {when}", { who: by, when });
}
