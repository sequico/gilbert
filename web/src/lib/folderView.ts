import { useEffect, useRef, useState } from "react";
import {
  loadOpenFolders,
  placeOwnerFrom,
  rememberOpenFolders,
  type TreeKind,
} from "@/lib/lastPlace";
import { useSession } from "@/store/session";

/**
 * Which folders are open in a sidebar tree.
 *
 * **Absence is not "shut" -- it is "whatever this tree does by default",** and
 * the sidebar trees default differently. The reader's own mail opens shut: it
 * is theirs, they know its shape, and a dozen folders they rarely use are noise
 * in front of the one they want, and the knowledge base opens shut too. A tree
 * that is not theirs -- a group they are a member of -- opens its folders,
 * because its shape is not something they chose, its folders are the reason
 * they are looking, and a member who has just been added has to be able to see
 * where the group's mail lives without being told to click. A folder the reader
 * opens or closes is recorded as exactly that, either way, so the one they shut
 * stays shut.
 *
 * The record is the reader's, kept beside the place their trees were left in
 * (`lastPlace.ts`): device-local, one per reader, and read back on the next
 * visit to the tab. It is not an account setting -- a folder opened is not a
 * preference to inherit on another machine, and syncing it would rewrite the
 * account's settings file on every click in a tree.
 *
 * Keys are **per account and per folder** (`folderKey`). Mailbox, file and
 * knowledge-folder ids come from the server and are only unique within one
 * account, so a bare id remembered under one account would open whatever happens
 * to carry it in the next -- which is what a tree that looks expanded after
 * switching to a group mailbox is: somebody else's ids, read as this account's.
 *
 * **Nothing prunes the record.** A folder leaves it when the reader deletes
 * that folder, and a sign-out clears the whole thing; a folder deleted elsewhere
 * keeps its entry until one of those happens. What that costs is one line in
 * this browser's storage per folder ever touched, and it buys a tree that does
 * not have to decide what a missing folder meant.
 */
export function folderKey(accountId: string | null | undefined, id: string): string {
  return `${accountId ?? "anon"}/${id}`;
}

export interface OpenFolders {
  /** The folders that are open. A folder absent from it is shut. */
  open: Record<string, boolean>;
  /** Open or shut one folder, remembering it for the next session. */
  setFolder(key: string, value: boolean): void;
  /** Open folders, for a branch that has to be shown -- where the reader is. */
  openKeys(keys: string[]): void;
}

/**
 * The open folders of one tree, for the account the reader is signed in as.
 *
 * The record is read at mount and again whenever **the reader changes**,
 * because the tree usually mounts before the session has answered: a first
 * read with no reader yields the collapsed default, and the effect is what
 * turns a remembered tree into the one on screen once there is somebody to
 * read it for.
 *
 * A change of reader *replaces* what is on screen rather than merging into it.
 * A toggle made while there was no reader (nothing to remember it for, so it
 * was never written) is dropped when one arrives, and a folder one reader left
 * open does not stay open for whoever signs in next on this device -- which is
 * the opposite of what this record is for.
 */
export function useOpenFolders(kind: TreeKind): OpenFolders {
  const owner = useSession((s) => placeOwnerFrom(s));
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    loadOpenFolders(owner, kind),
  );
  const loadedFor = useRef(owner);

  useEffect(() => {
    if (loadedFor.current === owner) return;
    loadedFor.current = owner;
    setOpen(loadOpenFolders(owner, kind));
  }, [owner, kind]);

  /** One write path, so what is on screen and what is remembered cannot part. */
  const write = (next: Record<string, boolean>) => {
    setOpen(next);
    rememberOpenFolders(owner, kind, next);
  };

  return {
    open,
    setFolder: (key, value) => {
      if (open[key] === value) return;
      /*
       * Written either way, because absence means "the tree's own default" and
       * not `false`: a folder this reader closed in a tree that opens its
       * folders has to be recorded as closed, or it would come back open.
       */
      write({ ...open, [key]: value });
    },
    openKeys: (keys) => {
      const unopened = keys.filter((k) => !open[k]);
      if (!unopened.length) return;
      const next = { ...open };
      for (const k of unopened) next[k] = true;
      write(next);
    },
  };
}
