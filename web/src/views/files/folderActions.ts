import { errorMessage } from "@gilbert/shared/errors";
import type { Id } from "@/jmap/types";
import { t } from "@/lib/i18n";
import { useFiles } from "@/store/files";
import { promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

/**
 * Ask for a name and make a folder, wherever Files offers it.
 *
 * The listing's toolbar, its empty-space menu and the sidebar tree all offer
 * "New folder", and each answers the same two questions — what it is called, and
 * how a refusal is reported. Written once so the three cannot drift: the caller
 * that has to open the new folder's branch is handed its id.
 */
export async function newFolderAsked(parentId: Id | null): Promise<Id | null> {
  const name = (
    await promptDialog({
      title: t("New folder"),
      placeholder: t("Folder name"),
    })
  )?.trim();
  if (!name) return null;
  try {
    return await useFiles.getState().mkdir(parentId, name);
  } catch (err) {
    toast.error(errorMessage(err));
    return null;
  }
}
