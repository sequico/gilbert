import { FILENODE_GET } from "@gilbert/shared/appFolder";
import { client } from "@/jmap/client";
import type { FileNode, GetResponse } from "@/jmap/types";
import { fileNodeProps } from "@/lib/filenode";
import { t as translate } from "@/lib/i18n";
import { writeContent } from "../shared";
import type { FilesGet, FilesSet, FilesState } from "../types";

/**
 * Writing text back over a file, and refusing to when somebody else saved.
 *
 * A slice of the files store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function textSlice(_set: FilesSet, get: FilesGet): Pick<FilesState, "saveText"> {
  return {
    async saveText(id, text, seenBlobId) {
      const accountId = get().accountId!;
      /*
       * Look before writing.
       *
       * `ifInState` is the obvious tool and the wrong one here: it is the state
       * of every FileNode in the account, so an unrelated upload in another
       * folder would fail this save, and a reader who is told "someone changed
       * it" when nobody did learns to click through the warning. The node's own
       * blobId is the thing that actually answers the question.
       */
      const fresh = await client.call<GetResponse<FileNode>>(FILENODE_GET, {
        accountId,
        ids: [id],
        properties: fileNodeProps(),
      });
      const now = fresh.list[0];
      if (!now) throw new Error(translate("That file is no longer there."));
      if (now.blobId !== seenBlobId)
        throw new Error(
          translate(
            "Somebody else saved this file while it was open. Copy your changes, close it, and start again.",
          ),
        );

      const type = now.type || "text/plain";
      const blob = new Blob([text], { type });
      const up = await client.upload(accountId, blob, { type });
      await writeContent(accountId, id, up.blobId, type, blob.size);
      await get().refresh([id]);
      return up.blobId;
    },
  };
}
