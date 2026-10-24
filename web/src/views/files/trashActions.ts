import { errorMessage } from "@gilbert/shared/errors";
import { sessionIsAdmin } from "@gilbert/shared/sessionAccount";
import { t } from "@/lib/i18n";
import { mayEndFiles } from "@/lib/trash";
import { useFiles } from "@/store/files";
import { useSession } from "@/store/session";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

/**
 * The two things a surface offers about the Trash, decided once (ADR 0013).
 *
 * Whether the reader may end what is in the account's Trash — the reader's own
 * files always, a group's only for an installation administrator — and the
 * emptying itself, asked before it happens and reported afterwards. The Files
 * tree and the listing both offer the entry, so the question and the action are
 * written here rather than twice.
 */

/** Whether this reader may empty this account's Trash, or end a node in it. */
export function useMayEndFiles(): boolean {
  const isAdmin = useSession((s) => sessionIsAdmin(s.session));
  const accountId = useFiles((s) => s.accountId);
  const ownAccountId = useFiles((s) => s.ownAccountId);
  return mayEndFiles({ accountId, ownAccountId, isAdmin });
}

/** Ask, then empty the Trash. Nothing in it comes back; true when it emptied. */
export async function emptyTrashAsked(): Promise<boolean> {
  const asked = await confirmDialog({
    title: t("Empty the trash?"),
    message: t("Everything in it is deleted for good."),
    confirmLabel: t("Empty trash"),
    danger: true,
  });
  if (!asked) return false;
  try {
    await useFiles.getState().emptyTrash();
    toast.success(t("Trash emptied"));
    return true;
  } catch (err) {
    toast.error(errorMessage(err));
    return false;
  }
}
