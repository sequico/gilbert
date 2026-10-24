import { useEffect, useRef, useState } from "react";
import { loadOpenAccounts, placeOwnerFrom, rememberOpenAccounts } from "@/lib/lastPlace";
import { accountKey, deviceKey, storageOf } from "@/lib/storage";
import { useSession } from "@/store/session";

/**
 * Which mail accounts the reader has opened under the one in front.
 *
 * The account in the foreground is always open -- it is the tree the sidebar is
 * about -- so this record only ever says something about the others, and an
 * account is folded until the reader opens it. Absence is "folded", which is
 * also what a change of foreground leaves behind: bringing an account to the
 * front puts every other one back in the list folded, because the shape they
 * were opened into belonged to the account that was in front before. That
 * switch is the mail store's (`setAccount` calls `forgetOpenAccounts`), not the
 * sidebar's -- an account can be opened with no sidebar mounted to see it.
 *
 * The record is the reader's and this browser's. The tab holds it in session
 * storage, so a reload does not lose it; across sessions only a device marked
 * as the reader's own knows it, where `lastPlace` keeps it beside the folders
 * that were open. Nothing here is an account setting: which account a reader
 * happened to unfold on one machine is not a preference to inherit on another.
 */
export function useAccountFold(): {
  /** The accounts that are open. An account absent from it is folded. */
  open: Record<string, boolean>;
  /** Open or fold one account, remembering it for the next visit. */
  toggle(accountId: string): void;
} {
  const owner = useSession((s) => placeOwnerFrom(s));
  const [open, setOpen] = useState<Record<string, boolean>>(() => load(owner));
  const loadedFor = useRef(owner);

  useEffect(() => {
    if (loadedFor.current === owner) return;
    loadedFor.current = owner;
    setOpen(load(owner));
  }, [owner]);

  /** One write path, so what is on screen and what is remembered cannot part. */
  const write = (next: Record<string, boolean>) => {
    setOpen(next);
    save(owner, next);
  };

  return {
    open,
    toggle: (accountId) => {
      // Only the open ones are written; a folded account is one that is absent.
      const next = { ...open };
      if (next[accountId]) delete next[accountId];
      else next[accountId] = true;
      write(next);
    },
  };
}

/**
 * Fold every account under the one in front.
 *
 * Called where the foreground actually moves (`setAccount` in the mail store),
 * because that is the fact and not a sidebar that happens to be mounted: an
 * account opened from Settings leaves the sidebar no moment at which to notice.
 */
export function forgetOpenAccounts(owner: string | null): void {
  save(owner, {});
}

/** The tab's key for one reader's record, beside the one `lastPlace` keeps. */
function sessionKey(owner: string | null): string {
  return deviceKey(accountKey(owner, "openAccounts"));
}

function load(owner: string | null): Record<string, boolean> {
  try {
    const raw = storageOf("session")?.getItem(sessionKey(owner));
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    /* an unreadable record is an account folded, not a broken sidebar */
  }
  return loadOpenAccounts(owner);
}

function save(owner: string | null, open: Record<string, boolean>): void {
  try {
    storageOf("session")?.setItem(sessionKey(owner), JSON.stringify(open));
  } catch {
    /* private mode: the tree still folds for this render */
  }
  rememberOpenAccounts(owner, open);
}
