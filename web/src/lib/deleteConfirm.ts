/**
 * What a delete confirmation says, composed once.
 *
 * Four surfaces ask before a delete — the list's toolbar, a message's own menu,
 * a folder's sidebar menu and the folder list in Settings — and one of them
 * empties a folder. Each carried its own copy of the same sentences, and a copy
 * of a sentence is how one action comes to be described two ways: the folder
 * list said "{n} message will be permanently deleted" about a folder whose
 * sidebar said "This permanently deletes the folder and its {n} messages".
 *
 * Nothing here decides *whether* a delete may be taken — that is ADR 0015's
 * rule, asked by the store before this is called — nor whether the reader wants
 * to be asked at all (`settings.confirmDelete`, which each caller reads for
 * itself). It composes what the dialog says and answers whether the reader
 * agreed.
 *
 * Every sentence goes through the catalogue, and counted ones through `plural`:
 * a sentence written as a template literal is a sentence no catalogue can key
 * on, which is how copy ships English in all ten languages unnoticed.
 */
import { plural, t } from "@/lib/i18n";
import { confirmDialog } from "@/ui/dialog";

/** The sentence a permanent delete of `n` messages states. */
export function deletedMessages(n: number): string {
  return plural(n, {
    one: "{n} message will be permanently deleted.",
    other: "{n} messages will be permanently deleted.",
  });
}

/** The same, for a delete that only files them somewhere they can come back from. */
export function trashedMessages(n: number): string {
  return plural(n, {
    one: "Move {n} message to Trash?",
    other: "Move {n} messages to Trash?",
  });
}

/**
 * Ask before ending or filing messages.
 *
 * `permanent` is the rule's answer about what the reader is looking at
 * (`deleteEffect`), never a preference: a delete out of Deleted Items or Junk
 * Mail ends the message, and the dialog says "forever" because it would.
 *
 * The sentences are `plural` and not "message(s)": that spelling puts a
 * parenthesis where every language that inflects wants agreement.
 */
export function askDeleteMessages(opts: {
  count: number;
  permanent: boolean;
}): Promise<boolean> {
  return confirmDialog({
    title: opts.permanent ? t("Delete forever?") : t("Delete?"),
    message: opts.permanent ? deletedMessages(opts.count) : trashedMessages(opts.count),
    confirmLabel: t("Delete"),
    danger: opts.permanent,
  });
}

/**
 * Ask before deleting a folder together with the mail in it.
 *
 * One sentence for both surfaces that offer it, because it is one action: what
 * a folder's deletion takes with it does not change with the surface it was
 * offered from.
 */
export function askDeleteFolder(opts: {
  name: string;
  emails: number;
}): Promise<boolean> {
  return confirmDialog({
    title: t("Delete “{name}”?", { name: opts.name }),
    message: plural(opts.emails, {
      one: "This permanently deletes the folder and its {n} message.",
      other: "This permanently deletes the folder and its {n} messages.",
    }),
    confirmLabel: t("Delete"),
    danger: true,
  });
}
