/**
 * The sentence a group-membership refusal reads as.
 *
 * A group's documents live in the group's own account, so a non-member has no
 * path to them at all, and the server refuses with a code and the section that
 * was asked for (`group_not_accessible` + `need`). It refuses with those two
 * values rather than with the sentence, because a sentence composed on the
 * server is English no catalogue can ever translate.
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
    "Reaching a group's {need} needs membership of that group: the group's own documents live in its files, and this mail server refuses to act as a group mailbox on an administrator's behalf.",
    { need },
  );
}
