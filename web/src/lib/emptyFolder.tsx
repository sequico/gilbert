/**
 * Emptying a folder, and asking first.
 *
 * There are three ways in — the folder's right-click menu, the list's own
 * menu, and the banner across the top of Junk Mail — and they must not drift
 * apart in what they warn about. A folder can only be emptied when it is one
 * whose whole purpose is holding things you did not want: Deleted Items, or
 * Junk Mail.
 *
 * The wording differs between them for a reason. Emptying Deleted Items is
 * what anyone expects it to do. Emptying Junk Mail is the surprising one: the
 * messages do not travel to Deleted Items on the way out, so there is no
 * second chance to change your mind, and the dialog says so rather than
 * leaving it to be discovered.
 *
 * **Every sentence here is asked for through the catalogue.** They are built
 * from a folder's name and a count rather than written as plain JSX text, which
 * is exactly the position where a string ships English in all ten languages
 * with nobody noticing: the labels and the dialog text were template literals,
 * and no catalogue can key on a template literal. Counted sentences go through
 * `plural`, so a language with three plural forms gets its own.
 *
 * Nothing here decides *whether* emptying is allowed: that is ADR 0015's rule,
 * asked by the store before this is called, and it is why a group's menu never
 * reaches these dialogs.
 */

import type { Id, MailboxRole } from "@/jmap/types";
import { plural, t } from "@/lib/i18n";
import { useMail } from "@/store/mail";
import { confirmDialog } from "@/ui/dialog";

export interface EmptyTarget {
  id: Id;
  name: string;
  role: MailboxRole;
  totalEmails: number;
}

/** Whether this folder is one that may be emptied at all. */
export function canEmpty(role: MailboxRole | undefined | null): boolean {
  return role === "trash" || role === "junk";
}

/** What the button or menu item is called, in the folder's own terms. */
export function emptyLabel(target: Pick<EmptyTarget, "name" | "role">): string {
  return target.role === "junk"
    ? t("Delete all spam")
    : t("Empty {name}", { name: target.name });
}

/** Ask, then empty. Resolves once the emptying has been attempted, or declined. */
export async function confirmAndEmpty(target: EmptyTarget): Promise<void> {
  if (!canEmpty(target.role)) return;
  const junk = target.role === "junk";
  const n = target.totalEmails;
  const ok = await confirmDialog({
    title: junk
      ? t("Delete all spam in “{name}”?", { name: target.name })
      : t("Empty “{name}”?", { name: target.name }),
    message: junk
      ? plural(n, {
          one: "This message will be deleted permanently. It does not go to Deleted Items first, so this cannot be undone.",
          other:
            "All {n} messages will be deleted permanently. They do not go to Deleted Items first, so this cannot be undone.",
        })
      : plural(n, {
          // The same pair the delete confirmations use: one sentence about a
          // folder's mail is the same sentence wherever it is asked.
          one: "{n} message will be permanently deleted.",
          other: "{n} messages will be permanently deleted.",
        }),
    confirmLabel: junk ? t("Delete all spam") : t("Empty folder"),
    danger: true,
  });
  if (ok) await useMail.getState().emptyMailbox(target.id);
}
