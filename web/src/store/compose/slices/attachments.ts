import { errorMessage } from "@gilbert/shared/errors";
import { client } from "@/jmap/client";
import { uid } from "@/lib/format";
import { t as translate } from "@/lib/i18n";
import { useMail } from "../../mail";
import type {
  ComposeAttachment,
  ComposeGet,
  ComposeSet,
  ComposeState,
  Draft,
} from "../types";

function patchAtt(
  key: string,
  attId: string,
  patch: Partial<ComposeAttachment>,
  set: (fn: (s: ComposeState) => Partial<ComposeState>) => void,
) {
  const applied = (d: Draft): Draft => ({
    ...d,
    dirty: true,
    attachments: d.attachments.map((a) => (a.id === attId ? { ...a, ...patch } : a)),
  });
  set((s) => {
    /*
     * A send takes the draft out of `drafts` and holds it in `pendingSends`
     * until it settles, so an upload that lands in that window has to patch
     * that snapshot as well. Without it the draft a failed send restores keeps
     * `blobId: null` and every later Send refuses it as "still uploading".
     */
    const pending = s.pendingSends[key];
    return {
      drafts: s.drafts.map((d) => (d.key === key ? applied(d) : d)),
      ...(pending
        ? {
            pendingSends: {
              ...s.pendingSends,
              [key]: { ...pending, draft: applied(pending.draft) },
            },
          }
        : {}),
    };
  });
}

/**
 * What a person hangs on a message being written: files from the machine, a
 * file already in Files, and taking one off again.
 *
 * A slice of the compose store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function attachmentsSlice(
  set: ComposeSet,
  get: ComposeGet,
): Pick<ComposeState, "addFiles" | "addFromFiles" | "removeAttachment"> {
  return {
    addFiles(key, files) {
      const accountId =
        get().drafts.find((d) => d.key === key)?.accountId ??
        useMail.getState().accountId;
      if (!accountId) return;
      const max = client.maxSizeUpload;
      const atts: ComposeAttachment[] = files.map((f) => ({
        id: uid("a"),
        name: f.name,
        type: f.type || "application/octet-stream",
        size: f.size,
        blobId: null,
        progress: 0,
        error:
          f.size > max
            ? translate("Larger than {size} MB limit", {
                size: Math.round(max / 1048576),
              })
            : null,
        file: f,
      }));
      get().update(key, {
        attachments: [
          ...(get().drafts.find((d) => d.key === key)?.attachments ?? []),
          ...atts,
        ],
      });
      for (const a of atts) {
        if (a.error || !a.file) continue;
        const abort = new AbortController();
        a.abort = abort;
        client
          .upload(accountId, a.file, {
            type: a.type,
            signal: abort.signal,
            onProgress: (loaded, total) =>
              patchAtt(key, a.id, { progress: Math.round((loaded / total) * 100) }, set),
          })
          .then((res) =>
            patchAtt(
              key,
              a.id,
              {
                blobId: res.blobId,
                progress: 100,
                type: res.type || a.type,
                size: res.size,
              },
              set,
            ),
          )
          .catch((err) =>
            patchAtt(
              key,
              a.id,
              { error: errorMessage(err) || translate("Upload failed") },
              set,
            ),
          );
      }
    },
    /*
     * Attach something already in Files.
     *
     * A blob the account can already see needs no upload: an attachment carrying
     * a `blobId` is exactly what a forward produces, so the send path already
     * knows what to do with one. Attaching a 20 MB file the server is holding
     * anyway then costs nothing and takes no time.
     *
     * A file in an account somebody *shared* is a different matter. Blobs belong
     * to the account they were uploaded to, so a draft in your account cannot
     * reference one in theirs; it is fetched and uploaded to yours. Slower, and
     * unavoidable, but it happens without the reader having to know any of this.
     */
    async addFromFiles(key, nodes) {
      const accountId =
        get().drafts.find((d) => d.key === key)?.accountId ??
        useMail.getState().accountId;
      if (!accountId || !nodes.length) return;
      const max = client.maxSizeUpload;
      const atts: ComposeAttachment[] = nodes.map((n) => {
        /*
         * `maxSizeUpload` is what the server will accept for a single *upload*
         * (RFC 8620), so it only bears on a file that is about to be uploaded.
         *
         * A blob already in this account is attached by reference and nothing is
         * sent, however large it is -- which is the whole point of attaching from
         * Files, and of forwarding a message as an attachment. Applying the limit
         * to those would refuse a 60 MB message the server is already holding, on
         * the grounds that it could not have been uploaded, when it is not being.
         *
         * A file from somebody else's account is fetched and re-uploaded into
         * this one, because a message can only carry blobs from the account
         * sending it. That upload is real, and the limit is real for it.
         */
        const byReference = n.accountId === accountId;
        const tooLargeToUpload = !byReference && (n.size ?? 0) > max;
        return {
          id: uid("a"),
          name: n.name,
          type: n.type || "application/octet-stream",
          size: n.size ?? 0,
          blobId: byReference ? n.blobId : null,
          progress: byReference ? 100 : 0,
          error: tooLargeToUpload
            ? translate("Larger than {size} MB limit", {
                size: Math.round(max / 1048576),
              })
            : null,
        };
      });
      get().update(key, {
        attachments: [
          ...(get().drafts.find((d) => d.key === key)?.attachments ?? []),
          ...atts,
        ],
      });

      for (const [i, a] of atts.entries()) {
        if (a.error || a.blobId) continue;
        const node = nodes[i]!;
        try {
          const blob = await client.fetchBlob(node.accountId, node.blobId, a.type);
          const up = await client.upload(accountId, blob, { type: a.type });
          patchAtt(
            key,
            a.id,
            { blobId: up.blobId, progress: 100, size: up.size || a.size },
            set,
          );
        } catch (err) {
          patchAtt(
            key,
            a.id,
            { error: errorMessage(err) || translate("Could not attach") },
            set,
          );
        }
      }
    },
    removeAttachment(key, attId) {
      const d = get().drafts.find((x) => x.key === key);
      const a = d?.attachments.find((x) => x.id === attId);
      a?.abort?.abort();
      get().update(key, {
        attachments: (d?.attachments ?? []).filter((x) => x.id !== attId),
      });
    },
  };
}
