/**
 * The sentence a group refusal reads as.
 *
 * A group's documents live in the group's own account, and the agent is the
 * principal that holds them, so the surface reaches them as the installation's
 * agent. A group the agent is not granted on has no path to them at all, and
 * the server refuses with a code and the section that was asked for
 * (`group_not_accessible` + `need`). A group the mail server would not answer
 * about is refused with a code of its own (`group_unreadable`), because the
 * grant is not what is in the way and telling a person to edit one they cannot
 * verify would be the surface asserting a fact nobody established. It refuses
 * with those values rather than with the sentence, because a sentence composed
 * on the server is English no catalogue can ever translate.
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

/**
 * The sentence the other refusal reads as: what could not be established.
 *
 * The parameter is the section's name, as above: the same field, and the
 * reason the two sentences are two.
 */
export function groupUnreadableSentence(need: GroupNeed): string {
  return t(
    "Gilbert could not ask the mail server about this group's {need}, so it cannot say whether that agent reaches it: nothing was changed and nothing was read. Try again, and if it keeps answering this way the mail server is the one to look at.",
    { need },
  );
}
