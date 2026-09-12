/**
 * The sentence a group refusal reads as.
 *
 * A group's documents live in the group's own account, and the agent is the
 * principal that holds them, so the surface reaches them as the installation's
 * agent. A group the agent is not granted on has no path to them at all, and
 * the server refuses with a code and the section that was asked for
 * (`group_not_accessible` + `need`). It refuses with those two values rather
 * than with the sentence, because a sentence composed on the server is English
 * no catalogue can ever translate.
 *
 * The sentence is composed here instead, once, from the catalogue the reader's
 * language loaded. English is the key, so a language whose catalogue does not
 * carry the sentence reads the English: the declared fallback, with the
 * translations owed rather than assumed.
 */
import type { GroupNeed } from "@gilbert/agent/views";
import { t } from "@/lib/i18n";

/** The section's name fills `{need}`: "labels", "standing instruction", … */
export function groupAccessSentence(need: GroupNeed): string {
  return t(
    "Reaching a group's {need} happens as the installation's agent, and that agent is not a member of this group: the documents live in the group's own account, and only a member reaches them — so add the agent to the group in the mail server's directory.",
    { need },
  );
}
