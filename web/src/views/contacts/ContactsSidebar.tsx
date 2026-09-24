import {
  Book,
  BookOpen,
  Download,
  Eraser,
  Globe,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  Upload,
  UserMinus,
  Users,
  X,
} from "lucide-react";
import { Fragment, Suspense, useEffect, useRef, useState } from "react";
import { setErrorMessage } from "@/jmap/client";
import type { AddressBook } from "@/jmap/types";
import { isGlobalContactsBook } from "@/lib/contacts";
import { plural, t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { refreshSharesInto } from "@/lib/sharedCollections";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { toast } from "@/ui/toast";
import { LazyShareDialog } from "../lazyPieces";
import { GlobalContactsEditor } from "./GlobalContactsEditor";

/**
 * Newly shared books appear without a sign-in: the session is re-read and this
 * store initialised on top of it.
 */
const refreshShares = (force = false): Promise<void> =>
  refreshSharesInto(force, () => useContacts.getState().init());

/**
 * Address books in the app's own left pane, the reader's above and other
 * people's below.
 *
 * The two are kept plainly apart rather than merged into one list: a book that
 * belongs to somebody else behaves differently -- you cannot add to it, and
 * what you do see depends on what they granted -- and a list that hid that
 * distinction would be lying about whose contacts these are.
 */
export function ContactsSidebar() {
  /* Import and export are the view's to carry out -- it holds the cards -- so
     they are asked for by event rather than reaching across into it. What has
     changed is that the event now names the book, instead of meaning "whatever
     is selected". */
  const onImport = (file: File, bookId: string) =>
    window.dispatchEvent(
      new CustomEvent("ihm:contacts-import", { detail: { file, bookId } }),
    );
  const onExport = (accountId: string | null, bookId: string) =>
    window.dispatchEvent(
      new CustomEvent("ihm:contacts-export", { detail: { accountId, bookId } }),
    );
  const contacts = useContacts();
  const settings = useSettings((s) => s.settings);
  const mailAccounts = useMail((s) => s.mailAccounts);
  const isAdmin = useSession((s) => s.session?.gilbert?.isAdmin === true);
  /** The directory the administrator is editing, when the editor is open. */
  const [editingGlobal, setEditingGlobal] = useState<{
    accountId: string;
    bookId: string;
  } | null>(null);
  /*
   * What the open menu belongs to. One state rather than three, because the
   * rows differ in what they can offer: everything can be exported, only your
   * own can be imported into or deleted, and a book can be renamed when it
   * grants the write -- which a group's own directory does for a member, and a
   * colleague's writable share does for whoever they gave it to.
   */
  type MenuTarget =
    | { kind: "all" }
    | { kind: "own"; book: AddressBook }
    | { kind: "shared"; accountId: string; book: AddressBook };
  const [target, setTarget] = useState<MenuTarget | null>(null);
  const menuBook = target && target.kind === "own" ? target.book : null;
  /*
   * The file picker for "Import contacts…". A MenuItem is a button and cannot
   * wrap a hidden input, so the input lives at the end of the sidebar and the
   * menu item reaches it through this -- the same arrangement the calendar's
   * iCAL import uses, which is the point of #224.
   *
   * The book is remembered separately because opening the picker closes the
   * menu, and `target` goes with it: by the time a file comes back there would
   * be nothing left saying which book it was chosen for.
   */
  const fileRef = useRef<HTMLInputElement>(null);
  const importInto = useRef<string | null>(null);
  const openMenu = (e: React.MouseEvent, t: MenuTarget) => {
    e.stopPropagation();
    e.preventDefault();
    setTarget(t);
    menu.open(e);
  };
  const openMenuAt = (e: React.MouseEvent, t: MenuTarget) => {
    e.preventDefault();
    setTarget(t);
    menu.openAt(e.clientX, e.clientY);
  };
  const [share, setShare] = useState<AddressBook | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const menu = useMenu();

  useEffect(() => {
    void refreshShares();
  }, []);

  if (!contacts.available) return null;

  const own = Object.values(contacts.books).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  const sel = contacts.selection;
  const isOn = (accountId: string | null, bookId: string) =>
    sel.accountId === accountId && sel.bookId === bookId;
  /* Added if the server says so or the reader's settings do -- Stalwart will
     not take the flag on a book shared read-only, so the settings carry it. */
  const added = new Set(settings.addedShares);
  const isAdded = (accountId: string, bookId: string) =>
    added.has(`${accountId}:${bookId}`);
  /* Group mailboxes get one section each, with their own "+": a book made
     there is created in the group's own account, so it belongs to the group
     and every member reaches it -- no share to maintain. Any other shared
     account (a colleague's share) stays in the read-only area below. */
  /* The product-admin group is not a working group: it never gets a section
     or a "+", and its books fall into the read-only area below. */
  const groups = groupMailboxAccounts(mailAccounts);
  const groupIds = new Set(groups.map((g) => g.accountId));
  /*
   * The installation's directory (ADR 0024): one book, read by everyone and
   * never "added". It leads the Contacts list rather than sitting in "Shared
   * with me", because it is not somebody's share — it is the installation's —
   * and it is shown whether or not a member subscribed to it.
   */
  const globalBooks = contacts.sharedBooks.filter((b) => isGlobalContactsBook(b.book));
  const others = contacts.sharedBooks.filter((b) => !isGlobalContactsBook(b.book));
  const sharedOnlySubscribed = others.filter(
    (b) =>
      !groupIds.has(b.accountId) &&
      (b.book.isSubscribed || isAdded(b.accountId, b.book.id)),
  );
  const sharedOnlyAvailable = others.filter(
    (b) =>
      !groupIds.has(b.accountId) &&
      !(b.book.isSubscribed || isAdded(b.accountId, b.book.id)),
  );
  /* Shared rows, used under a group's section and in the read-only area for
     shares that are not a group. Keying is the caller's job. */
  const subscribedRow = (accountId: string, accountName: string, book: AddressBook) => (
    <div
      className={`nav-item ${isOn(accountId, book.id) ? "active" : ""}`}
      onClick={() => contacts.select({ accountId, bookId: book.id })}
      title={t("{name} — shared by {owner}", { name: book.name, owner: accountName })}
      onContextMenu={(e) => openMenuAt(e, { kind: "shared", accountId, book })}
    >
      <BookOpen size={17} />
      <span className="grow truncate">{book.name}</span>
      {/* A menu rather than a bare X: somebody else's book can still be
          exported, and a single dismiss control would have nowhere to put
          that. */}
      <button
        className="icon-btn xs nav-more"
        onClick={(e) => openMenu(e, { kind: "shared", accountId, book })}
        aria-label={t("Address book options")}
      >
        <MoreVertical size={14} />
      </button>
    </div>
  );
  /*
   * Renaming a book, wherever it lives.
   *
   * Offered to whoever the book grants a write to: the reader's own always, a
   * group's own directory for its members, a colleague's share for whoever
   * they opened it to. The account goes with it -- a row knows which one it
   * is, and a book id alone cannot say, because a default book is seeded per
   * account and the reader's own may carry the group's id.
   */
  const renameItem = (book: AddressBook, accountId?: string | null) => (
    <MenuItem
      icon={<Pencil size={16} />}
      label={t("Rename")}
      onClick={async () => {
        const name = await promptDialog({
          title: t("Rename address book"),
          defaultValue: book.name,
        });
        if (!name?.trim() || name === book.name) return;
        try {
          await contacts.updateBook(book.id, { name: name.trim() }, accountId);
        } catch (err) {
          toast.error((err as Error).message);
        }
      }}
    />
  );
  const availableRow = (accountId: string, accountName: string, book: AddressBook) => (
    <div
      className="nav-item"
      title={t("{name} — from {owner}", { name: book.name, owner: accountName })}
    >
      <BookOpen size={17} className="faint" />
      <span className="grow truncate faint">{book.name}</span>
      <button
        className="icon-btn sm"
        title={t("Add to my contacts")}
        aria-label={t("Add to my contacts")}
        onClick={(e) => {
          e.stopPropagation();
          void contacts.setBookSubscribed(accountId, book.id, true);
        }}
      >
        <Plus size={13} />
      </button>
    </div>
  );

  return (
    <>
      <div className="nav-section">
        <span>{t("Contacts")}</span>
      </div>
      {/* The installation's directory (ADR 0024): one book, read by everyone,
          shown whether or not a member subscribed to it. */}
      {globalBooks.map(({ accountId, book }) => (
        <div
          key={`${accountId}:${book.id}`}
          className={`nav-item ${isOn(accountId, book.id) ? "active" : ""}`}
          onClick={() => contacts.select({ accountId, bookId: book.id })}
          title={t("{name} — shared with everyone", { name: book.name })}
        >
          <Globe size={17} />
          <span className="grow truncate">{book.name}</span>
          {/* Only an administrator writes the directory (ADR 0024), and from
              inside Contacts: everybody else reads the same book. */}
          {isAdmin && (
            <button
              className="icon-btn xs nav-more"
              title={t("Edit Global contacts")}
              aria-label={t("Edit Global contacts")}
              onClick={(e) => {
                e.stopPropagation();
                setEditingGlobal({ accountId, bookId: book.id });
              }}
            >
              <Pencil size={14} />
            </button>
          )}
        </div>
      ))}
      <div
        className={`nav-item ${isOn(null, "all") ? "active" : ""}`}
        onClick={() => contacts.select({ accountId: null, bookId: "all" })}
        onContextMenu={(e) => openMenuAt(e, { kind: "all" })}
      >
        <Users size={17} />
        <span className="grow truncate">{t("All contacts")}</span>
        <button
          className="icon-btn xs nav-more"
          onClick={(e) => openMenu(e, { kind: "all" })}
          aria-label={t("Contact options")}
        >
          <MoreVertical size={14} />
        </button>
      </div>

      <div className="nav-section">
        <span>{t("My contacts")}</span>
        <button
          className="icon-btn sm"
          title={t("New address book")}
          aria-label={t("New address book")}
          onClick={async () => {
            const name = await promptDialog({
              title: t("New address book"),
              placeholder: t("Name"),
            });
            if (!name?.trim()) return;
            try {
              await contacts.createBook(name.trim());
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      {own.map((b) => (
        <div
          key={b.id}
          className={`nav-item ${isOn(null, b.id) ? "active" : ""}`}
          onClick={() => contacts.select({ accountId: null, bookId: b.id })}
          onContextMenu={(e) => openMenuAt(e, { kind: "own", book: b })}
        >
          <Book size={17} />
          <span className="grow truncate">{b.name}</span>
          {Object.keys(b.shareWith ?? {}).length > 0 && (
            <Share2 size={12} className="faint" aria-label={t("Shared")} />
          )}
          <button
            className="icon-btn xs nav-more"
            onClick={(e) => openMenu(e, { kind: "own", book: b })}
            aria-label={t("Address book options")}
          >
            <MoreVertical size={14} />
          </button>
        </div>
      ))}

      {groups.length > 0 && (
        <div className="nav-section">
          <span>{t("Group contacts")}</span>
        </div>
      )}
      {groups.map((g) => (
        <Fragment key={g.accountId}>
          <div className="nav-section">
            <span>{g.name}</span>
            <button
              className="icon-btn sm"
              title={t("New address book in {group}", { group: g.name })}
              aria-label={t("New address book in {group}", { group: g.name })}
              onClick={async () => {
                const name = await promptDialog({
                  title: t("New address book"),
                  placeholder: t("Name"),
                });
                if (!name?.trim()) return;
                try {
                  await contacts.createBook(name.trim(), g.accountId);
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            >
              <Plus size={14} />
            </button>
          </div>
          {contacts.sharedBooks
            .filter((b) => b.accountId === g.accountId && !isGlobalContactsBook(b.book))
            .map((b) => (
              <Fragment key={`${b.accountId}:${b.book.id}`}>
                {/* A group's books need no adding: membership of the group is
                    the subscription (see the composer picker and loadShared). */}
                {subscribedRow(b.accountId, b.accountName, b.book)}
              </Fragment>
            ))}
        </Fragment>
      ))}

      <div className="nav-section">
        <span>{t("Shared with me")}</span>
        <button
          className="icon-btn sm"
          title={t("Check for new shares")}
          aria-label={t("Check for new shares")}
          onClick={async () => {
            setRefreshing(true);
            await refreshShares(true);
            setRefreshing(false);
          }}
        >
          <RefreshCw size={14} className={refreshing ? "spin" : ""} />
        </button>
      </div>
      {sharedOnlySubscribed.map(({ accountId, accountName, book }) => (
        <Fragment key={`${accountId}:${book.id}`}>
          {subscribedRow(accountId, accountName, book)}
        </Fragment>
      ))}
      {sharedOnlySubscribed.length === 0 && (
        <p className="hint" style={{ padding: "4px 12px" }}>
          {contacts.sharedLoaded ? t("Nothing added yet.") : t("Looking…")}
        </p>
      )}

      {/* Stalwart returns every book in a reachable account with full rights,
          shared or not, so adding one is the reader's decision rather than a
          guess made on their behalf. */}
      {sharedOnlyAvailable.length > 0 && (
        <>
          <div className="nav-section">
            <span>{t("Available to add")}</span>
          </div>
          {sharedOnlyAvailable.map(({ accountId, accountName, book }) => (
            <Fragment key={`${accountId}:${book.id}`}>
              {availableRow(accountId, accountName, book)}
            </Fragment>
          ))}
        </>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".vcf,.vcard,.ldif,.ldi,text/vcard,text/directory"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          const into = importInto.current;
          if (f && into) onImport(f, into);
          e.target.value = "";
        }}
      />

      <Popover
        anchor={menu.anchor}
        onClose={menu.close}
        trigger={menu.trigger}
        width={230}
      >
        {target && (
          <>
            {/* Exporting is the one thing every row can do -- your own books,
                somebody else's, and the whole lot together. */}
            <MenuItem
              icon={<Download size={16} />}
              label={
                target.kind === "all"
                  ? t("Export all contacts")
                  : t("Export address book")
              }
              onClick={() =>
                onExport(
                  target.kind === "shared" ? target.accountId : null,
                  target.kind === "all" ? "all" : target.book.id,
                )
              }
            />
            {/* Importing needs somewhere to put them. "All contacts" is not a
                book, so it files into the default one, which is what the button
                at the foot of the sidebar quietly did anyway. */}
            {target.kind !== "shared" && (
              <MenuItem
                icon={<Upload size={16} />}
                label={t("Import contacts…")}
                onClick={() => {
                  importInto.current = target.kind === "all" ? "all" : target.book.id;
                  fileRef.current?.click();
                }}
              />
            )}
            {target.kind === "shared" && (
              <>
                {/* A group's own directory is renamed by its members here, and
                    a colleague's writable share by whoever they opened it to:
                    both are books the reader may write. */}
                {target.book.myRights?.mayWrite && (
                  <>
                    <MenuSep />
                    {renameItem(target.book, target.accountId)}
                  </>
                )}
                <MenuSep />
                <MenuItem
                  icon={<X size={16} />}
                  label={t("Remove from my contacts")}
                  onClick={() =>
                    void contacts.setBookSubscribed(
                      target.accountId,
                      target.book.id,
                      false,
                    )
                  }
                />
              </>
            )}
          </>
        )}
        {menuBook && (
          <>
            <MenuSep />
            {renameItem(menuBook)}
            <MenuItem
              icon={<Share2 size={16} />}
              label={t("Share…")}
              disabled={!menuBook.myRights?.mayShare}
              onClick={() => setShare(menuBook)}
            />
            {/* Revoking the lot, rather than removing people one at a time in
                the dialog. Only shown when there is something to revoke. */}
            {Object.keys(menuBook.shareWith ?? {}).length > 0 && (
              <MenuItem
                icon={<UserMinus size={16} />}
                label={t("Stop sharing")}
                disabled={!menuBook.myRights?.mayShare}
                onClick={async () => {
                  const who = Object.keys(menuBook.shareWith ?? {}).length;
                  if (
                    !(await confirmDialog({
                      title: t("Stop sharing “{name}”?", { name: menuBook.name }),
                      message: plural(who, {
                        one: "{n} person will lose access. The contacts in it are not affected.",
                        other:
                          "{n} people will lose access. The contacts in it are not affected.",
                      }),
                      confirmLabel: t("Stop sharing"),
                      danger: true,
                    }))
                  )
                    return;
                  try {
                    await contacts.updateBook(menuBook.id, { shareWith: null });
                    toast.success(t("No longer shared"));
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }}
              />
            )}
            <MenuSep />
            {/*
              The operation a migration actually asks for: import, notice
              something is wrong, empty the book, correct the export, import
              again. Offered on your own books only -- emptying somebody else's
              is a write to their account, which this client cannot make.

              Kept apart from Delete, which takes the book with it. A default
              book cannot be deleted and can perfectly well be emptied, which
              is most of why this is worth having as its own entry.
            */}
            <MenuItem
              danger
              icon={<Eraser size={16} />}
              label={t("Empty address book")}
              onClick={async () => {
                const n = Object.values(contacts.cards).filter(
                  (c) => c.addressBookIds?.[menuBook.id],
                ).length;
                if (!n) {
                  toast.error(t("There is nothing in it to delete"));
                  return;
                }
                if (
                  !(await confirmDialog({
                    title: t("Empty “{name}”?", { name: menuBook.name }),
                    message: plural(n, {
                      one: "{n} contact will be deleted. This cannot be undone.",
                      other: "{n} contacts will be deleted. This cannot be undone.",
                    }),
                    confirmLabel: t("Delete them"),
                    danger: true,
                  }))
                )
                  return;
                try {
                  const { destroyed, unfiled, refused } = await contacts.emptyBook(
                    menuBook.id,
                  );
                  if (destroyed)
                    toast.success(
                      plural(destroyed, {
                        one: "Deleted {n} contact",
                        other: "Deleted {n} contacts",
                      }),
                    );
                  /* Said out loud, because it is the one part of emptying a
                     book that is not a deletion and would otherwise look like
                     contacts that refused to go. */
                  if (unfiled) {
                    toast.show(
                      plural(unfiled, {
                        one: "{n} was also in another address book and was only removed from this one",
                        other:
                          "{n} were also in other address books and were only removed from this one",
                      }),
                      { duration: 9000 },
                    );
                  }
                  if (refused)
                    toast.error(
                      t("Some could not be deleted: {error}", {
                        error: setErrorMessage(refused),
                      }),
                    );
                  else if (!destroyed && !unfiled) toast.error(t("Nothing was deleted"));
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            />
            <MenuItem
              danger
              icon={<Trash2 size={16} />}
              label={t("Delete")}
              disabled={menuBook.isDefault}
              onClick={async () => {
                if (
                  !(await confirmDialog({
                    title: t("Delete “{name}”?", { name: menuBook.name }),
                    message: t("The contacts in it go too."),
                    confirmLabel: t("Delete"),
                    danger: true,
                  }))
                )
                  return;
                try {
                  await contacts.destroyBook(menuBook.id);
                  if (sel.bookId === menuBook.id)
                    contacts.select({ accountId: null, bookId: "all" });
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            />
          </>
        )}
      </Popover>
      {editingGlobal && (
        <GlobalContactsEditor
          accountId={editingGlobal.accountId}
          bookId={editingGlobal.bookId}
          onClose={() => setEditingGlobal(null)}
        />
      )}
      {share && (
        <Suspense fallback={null}>
          <LazyShareDialog
            kind="AddressBook"
            id={share.id}
            name={share.name}
            shareWith={share.shareWith}
            onClose={() => setShare(null)}
          />
        </Suspense>
      )}
    </>
  );
}
