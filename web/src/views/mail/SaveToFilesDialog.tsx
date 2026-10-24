import { FILENODE_SET } from "@gilbert/shared/appFolder";
import { errorMessage } from "@gilbert/shared/errors";
import { isTrashFolder } from "@gilbert/shared/trash";
import { ChevronRight, Folder, HardDrive, Home, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { client, setErrorMessage } from "@/jmap/client";
import type { EmailBodyPart, FileNode, Id, SetResponse } from "@/jmap/types";
import { directoryCreate } from "@/lib/filenode";
import { sortFiles } from "@/lib/fileSort";
import { plural, t as translate } from "@/lib/i18n";
import { DEFAULT_FILES_SORT } from "@/lib/lastPlace";
import { groupMailboxAccounts, shortAccountName } from "@/lib/mailAccounts";
import { readChildren, useFiles, withoutAppFolder } from "@/store/files";
import { useMail } from "@/store/mail";
import { Dialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

/**
 * Where a message's attachments go when they are saved to Files.
 *
 * Two choices, in the order the reader makes them: whose files, then which
 * folder inside them. Group files belong to the group's own account -- a node
 * created there is the group's from creation, and a member added tomorrow sees
 * it without anybody moving anything -- so the account is the first question
 * rather than a folder tree to go hunting through.
 *
 * The folders are asked of the destination account, not read from the store,
 * which knows only the account Files happens to be browsing: saving into a
 * group's files while the reader's own are open is exactly what this is for. A
 * folder can be made here too, because the commonest thing to want when keeping
 * a message's attachments is a folder for that message.
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
  /* The folder chosen inside the destination: null is its top level, where the
     dialog opens -- a message's attachments filed nowhere in particular is
     still the commonest answer. */
  const [folder, setFolder] = useState<Id | null>(null);
  const [path, setPath] = useState<FileNode[]>([]);
  const [folders, setFolders] = useState<FileNode[] | null>(null);
  const [busy, setBusy] = useState(false);

  /* The reader's own files first, then the groups they are a member of. */
  const places: Array<{ accountId: Id; name: string; group: boolean; full?: string }> = [
    ...(ownAccountId
      ? [{ accountId: ownAccountId, name: translate("My files"), group: false }]
      : []),
    ...groupMailboxAccounts(mailAccounts).map((a) => ({
      accountId: a.accountId,
      name: shortAccountName(a.name),
      group: true,
      full: a.name,
    })),
  ];
  const chosen = places.find((p) => p.accountId === destination) ?? null;

  /*
   * Choosing an account also clears the folder, in the same update.
   *
   * A folder belongs to the account it is in: the path from the account being
   * left is a set of ids that mean nothing in the new one, and asking the new
   * account about them is a query for somebody else's folders. It is done here,
   * with the choice, rather than in an effect on `destination` -- an effect runs
   * *after* the render that changed it, and the listing effect runs in that same
   * pass with the old folder still in its closure, so it would go and ask.
   */
  const choose = (accountId: Id) => {
    if (accountId === destination) return;
    setDestination(accountId);
    setFolder(null);
    setPath([]);
  };

  /*
   * The level on screen, read from the destination account.
   *
   * `isTopLevel` at the top and `parentId` below it -- the two filters Files
   * itself relies on, since `name` is not one Stalwart implements. The hidden
   * app folder is left out: it is housekeeping, and offering it as a place to
   * file a message's attachments would offer a folder the reader never sees in
   * Files. The level is read whole through the Files store's own pager,
   * `readChildren`, in pages of what the server resolves: a single request would
   * offer the first page of the level and silently hide the folders past it. A
   * read that fails says so rather than drawing an empty folder.
   */
  useEffect(() => {
    if (!destination) return;
    let live = true;
    setFolders(null);
    void (async () => {
      try {
        const listed = withoutAppFolder(await readChildren(destination, folder));
        if (!live) return;
        setFolders(
          sortFiles(
            listed.filter((n) => n.nodeType === "directory" && !isTrashFolder(n)),
            DEFAULT_FILES_SORT,
          ),
        );
      } catch (err) {
        if (!live) return;
        setFolders([]);
        toast.error(errorMessage(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [destination, folder]);

  const enter = (node: FileNode) => {
    setFolder(node.id);
    setPath((p) => [...p, node]);
  };

  /** Back up the breadcrumb: -1 is the top level itself. */
  const goUp = (to: number) => {
    const next = to < 0 ? [] : path.slice(0, to + 1);
    setPath(next);
    setFolder(next.length ? next[next.length - 1]!.id : null);
  };

  const newFolder = async () => {
    if (!destination) return;
    const name = (
      await promptDialog({
        title: translate("New folder"),
        placeholder: translate("Folder name"),
      })
    )?.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await client.call<SetResponse<FileNode>>(FILENODE_SET, {
        accountId: destination,
        create: { d: directoryCreate(folder, name) },
      });
      const err = res.notCreated?.d;
      if (err) throw new Error(setErrorMessage(err));
      const made = res.created!.d!;
      const node = { ...made, name, nodeType: "directory", parentId: folder } as FileNode;
      // Beside its siblings in the level's own order, and open -- making a
      // folder in order to save into it is one intention, not two.
      setFolders((list) => sortFiles([...(list ?? []), node], DEFAULT_FILES_SORT));
      enter(node);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

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
      const { saved, failed, existing } = await useFiles
        .getState()
        .uploadTo(chosen.accountId, files, folder);
      if (failed.length)
        toast.error(
          plural(failed.length, {
            one: "{n} attachment could not be saved to Files.",
            other: "{n} attachments could not be saved to Files.",
          }),
        );
      /*
       * A name the folder already holds is said out loud rather than passed
       * over: the file is still there and was not touched, and a reader who
       * kept something under that name has to know nothing happened to it.
       */
      if (existing.length)
        toast.error(
          plural(
            existing.length,
            {
              one: "“{name}” is already in this folder. Nothing was replaced.",
              other: "{n} files are already in this folder. Nothing was replaced.",
            },
            { name: existing[0] ?? "" },
          ),
        );
      if (saved)
        toast.success(
          plural(
            saved,
            {
              one: "Saved {n} file to {where}.",
              other: "Saved {n} files to {where}.",
            },
            { where: where },
          ),
        );
      // Nothing landed and something was refused: stay open so the retry is
      // one tap rather than a reopened menu.
      if (saved || !failed.length) onClose();
    } catch (err) {
      toast.error(errorMessage(err) || translate("Could not save the attachments."));
    } finally {
      setBusy(false);
    }
  };

  /** Where the files are going, named the way the breadcrumb reads. */
  const where = path.length
    ? `${chosen?.name ?? ""} / ${path.map((n) => n.name).join(" / ")}`
    : (chosen?.name ?? "");

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
            {path.length ? translate("Save here") : translate("Save all")}
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
              title={p.full}
              disabled={busy}
              onClick={() => choose(p.accountId)}
            >
              {p.group ? <Users size={14} /> : <HardDrive size={14} />} {p.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">{translate("There is nowhere to save files to.")}</p>
      )}

      {chosen && (
        <>
          {/* The folder inside the account chosen, gone through the way a file
              manager is: the breadcrumb is the way back up, a row is the way in,
              and a new folder can be made at the level on screen. */}
          <div className="row wrap gap-4" style={{ marginTop: 12 }}>
            <button
              className={`btn btn-sm ${path.length ? "" : "btn-primary"}`}
              disabled={busy}
              onClick={() => goUp(-1)}
            >
              <Home size={14} /> {translate("Top level")}
            </button>
            {path.map((n, i) => (
              <span key={n.id} className="row gap-4">
                <ChevronRight size={12} className="faint" />
                <button
                  className={`btn btn-sm ${i === path.length - 1 ? "btn-primary" : ""}`}
                  disabled={busy}
                  onClick={() => goUp(i)}
                >
                  {n.name}
                </button>
              </span>
            ))}
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void newFolder()}
            >
              {translate("New folder")}
            </button>
          </div>
          <div style={{ maxHeight: 180, overflowY: "auto", marginTop: 8 }}>
            {folders === null ? (
              <p className="hint">{translate("Loading…")}</p>
            ) : folders.length ? (
              folders.map((f) => (
                <button
                  key={f.id}
                  className="menu-item"
                  disabled={busy}
                  onClick={() => enter(f)}
                >
                  <Folder size={16} />
                  <span className="grow">{f.name}</span>
                  <ChevronRight size={14} />
                </button>
              ))
            ) : (
              <p className="hint">{translate("No subfolders here.")}</p>
            )}
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            {translate("Going to: {where}", { where })}
          </p>
        </>
      )}
    </Dialog>
  );
}
