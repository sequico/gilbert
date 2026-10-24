import { errorMessage } from "@gilbert/shared/errors";
import { AGENT_LABELS } from "@gilbert/shared/labels";
import {
  AlertOctagon,
  Archive,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eraser,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderInput,
  FolderPlus,
  Inbox,
  Mail,
  MoreVertical,
  Palette,
  Pencil,
  Plus,
  Send,
  Share2,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  type DragEvent,
  Fragment,
  memo,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation } from "wouter";
import type { Id, Mailbox } from "@/jmap/types";
import { useAccountFold } from "@/lib/accountFold";
import { CALENDAR_COLORS } from "@/lib/calendarColors";
import { askDeleteFolder } from "@/lib/deleteConfirm";
import { useEffectiveLabels, useIsGroupMailbox } from "@/lib/effectiveLabels";
import { canEmpty, confirmAndEmpty, emptyLabel } from "@/lib/emptyFolder";
import { canDropFolder, canMoveFolderTo, folderColor, movable } from "@/lib/folderMove";
import { foldersByParent } from "@/lib/folderOrder";
import { folderKey, useOpenFolders } from "@/lib/folderView";
import { t } from "@/lib/i18n";
import { countOf, STARRED_KEYWORD } from "@/lib/keywordCounts";
import { labelTree, visibleLabels } from "@/lib/labelTree";
import { isOwnMailAccount } from "@/lib/mailAccounts";
import { mailboxDisplayName } from "@/lib/mailboxName";
import { folderDestroyTakesMail } from "@/lib/mailDelete";
import { EMAILS_MIME, FOLDER_MIME } from "@/lib/mime";
import { haptic, useTouchRow } from "@/lib/touch";
import { useMayDestroy } from "@/lib/useMayDestroy";
import { useMail } from "@/store/mail";
import { isScheduledMailbox } from "@/store/scheduled";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
import { promptDialog } from "@/ui/dialog";
import { useIsMobile, useIsTouch } from "@/ui/misc";
import { MenuItem, MenuSep, MenuTitle, Popover, useMenu } from "@/ui/popover";
import { toast } from "@/ui/toast";
import { LazyShareDialog } from "../lazyPieces";
import { MailboxPicker } from "./MailboxPicker";

/**
 * The roles that hold the same messages as the folders they look at: All mail,
 * Flagged and Important are the mail seen another way, not places it is filed.
 * Their unread is the unread of a folder already counted.
 */
const VIEW_ROLES: ReadonlySet<string> = new Set(["all", "flagged", "important"]);

/** No counter prints five digits: a longer one says nothing `9999+` does not. */
function capCount(n: number): string | number {
  return n > 9999 ? "9999+" : n;
}

const ROLE_ICONS: Record<string, ReactNode> = {
  inbox: <Inbox size={20} />,
  drafts: <File size={20} />,
  sent: <Send size={20} />,
  trash: <Trash2 size={20} />,
  junk: <AlertOctagon size={20} />,
  archive: <Archive size={20} />,
  all: <Mail size={20} />,
  flagged: <Star size={20} />,
  important: <Tag size={20} />,
};

/**
 * One row of the keyword list: Starred, or a label.
 *
 * The same row for both, because they are the same thing to a reader — a
 * question about messages, with how many it answers with, opening the list of
 * them. A label brings a colour to tint and a depth to indent by; Starred
 * brings no colour of a label's to tint, and draws the star it is named after
 * as the list draws a star — filled, in the star's own token (`--star`), the
 * one a starred row's star is drawn with. Nothing else about the two differs.
 *
 * The count reads **unread (all)** — "3 (5)" is three unread out of five —
 * with the unread number standing out. The total alone would leave the reader
 * to open a label to find out whether anything in it is new, and the unread
 * alone would hide how much is filed under it; the two together answer the
 * question a row of a mail sidebar is asked ("is there anything here for me,
 * and how much is here at all"). A keyword with nothing unread shows the total
 * by itself, because "0 (5)" says nothing "5" does not.
 */
function KeywordRow({
  href,
  name,
  total,
  unread,
  color,
  icon,
  iconColor,
  depth,
}: {
  href: string;
  name: string;
  total: number;
  /** How much of it is not marked read. Drawn bold, ahead of the total. */
  unread: number;
  color?: string;
  icon?: ReactNode;
  /** The colour to draw an icon in, where a label's swatch would go. */
  iconColor?: string;
  depth: number;
}) {
  return (
    <Link
      href={href}
      className="nav-item folder-row"
      title={name}
      /* Indented rather than nested in the DOM: the rows are a flat list of
         links and a nested one would break keyboard order. */
      style={{ paddingLeft: 12 + depth * 14 }}
    >
      {color ? (
        <span
          className="nav-label-color"
          style={{ "--label-color": color } as React.CSSProperties}
        />
      ) : (
        <span
          className="nav-label-icon"
          style={iconColor ? { color: iconColor } : undefined}
        >
          {icon}
        </span>
      )}
      <span className="nav-label">{name}</span>
      {total > 0 && (
        <span className="nav-count label-count">
          {unread > 0 && <b>{unread}</b>}
          {unread > 0 ? ` (${total})` : total}
        </span>
      )}
    </Link>
  );
}

