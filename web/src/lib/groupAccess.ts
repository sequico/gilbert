/**
 * The sentence a group refusal reads as, composed from its code.
 *
 * The server refuses with a code and the section that was asked for
 * (`group_not_accessible` or `group_unreadable` + `need`), never with a
 * sentence, because a sentence composed there is English no catalogue can
 * translate. The sentence is composed here instead, from the catalogue the
 * reader's language loaded: English is the key, so a language whose catalogue
 * does not carry the sentence reads the English — the declared fallback, with
 * the translations owed rather than assumed.
 */
import type { GroupNeed } from "@gilbert/shared/groupAccess";
import { t } from "@/lib/i18n";

/** The section's name fills `{need}`: "labels", "agent documents", … */
export function groupAccessSentence(need: GroupNeed): string {
  return t(
    "Reaching a group's {need} happens as the Master, and the Master is not granted on this group: the documents live in the group's own account, so grant it on the group in the mail server's directory.",
    { need },
  );
}

/**
 * The sentence the other refusal reads as: what could not be established.
 *
 * The parameter is the section's name, as above: the same field, and the reason
 * the two sentences are two.
 */
export function groupUnreadableSentence(need: GroupNeed): string {
  return t(
    "Gilbert could not ask the mail server about this group's {need}, so it cannot say whether the Master reaches it: nothing was changed and nothing was read. Try again, and if it keeps answering this way the mail server is the one to look at.",
    { need },
  );
}
