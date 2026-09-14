import { HardDrive, Users } from "lucide-react";
import { useState } from "react";
import { client } from "@/jmap/client";
import type { EmailBodyPart, Id } from "@/jmap/types";
import { plural, t as translate } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { useFiles } from "@/store/files";
import { useMail } from "@/store/mail";
import { Dialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

/**
 * Where a message's attachments go when they are saved to Files.
 *
 * Two kinds of place, and the reader picks: their own files, or a group's.
 * Group files belong to the group's own account -- a node created there is the
 * group's from creation, and a member added tomorrow sees it without anybody
 * moving anything -- so what the dialog offers is an account, named, rather
 * than a folder tree to go hunting in.
 *
 * The blobs are fetched from the mailbox holding the message and uploaded into
 * the account chosen, because a file node can only point at a blob its own
 * account holds.
 */
export function SaveToFilesDialog({
  accountId,
  attachments,
  onClose,
}: {
  /** The account holding the blobs: the mailbox the message is in. */
  accountId: Id;
  attachments: EmailBodyPart[];
  onClose: () => void;
}) {
  const ownAccountId = useFiles((s) => s.ownAccountId);
  const mailAccounts = useMail((s) => s.mailAccounts);
  const [destination, setDestination] = useState<Id | null>(ownAccountId);
  const [busy, setBusy] = useState(false);

  /* The reader's own files first, then the groups they are a member of. */
  const places: Array<{ accountId: Id; name: string; group: boolean }> = [
    ...(ownAccountId
      ? [{ accountId: ownAccountId, name: translate("My files"), group: false }]
      : []),
    ...groupMailboxAccounts(mailAccounts).map((a) => ({
      accountId: a.accountId,
      name: a.name,
      group: true,
    })),
  ];
  const chosen = places.find((p) => p.accountId === destination) ?? null;

  const save = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const files: File[] = [];
      for (const a of attachments) {
        if (!a.blobId) continue;
        const type = a.type || "application/octet-stream";
        const blob = await client.fetchBlob(accountId, a.blobId, type);
        files.push(new File([blob], a.name ?? "attachment", { type }));
      }
      const { saved, failed } = await useFiles
        .getState()
        .uploadTo(chosen.accountId, files);
      if (failed.length)
        toast.error(
          plural(failed.length, {
            one: "{n} attachment could not be saved to Files.",
            other: "{n} attachments could not be saved to Files.",
          }),
        );
      if (saved)
        toast.success(
          plural(
            saved,
            {
              one: "Saved {n} file to {where}.",
              other: "Saved {n} files to {where}.",
            },
            { where: chosen.name },
          ),
        );
      // Nothing landed and something was refused: stay open so the retry is
      // one tap rather than a reopened menu.
      if (saved || !failed.length) onClose();
    } catch (err) {
      toast.error((err as Error).message || translate("Could not save the attachments."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={translate("Download all to Files")}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {translate("Cancel")}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !chosen}
            onClick={() => void save()}
          >
            {translate("Save all")}
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginBottom: 10 }}>
        {plural(attachments.length, {
          one: "Save {n} attachment to Files.",
          other: "Save {n} attachments to Files.",
        })}
      </p>
      {places.length ? (
        <div className="row wrap gap-4">
          {places.map((p) => (
            <button
              key={p.accountId}
              className={`btn btn-sm ${destination === p.accountId ? "btn-primary" : ""}`}
              disabled={busy}
              onClick={() => setDestination(p.accountId)}
            >
              {p.group ? <Users size={14} /> : <HardDrive size={14} />} {p.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">{translate("There is nowhere to save files to.")}</p>
      )}
    </Dialog>
  );
}