interface MailTreeRow {
  m: Mailbox;
  depth: number;
  hasChildren: boolean;
  open: boolean;
  hiddenUnread: number;
  childUnread: number;
}

interface MailTree {
  rows: MailTreeRow[];
  childrenOf: (id: Id | null) => Mailbox[];
  subtreeUnread: (id: Id) => number;
  /**
   * What the whole account holds unseen, over the folders this tree draws --
   * the number a folded account carries, and what opening it would show.
   */
  unread: number;
}

/**
 * What a folder row asks of the tree it is drawn in.
 *
 * One object with one identity, whose methods read the current render's
 * handlers when they are called. A row is memoised on its own data, and a
 * handler rebuilt on every store change would make that memo worth nothing:
 * the row would re-render with its parent every time anyway.
 */
interface MailboxActions {
  /** Open or shut one folder, by its expansion key (account and folder together). */
  toggle(expandedKey: string, open: boolean): void;
  /** Show this folder's children one level down (the phone's tree). */
  drill(id: Id): void;
  /** Open this folder's menu at the element it was asked from. */
  menu(mailbox: Mailbox, e: { currentTarget: Element }): void;
  dragStart(id: Id): void;
  dragEnd(): void;
  /** A folder dropped on another: `draggedId` moves under `targetId`. */
  drop(draggedId: Id, targetId: Id): void;
  /** Open a folder that lives in another account, after switching to it. */
  openIn(accountId: Id, id: Id): void;
}

/**
 * Folders as sidebar rows: one flat list, nested by depth, with the expansion
 * state deciding what is shown. Used for the active account's tree and for the
 * extra mailbox sections below it; `keyOf` keeps one account's expansion keys
 * out of another's, since mailbox ids are only unique within an account.
 *
 * Subscriptions decide the reader's own tree. A tree that is not theirs -- a
 * group mailbox they reach by membership -- is different in two ways: Stalwart
 * hands a freshly added member every folder unsubscribed (per-user state that
 * resets on re-add), which would leave only Inbox on screen, so such a tree
 * shows every folder it holds; and it **opens** them, because its shape is not
 * something the reader chose and its folders are the reason they are looking.
 * Hiding one is not offered there. (`adoptMailboxes` in the mail store also
 * subscribes those folders for the member, so a client that does honour
 * subscriptions reaches the group too.)
 */
function buildMailTree(
  mailboxes: Record<Id, Mailbox>,
  expanded: Record<string, boolean>,
  showHidden: boolean,
  wholeTree: boolean,
  keyOf: (id: Id) => string,
): MailTree {
  const all = Object.values(mailboxes).filter(
    (m) => showHidden || wholeTree || m.isSubscribed || m.role === "inbox",
  );
  const byParent = foldersByParent(mailboxes, all);
  const rows: MailTreeRow[] = [];
  const unread = all.reduce(
    (n, m) => (m.role && VIEW_ROLES.has(m.role) ? n : n + (m.unreadEmails ?? 0)),
    0,
  );
  const subtreeUnread = (id: Id): number =>
    (byParent.get(id) ?? []).reduce(
      (n, c) => n + c.unreadEmails + subtreeUnread(c.id),
      0,
    );
  const walk = (parent: Id | null, depth: number) => {
    for (const m of byParent.get(parent) ?? []) {
      const kids = byParent.get(m.id) ?? [];
      // Absent means the tree's own default: open when it is not the reader's.
      const open = expanded[keyOf(m.id)] ?? wholeTree;
      const childUnread = kids.length ? subtreeUnread(m.id) : 0;
      rows.push({
        m,
        depth,
        hasChildren: kids.length > 0,
        open,
        hiddenUnread: kids.length && !open ? childUnread : 0,
        childUnread,
      });
      if (kids.length && open) walk(m.id, depth + 1);
    }
  };
  walk(null, 0);
  return {
    rows,
    childrenOf: (id: Id | null) => byParent.get(id) ?? [],
    subtreeUnread,
    unread,
  };
}

export function MailboxTree() {
  const mailboxes = useMail((s) => s.mailboxes);
  const loaded = useMail((s) => s.mailboxesLoaded);
  const accountId = useMail((s) => s.accountId);
  const mailAccounts = useMail((s) => s.mailAccounts);
  const accountTrees = useMail((s) => s.accountTrees);
  const [location, navigate] = useLocation();
  const currentId = location.startsWith("/mail/") ? location.split("/")[2] : undefined;
  const showHidden = useSettings((s) => s.settings.showHiddenFolders);
  const labels = useEffectiveLabels();
  const labelsSidebar = useSettings((s) => s.settings.labelsSidebar);
  /** Whether the account on screen is a group's: only a group has system labels. */
  const isGroup = useIsGroupMailbox();
  const labelCounts = useMail((s) => s.labelCounts);
  const shownLabels = useMemo(
    () => visibleLabels(labelTree(labels, labelCounts)),
    [labels, labelCounts],
  );
  const starredCount = countOf(labelCounts, STARRED_KEYWORD);
  const menu = useMenu();
  const [menuTarget, setMenuTarget] = useState<Mailbox | null>(null);
  const [shareTarget, setShareTarget] = useState<Mailbox | null>(null);
  /** The folder being moved from its menu -- the way to move one without a drag, and on touch the only way. */
  const [moveTarget, setMoveTarget] = useState<Mailbox | null>(null);
  /**
   * The folder being dragged. Held here rather than read from the drag itself:
   * dataTransfer.getData is blocked during dragover, so a row cannot ask what
   * is over it, and every row needs to know whether it is a legal target.
   */
  const [draggingId, setDraggingId] = useState<Id | null>(null);
  const [rootDrop, setRootDrop] = useState(false);
  /** Whether the folder in flight may be dropped on this folder, or on the root. */
  const canDropOn = (targetId: Id | null): boolean =>
    Boolean(draggingId) && canDropFolder(mailboxes, draggingId!, targetId);

  const moveFolder = async (id: Id, parentId: Id | null) => {
    const m = mailboxes[id];
    setDraggingId(null);
    try {
      await useMail.getState().updateMailbox(id, { parentId });
      // Show where it landed rather than leaving it hidden in a closed parent.
      if (parentId) openKeys([folderKey(accountId, parentId)]);
      toast.success(
        parentId
          ? t("“{name}” moved into “{parent}”", {
              name: mailboxDisplayName(m),
              parent: mailboxDisplayName(mailboxes[parentId]),
            })
          : t("“{name}” moved to the top level", { name: mailboxDisplayName(m) }),
      );
    } catch (err) {
      toast.error(
        t("Could not move “{name}”: {reason}", {
          name: mailboxDisplayName(m),
          reason: errorMessage(err),
        }),
      );
    }
  };

  // Tree: A–Z at every level (Inbox pinned to the top of the root), subfolders nested and
  // collapsed by default. Expansion state is remembered per folder.
  const { open: expanded, setFolder, openKeys } = useOpenFolders("mail");
  /*
   * Which of the other accounts are open under this one. The foreground's tree
   * is the sidebar's subject, so it is always whole and has no such control;
   * the store folds the rest when it moves the foreground (`setAccount`).
   */
  const { open: openAccounts, toggle: toggleAccount } = useAccountFold();
  const session = useSession((s) => s.session);
  /*
   * Whether the tree in hand is somebody else's: a group mailbox the reader
   * reaches by membership, or their own.
   *
   * Asked of the session, which answers it before anything has been probed.
   * The classifier that says "group" answers only once the account probe has
   * listed the account, so a tree drawn on that answer fails closed for the
   * whole window a boot sits in -- and failing closed here means a member's
   * group tree, whose folders the server hands over unsubscribed, drawn down to
   * Inbox alone. Whose tree it is, is all this has to say: the folder rows of
   * the active account stay fully manageable either way -- the store's folder
   * writes aim at the active account, which is this one -- but the header names
   * the account, the "new folder" button and the personal label list belong to
   * the reader's own mailbox, the rows of the *other* accounts below are
   * read-only launchers, and a tree that is not the reader's own shows every
   * folder it holds (see `buildMailTree`).
   */
  const sharedTree = Boolean(
    session && accountId && !isOwnMailAccount(session, accountId),
  );
  const { rows, childrenOf, subtreeUnread } = useMemo(
    () =>
      buildMailTree(mailboxes, expanded, showHidden, sharedTree, (id) =>
        folderKey(accountId, id),
      ),
    [mailboxes, expanded, showHidden, sharedTree, accountId],
  );
  const activeAccountName = mailAccounts.find((a) => a.accountId === accountId)?.name;
  /*
   * The mailbox sections under the active tree: every other mailbox account --
   * group mailboxes under the reader's own, and the reader's own under a group
   * they opened. Rendered from the per-account folder cache, so the main tree
   * keeps belonging to whoever is active; opening a folder here switches the
   * active account to its owner first.
   */
  const extraAccounts = useMemo(
    () =>
      mailAccounts
        .filter((a) => a.accountId !== accountId)
        .map((a) => ({ info: a, tree: accountTrees[a.accountId] ?? {} }))
        .filter((a) => Object.keys(a.tree).length > 0),
    [mailAccounts, accountId, accountTrees],
  );
  const extraTrees = useMemo(() => {
    const out: Record<Id, MailTree> = {};
    for (const a of extraAccounts)
      out[a.info.accountId] = buildMailTree(
        a.tree,
        expanded,
        showHidden,
        // The reader's own mailbox, shown as a section under a group they
        // opened, keeps its per-user subscriptions; every other account is one
        // they reach by membership, so its whole accessible tree is shown.
        !isOwnMailAccount(session, a.info.accountId),
        (id) => folderKey(a.info.accountId, id),
      );
    return out;
  }, [extraAccounts, expanded, showHidden, session]);
  const openMailbox = async (toAccount: Id, mailboxId: Id) => {
    if (useMail.getState().accountId !== toAccount)
      await useMail.getState().openAccount(toAccount);
    navigate(`/mail/${mailboxId}`);
  };

  /*
   * On a phone the tree is a drill-down instead: one level at a time, a back
   * row above it, no indent. The tree earns its indent on a wide sidebar and
   * cannot pay for it in a 300px drawer -- four levels down, the 16px steps and
   * the 18px twisty left a folder 85px to print its name in, and the twisty had
   * walked far enough right to be hard to hit at all. Width picks the mode, not
   * the pointer: this is a layout that does not fit, not a target that is small.
   */
  const isMobile = useIsMobile();
  const [drillId, setDrillId] = useState<Id | null>(null);
  const drill = drillId && mailboxes[drillId] ? mailboxes[drillId] : null;
  /*
   * Follow the reader into whichever folder they opened, so the drawer comes
   * back at the level they were last looking at rather than at the root they
   * would have to walk down from again.
   */
  useEffect(() => {
    if (!isMobile || !currentId) return;
    const m = mailboxes[currentId];
    if (m) setDrillId(m.parentId && mailboxes[m.parentId] ? m.parentId : null);
  }, [isMobile, currentId, mailboxes]);

  /*
   * The rows' one stable handle on the tree's live state. `moveFolder`,
   * `openMailbox` and the menu's opener are rebuilt every render, so the
   * actions object reads them from here at call time instead of closing over
   * the render it was made in -- see `MailboxActions`.
   */
  const live = useRef({
    moveFolder,
    openMailbox,
    setFolder,
    setDrillId,
    setMenuTarget,
    setDraggingId,
    setRootDrop,
    openMenu: menu.open,
  });
  live.current = {
    moveFolder,
    openMailbox,
    setFolder,
    setDrillId,
    setMenuTarget,
    setDraggingId,
    setRootDrop,
    openMenu: menu.open,
  };
  const actions = useMemo<MailboxActions>(
    () => ({
      toggle: (expandedKey, open) => live.current.setFolder(expandedKey, !open),
      drill: (id) => live.current.setDrillId(id),
      menu: (mailbox, e) => {
        live.current.setMenuTarget(mailbox);
        live.current.openMenu(e);
      },
      dragStart: (id) => live.current.setDraggingId(id),
      dragEnd: () => {
        live.current.setDraggingId(null);
        live.current.setRootDrop(false);
      },
      drop: (draggedId, targetId) => void live.current.moveFolder(draggedId, targetId),
      openIn: (accountId, id) => void live.current.openMailbox(accountId, id),
    }),
    [],
  );

  const createFolder = async (parentId: Id | null) => {
    const name = await promptDialog({
      title: parentId ? t("New subfolder") : t("New folder"),
      placeholder: t("Folder name"),
    });
    if (!name?.trim()) return;
    try {
      await useMail.getState().createMailbox(name.trim(), parentId);
      // Show the folder that was just made. A new subfolder inside a parent the
      // reader has closed is otherwise created and reported without ever
      // appearing -- the same "show where it landed" rule `moveFolder` follows.
      if (parentId) openKeys([folderKey(accountId, parentId)]);
      toast.success(t("Folder “{name}” created", { name: name.trim() }));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (!loaded) {
    return (
      <div
        style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}
      >
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="skeleton"
            style={{ height: 28, width: `${70 + (i % 3) * 10}%` }}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <nav
        aria-label={t("Folders")}
        className={isMobile ? "folder-drill" : undefined}
        style={{ marginTop: 6 }}
      >
        <div
          className={`nav-section${rootDrop ? " drop-target" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(FOLDER_MIME) || !canDropOn(null)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!rootDrop) setRootDrop(true);
          }}
          onDragLeave={() => setRootDrop(false)}
          onDrop={(e) => {
            e.preventDefault();
            setRootDrop(false);
            const id = e.dataTransfer.getData(FOLDER_MIME);
            if (id) void moveFolder(id, null);
          }}
        >
          <span>
            {draggingId && canDropOn(null)
              ? t("Drop here for the top level")
              : drill
                ? mailboxDisplayName(drill)
                : activeAccountName || t("Folders")}
          </span>
          {/* Drilled in, the + makes a subfolder of the folder on screen --
              which is the one place in the app where "new folder here" has an
              unambiguous here. */}
          {!sharedTree && (
            <button
              className="icon-btn"
              title={drill ? t("New subfolder") : t("New folder")}
              aria-label={drill ? t("New subfolder") : t("New folder")}
              onClick={() => void createFolder(drill?.id ?? null)}
            >
              <Plus size={16} />
            </button>
          )}
        </div>
        {drill && (
          <>
            <button
              className="nav-item drill-back"
              onClick={() =>
                setDrillId(
                  drill.parentId && mailboxes[drill.parentId] ? drill.parentId : null,
                )
              }
            >
              <ChevronLeft size={20} />
              <span className="nav-label">
                {drill.parentId && mailboxes[drill.parentId]
                  ? mailboxDisplayName(mailboxes[drill.parentId])
                  : t("Folders")}
              </span>
            </button>
            {/* The folder you drilled into is still a folder you can open. */}
            <FolderRow
              key={drill.id}
              mailbox={drill}
              label={mailboxDisplayName(drill)}
              depth={0}
              hasChildren={false}
              open={false}
              expandedKey=""
              hiddenUnread={0}
              childUnread={subtreeUnread(drill.id)}
              currentId={currentId}
              dragging={false}
              acceptsFolder={false}
              actions={actions}
            />
          </>
        )}
        {(isMobile
          ? childrenOf(drill?.id ?? null).map((m) => ({
              m,
              depth: 0,
              hasChildren: childrenOf(m.id).length > 0,
              open: false,
              hiddenUnread: subtreeUnread(m.id),
              childUnread: subtreeUnread(m.id),
            }))
          : rows
        ).map(({ m, depth, hasChildren, open, hiddenUnread, childUnread }) => (
          <FolderRow
            key={m.id}
            mailbox={m}
            label={mailboxDisplayName(m)}
            depth={depth}
            hasChildren={hasChildren}
            open={open}
            expandedKey={folderKey(accountId, m.id)}
            hiddenUnread={hiddenUnread}
            childUnread={childUnread}
            drillable={isMobile && hasChildren}
            currentId={currentId}
            dragging={draggingId === m.id}
            acceptsFolder={canDropOn(m.id)}
            actions={actions}
          />
        ))}
        {/**
         * The account's labels, under its own folder tree and before the other
         * accounts' sections.
         *
         * They belong to whoever is in the foreground, not to the reader
         * alone: a group mailbox has a catalog of its own (ADR 0004), so
         * opening a group shows that group's labels here and nothing of
         * anybody else's. The reads follow the same rule — `useEffectiveLabels`
         * picks the catalog and `labelsForAccount` picks what is counted — so
         * what is listed and what is counted cannot disagree about whose
         * labels these are. Only the account in the foreground has this
         * section; the others below are their folder trees and nothing more.
         *
         * Starred starts it. It is not a label -- it is the keyword a star
         * writes -- but it is the same kind of row: a question about messages,
         * with a count of how many it answers with, opening the list of them.
         * So it is drawn by the same component and its count comes from the
         * same read; nothing about it is special except that the star it
         * carries is the star's own and no label's -- filled, in `--star`, as
         * the row's star is -- and that it is drawn for an account with no
         * labels at all: stars are not a label.
         *
         * The Manage link goes only where the client manages labels. A group's
         * catalog is not that: it lives in the group's own app folder and the
         * agent writes it, so the pencil would open a surface that edits the
         * reader's personal labels instead.
         */}
        {!drill && labelsSidebar && (
          <>
            <div className="nav-section">
              <span>{t("Labels")}</span>
              {!sharedTree && (
                <Link
                  href="/settings/labels"
                  className="icon-btn"
                  title={t("Manage labels")}
                  aria-label={t("Manage labels")}
                >
                  <Pencil size={14} />
                </Link>
              )}
            </div>
            <KeywordRow
              href="/search?q=is:starred"
              name={t("Starred")}
              total={starredCount.total}
              unread={starredCount.unread}
              icon={<Star size={14} fill="currentColor" />}
              iconColor="var(--star)"
              depth={0}
            />
            {shownLabels.map((n) => (
              <KeywordRow
                key={n.label.keyword}
                href={`/search?q=label:${encodeURIComponent(n.label.keyword)}`}
                name={n.label.name}
                total={n.total}
                unread={n.unread}
                color={n.label.color}
                depth={n.depth}
              />
            ))}
            {/*
             * The product's reserved `G-` states, below the group's own labels.
             * They belong to no group and to no catalog: the entries come from
             * the shared vocabulary (`AGENT_LABELS`) and this section draws no
             * rename, delete or Manage control, so nothing here can change one.
             * A person's account has none of it — an agent runs in a group's
             * account only (ADR 0027) — so the section is drawn for a group.
             * Each row is a filter like its siblings, and its count comes from
             * the same `labelCounts` read, which counts these keywords for a
             * group (`countedKeywords`).
             */}
            {isGroup && (
              <>
                <div className="nav-section">
                  <span>{t("System labels")}</span>
                </div>
                {AGENT_LABELS.map((l) => {
                  const c = countOf(labelCounts, l.keyword);
                  return (
                    <KeywordRow
                      key={l.keyword}
                      href={`/search?q=label:${encodeURIComponent(l.keyword)}`}
                      name={l.name}
                      total={c.total}
                      unread={c.unread}
                      color={l.color}
                      depth={0}
                    />
                  );
                })}
              </>
            )}
          </>
        )}
        {/* The other mailboxes, under the account on screen: group mailboxes
            under the reader's own, and the reader's own under a group they
            opened. Each section is that account's folder tree from the cache;
            opening a folder there switches the active account to its owner.

            Folded until the reader opens it, and folded again as soon as
            another account is brought to the front. A folded account carries
            what it holds unseen, because the rows that would say so are not on
            screen; open, it drops the number and the folder rows speak for
            themselves. Its title keeps the section's small caps, so the row
            reads as an account rather than as one more folder. */}
        {extraAccounts.map((a) => {
          const tree = extraTrees[a.info.accountId];
          if (!tree) return null;
          const folded = !openAccounts[a.info.accountId];
          return (
            <Fragment key={a.info.accountId}>
              <button
                type="button"
                className={`nav-item account-row${folded && tree.unread ? " unread" : ""}`}
                title={a.info.name}
                aria-expanded={!folded}
                onClick={() => toggleAccount(a.info.accountId)}
              >
                <span className="nav-twisty" aria-hidden="true">
                  {folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </span>
                <span className="account-title">{a.info.name}</span>
                {folded && tree.unread > 0 && (
                  <span className="nav-count">{capCount(tree.unread)}</span>
                )}
              </button>
              {!folded &&
                tree.rows.map(
                  ({ m, depth, hasChildren, open, hiddenUnread, childUnread }) => (
                    <FolderRow
                      key={m.id}
                      mailbox={m}
                      label={mailboxDisplayName(m)}
                      depth={depth}
                      hasChildren={hasChildren}
                      open={open}
                      expandedKey={folderKey(a.info.accountId, m.id)}
                      hiddenUnread={hiddenUnread}
                      childUnread={childUnread}
                      currentId={a.info.accountId === accountId ? currentId : undefined}
                      readOnly
                      openAccount={a.info.accountId}
                      dragging={false}
                      acceptsFolder={false}
                      actions={actions}
                    />
                  ),
                )}
            </Fragment>
          );
        })}
      </nav>
      <Popover
        anchor={menu.anchor}
        onClose={menu.close}
        trigger={menu.trigger}
        width={300}
      >
        {menuTarget && (
          <MailboxMenu
            mailbox={menuTarget}
            onClose={menu.close}
            onCreateChild={() => void createFolder(menuTarget.id)}
            onShare={() => setShareTarget(menuTarget)}
            onMove={() => {
              menu.close();
              setMoveTarget(menuTarget);
            }}
            sharedTree={sharedTree}
          />
        )}
      </Popover>
      {moveTarget && (
        <MailboxPicker
          title={t("Move “{name}” to…", { name: mailboxDisplayName(moveTarget) })}
          need="mayReadItems"
          allow={(id) => canMoveFolderTo(mailboxes, moveTarget.id, id)}
          root={
            canMoveFolderTo(mailboxes, moveTarget.id, null)
              ? {
                  label: t("Top level"),
                  onPick: () => {
                    setMoveTarget(null);
                    void moveFolder(moveTarget.id, null);
                  },
                }
              : undefined
          }
          onClose={() => setMoveTarget(null)}
          onPick={(id) => {
            setMoveTarget(null);
            void moveFolder(moveTarget.id, id);
          }}
        />
      )}
      {shareTarget && (
        <Suspense fallback={null}>
          <LazyShareDialog
            kind="Mailbox"
            id={shareTarget.id}
            name={shareTarget.name}
            shareWith={shareTarget.shareWith ?? null}
            onClose={() => setShareTarget(null)}
          />
        </Suspense>
      )}
    </>
  );
}

/**
 * One folder in a tree.
 *
 * Memoised on the mailbox it draws: a mail-store change (a count moving, a
 * message read) re-renders the tree, and every row it holds would otherwise be
 * walked again for it. What a row is told stays referentially stable between
 * such changes -- its own data, and the tree's `actions` object -- so the rows
 * that did not change are left alone.
 */
const FolderRow = memo(function FolderRow({
  mailbox: m,
  label,
  depth,
  hasChildren,
  open,
  expandedKey,
  hiddenUnread,
  childUnread,
  currentId,
  actions,
  dragging,
  acceptsFolder,
  readOnly,
  drillable,
  openAccount,
}: {
  mailbox: Mailbox;
  label: string;
  depth: number;
  hasChildren: boolean;
  open: boolean;
  /** This row's expansion key: the account and folder together (see `folderKey`). */
  expandedKey: string;
  hiddenUnread: number;
  childUnread: number;
  currentId?: string;
  /** What the row may ask of the tree (see `MailboxActions`). */
  actions: MailboxActions;
  dragging: boolean;
  acceptsFolder: boolean;
  /** Folders the reader does not own: no menu, no drag, no colour pick. */
  readOnly?: boolean;
  /** Offers to drill into this row's children, which replaces its twisty. */
  drillable?: boolean;
  /** The row is another account's: opening it must switch account first. */
  openAccount?: Id;
}) {
  const [dropping, setDropping] = useState(false);
  /** Expanding in place and drilling in are the same relationship; only one shows. */
  const twisty = hasChildren && !drillable;
  // Scheduled counts like Drafts: everything in it is already read, so the
  // useful number is how many messages are waiting, not how many are unseen.
  const scheduled = isScheduledMailbox(m);
  const own = m.role === "drafts" || scheduled ? m.totalEmails : m.unreadEmails;
  const count = own + hiddenUnread;
  // Bold when this folder has unread mail, or any folder beneath it does (parent + child both bold).
  const unread =
    m.role !== "drafts" &&
    m.role !== "trash" &&
    m.role !== "junk" &&
    m.role !== "sent" &&
    !scheduled
      ? m.unreadEmails + childUnread > 0
      : m.unreadEmails > 0 && m.role !== "drafts" && !scheduled;
  const icon =
    m.role && ROLE_ICONS[m.role] ? (
      ROLE_ICONS[m.role]
    ) : scheduled ? (
      <Clock size={20} />
    ) : (
      <Folder size={20} />
    );
  // A chosen colour tints the icon only; the label keeps the tree's own
  // contrast, which a dozen arbitrary colours would not reliably give it.
  // Subscribed, not read once: picking a colour has to repaint the row.
  const tint = useSettings((s) => folderColor(s.settings.folderColors, m.id));

  const onDragOver = (e: DragEvent) => {
    if (readOnly) return;
    const folder = e.dataTransfer.types.includes(FOLDER_MIME);
    if (folder ? !acceptsFolder : !e.dataTransfer.types.includes(EMAILS_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!dropping) setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    if (readOnly) return;
    e.preventDefault();
    setDropping(false);
    const folderId = e.dataTransfer.getData(FOLDER_MIME);
    if (folderId) {
      if (acceptsFolder) actions.drop(folderId, m.id);
      return;
    }
    const raw = e.dataTransfer.getData(EMAILS_MIME);
    if (!raw) return;
    try {
      const ids = JSON.parse(raw) as string[];
      void useMail.getState().move(ids, m.id);
    } catch {
      /* ignore */
    }
  };
  /*
   * Hold a folder for its menu, which is the same menu the ⋮ opens.
   *
   * The button is already visible where there is no hover, so this is not the
   * only way in — but a 24px target beside a folder name is not what a thumb
   * aims at, and a right-click has no touchscreen equivalent to inherit.
   */
  const isTouch = useIsTouch();
  const press = useTouchRow({
    enabled: isTouch,
    onLongPress: (target) => {
      if (readOnly) return;
      haptic(15);
      actions.menu(m, { currentTarget: target });
    },
  });

  const onDragStart = (e: DragEvent) => {
    if (readOnly) return;
    e.dataTransfer.setData(FOLDER_MIME, m.id);
    e.dataTransfer.effectAllowed = "move";
    // A folder row is a link, and a link drag would otherwise carry its URL.
    e.stopPropagation();
    actions.dragStart(m.id);
  };

  return (
    <Link
      href={`/mail/${m.id}`}
      className={`nav-item folder-row depth-${Math.min(depth, 4)} ${currentId === m.id ? "active" : ""} ${unread ? "unread" : ""} ${dropping ? "drop-target" : ""} ${dragging ? "dragging" : ""}`}
      title={label}
      {...press}
      onClick={
        openAccount
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              actions.openIn(openAccount, m.id);
            }
          : undefined
      }
      // Dragging a folder is a mouse gesture; on a touchscreen the browser
      // starts it from the same long press that now opens the menu.
      draggable={!readOnly && movable(m) && !isTouch}
      onDragStart={onDragStart}
      onDragEnd={() => actions.dragEnd()}
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      onContextMenu={
        readOnly
          ? undefined
          : (e) => {
              e.preventDefault();
              actions.menu(m, { currentTarget: e.currentTarget });
            }
      }
    >
      {/* Drilling replaces expanding, so the twisty goes with it -- two
          controls for one relationship, on opposite ends of the same row, is
          worse than either alone. */}
      <span
        className="nav-twisty"
        role={twisty ? "button" : undefined}
        aria-label={twisty ? (open ? t("Collapse") : t("Expand")) : undefined}
        aria-expanded={twisty ? open : undefined}
        aria-hidden={twisty ? undefined : true}
        onClick={
          twisty
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                actions.toggle(expandedKey, open);
              }
            : undefined
        }
      >
        {twisty ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
      </span>
      <span
        className="folder-icon"
        style={tint ? ({ "--folder-color": tint } as React.CSSProperties) : undefined}
      >
        {icon}
      </span>
      <span className="nav-label">{label}</span>
      {count > 0 && (
        <span
          className="nav-count"
          title={
            hiddenUnread
              ? t("{own} here, {unread} in subfolders", { own, unread: hiddenUnread })
              : undefined
          }
        >
          {capCount(count)}
        </span>
      )}
      {count > 0 && <span className="nav-dot" />}
      {!readOnly && (
        <button
          className="icon-btn nav-more"
          aria-label={t("Folder options")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            actions.menu(m, e);
          }}
        >
          <MoreVertical size={16} />
        </button>
      )}
      {/*
        Drilling in is a separate control from opening the folder, and sits at
        the right edge where it is the same size and the same place on every
        row -- unlike the twisty, which walks right with the indent and shrinks
        the name as it goes. Tapping the row still opens the folder, which is
        what a folder is for; this only changes what the list underneath shows.
      */}
      {drillable && (
        <button
          className="icon-btn drill-into"
          aria-label={t("Open subfolders of {name}", { name: label })}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            actions.drill(m.id);
          }}
        >
          <ChevronRight size={20} />
        </button>
      )}
    </Link>
  );
});

function MailboxMenu({
  mailbox: m,
  onClose,
  onCreateChild,
  onShare,
  onMove,
  sharedTree,
}: {
  mailbox: Mailbox;
  onClose: () => void;
  onCreateChild: () => void;
  onShare: () => void;
  onMove: () => void;
  /**
   * Shared tree -- somebody else's mailbox, reached by membership: hiding a
   * folder is not offered there (see `buildMailTree`).
   */
  sharedTree: boolean;
}) {
  const shared = Object.keys(m.shareWith ?? {}).length > 0;
  const [, navigate] = useLocation();
  const colors = useSettings((s) => s.settings.folderColors);
  const update = useSettings((s) => s.update);
  const hasChildren = useMail((s) =>
    Object.values(s.mailboxes).some((x) => (x.parentId ?? null) === m.id),
  );
  const subUnread = useMail((s) => {
    const all = Object.values(s.mailboxes);
    let n = 0;
    const walk = (parent: Id) => {
      for (const x of all)
        if ((x.parentId ?? null) === parent) {
          n += x.unreadEmails;
          walk(x.id);
        }
    };
    walk(m.id);
    return n;
  });
  /** ADR 0013: what this menu may offer, by the one rule. */
  const mayEnd = useMayDestroy();
  const rename = async () => {
    const name = await // The server's own name, never the localised one: this box writes
    // back whatever it is prefilled with.
    promptDialog({ title: t("Rename folder"), defaultValue: m.name });
    if (!name?.trim() || name.trim() === m.name) return;
    try {
      await useMail.getState().updateMailbox(m.id, { name: name.trim() });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const remove = async () => {
    const ok = await askDeleteFolder({
      name: mailboxDisplayName(m),
      emails: m.totalEmails,
    });
    if (!ok) return;
    try {
      /*
       * ADR 0013: a refusal is not a deletion, so the confirmation here is not
       * followed by a success message about a folder that still exists and a
       * navigation away from it. The guard's own sentence has already said why.
       */
      const outcome = await useMail.getState().destroyMailbox(m.id, true);
      if (!outcome.ok) return;
      toast.success(t("Folder deleted"));
      navigate(`/mail/${useMail.getState().roleId("inbox") ?? ""}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const empty = () =>
    confirmAndEmpty({
      id: m.id,
      name: mailboxDisplayName(m),
      role: m.role,
      totalEmails: m.totalEmails,
    });
  const isSpecial = Boolean(m.role) && m.role !== "subscribed";
  const color = folderColor(colors, m.id);
  const setColor = (c: string | null) => {
    onClose();
    const next = { ...colors };
    if (c) next[m.id] = c;
    else delete next[m.id];
    update({ folderColors: next });
  };
  return (
    <>
      <MenuItem
        icon={<CheckCheck size={16} />}
        label={t("Mark all as read")}
        onClick={() => void useMail.getState().markMailboxRead(m.id)}
        disabled={!m.unreadEmails}
      />
      {hasChildren && (
        <MenuItem
          icon={<CheckCheck size={16} />}
          label={t("Mark all as read, incl. subfolders")}
          kbd={
            m.unreadEmails + subUnread ? String(m.unreadEmails + subUnread) : undefined
          }
          onClick={() => void useMail.getState().markMailboxRead(m.id, true)}
          disabled={!m.unreadEmails && !subUnread}
        />
      )}
      <MenuItem
        icon={<FolderPlus size={16} />}
        label={t("New subfolder")}
        onClick={onCreateChild}
        disabled={!m.myRights.mayCreateChild}
      />
      <MenuItem
        icon={<Pencil size={16} />}
        label={t("Rename")}
        onClick={() => void rename()}
        disabled={isSpecial || !m.myRights.mayRename}
      />
      {/* No drag on a touch screen, and a long list makes it slow anyway: the
          same picker the message move uses, listing only legal destinations. */}
      <MenuItem
        icon={<FolderInput size={16} />}
        label={t("Move to…")}
        onClick={onMove}
        disabled={!movable(m) || !m.myRights.mayRename}
      />
      <MenuItem
        icon={m.isSubscribed ? <EyeOff size={16} /> : <Eye size={16} />}
        label={m.isSubscribed ? t("Hide from list") : t("Show in list")}
        onClick={() =>
          void useMail.getState().updateMailbox(m.id, { isSubscribed: !m.isSubscribed })
        }
        disabled={m.role === "inbox" || sharedTree}
      />
      {/* Sharing a mail folder is withdrawn, not removed: Stalwart accepts and
          stores the share, and it never reaches the other account -- its own
          docs list calendars, address books and files as shareable and not mail
          folders. Offering it produces shares that look real and do nothing.
          One that already exists can still be cleared here, which is the only
          reason this entry is offered at all. */}
      {shared && (
        <MenuItem
          icon={<Share2 size={16} />}
          label={t("Stop sharing")}
          onClick={onShare}
        />
      )}
      <MenuSep />
      <MenuTitle>
        <span className="row gap-4">
          <Palette size={12} /> {t("Colour")}
        </span>
      </MenuTitle>
      <div
        className="color-grid"
        style={{ gridTemplateColumns: "repeat(6, 26px)", padding: "4px 10px 8px" }}
      >
        {CALENDAR_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            style={{
              background: c,
              width: 26,
              height: 26,
              outline: color?.toLowerCase() === c ? "2px solid var(--fg)" : undefined,
              outlineOffset: 1,
            }}
            aria-label={c}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      {color && (
        <MenuItem
          icon={<X size={16} />}
          label={t("Use the default colour")}
          onClick={() => setColor(null)}
        />
      )}
      <MenuSep />
      {canEmpty(m.role) && mayEnd && (
        <MenuItem
          icon={<Eraser size={16} />}
          label={emptyLabel(m)}
          onClick={() => void empty()}
          danger
          disabled={!m.totalEmails}
        />
      )}
      <MenuItem
        icon={<Trash2 size={16} />}
        label={t("Delete folder")}
        onClick={() => void remove()}
        danger
        /*
         * ADR 0013: a folder holding mail is destroyed with it, so in a group
         * this is one of the three things an administrator alone may do. The
         * entry stays drawn and tells the truth about why it is not offered,
         * rather than disappearing for a reason nobody can look up.
         */
        disabled={
          isSpecial ||
          !m.myRights.mayDelete ||
          (folderDestroyTakesMail(m, true) && !mayEnd)
        }
      />
    </>
  );
}
