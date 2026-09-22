import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Download,
  Eye,
  File,
  FilePen,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Folders,
  Home,
  MoreVertical,
  Pencil,
  Share2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { client } from "@/jmap/client";
import type { FileNode, Id } from "@/jmap/types";
import { entriesFromDrop, hasDirectory, planUpload } from "@/lib/dropUpload";
import { canDropFileNodes, isShared, NODE_MIME, readDraggedIds } from "@/lib/filenode";
import { sortFiles, useFilesSort } from "@/lib/fileSort";
import { formatListDate, formatSize } from "@/lib/format";
import { plural, t } from "@/lib/i18n";
import { type FilesSortKey, loadPlace, placeOwnerFrom } from "@/lib/lastPlace";
import { rangeIds } from "@/lib/listSelection";
import { previewKind } from "@/lib/preview";
import { useFiles } from "@/store/files";
import { useSession } from "@/store/session";
import { confirmDialog, Dialog, promptDialog } from "@/ui/dialog";
import type { PreviewFile } from "@/ui/filepreview";
import { Empty, Spinner } from "@/ui/misc";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { RowCheckbox, SelectAllCheckbox } from "@/ui/selection";
import { toast } from "@/ui/toast";
import { LazyFilePreviewDialog, LazyShareDialog } from "../lazyPieces";

export function FilesView({ nodeId }: { nodeId?: string }) {
  const [, navigate] = useLocation();
  const files = useFiles();
  const parentId = nodeId ?? null;
  const [dropping, setDropping] = useState(false);
  /* A set, and the row a shift-click measures from. Kept as ids rather than
     indices: the listing reloads under you -- a push, an upload finishing --
     and an index would then point at a different file. */
  const [selection, setSelection] = useState<Set<Id>>(() => new Set());
  const [anchor, setAnchor] = useState<Id | null>(null);
  const menu = useMenu();
  /** The selection's own menu, opened from the bar that counts it. */
  const selMenu = useMenu();
  const [menuNode, setMenuNode] = useState<FileNode | null>(null);
  const [moveNodes, setMoveNodes] = useState<FileNode[] | null>(null);
  /** The two folders being merged, and the dialog that asks which name stays. */
  const [mergeNodes, setMergeNodes] = useState<FileNode[] | null>(null);
  const [shareNode, setShareNode] = useState<FileNode | null>(null);
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  /* What the open editor is editing, and the blob its text came from -- the
     baseline a save is checked against. Kept beside `preview` rather than in
     it, because the dialog is presentational and knows nothing about nodes. */
  const [editTarget, setEditTarget] = useState<{ id: Id; blobId: Id | null } | null>(
    null,
  );
  const [startInEdit, setStartInEdit] = useState(false);
  /* Shared with the sidebar tree, so a row dragged onto a folder there is
     recognised. See the note on `draggingId` in the store. */
  const draggingIds = files.draggingIds;
  const setDragging = files.setDragging;
  const inputRef = useRef<HTMLInputElement>(null);
  /* Which column this folder is ordered by, remembered per folder on this
     device like the folders the tree has open. */
  const { sort, toggle: toggleSort } = useFilesSort(files.accountId, parentId);

  /* A selection belongs to the folder it was made in. Carrying it across would
     leave rows selected that are no longer on screen, and the delete two
     folders later would be a surprise. */
  useEffect(() => {
    setSelection(new Set());
    setAnchor(null);
  }, [parentId, files.accountId]);

  /* Escape drops it, the way it does everywhere else. */
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setSelection((cur) => (cur.size ? new Set() : cur));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!files.available) return;
    /* Tell the store which listing is on screen, so a change arriving from
       elsewhere re-reads this one. Cleared on the way out: nothing is on
       screen once the view is gone. */
    files.setListingShown({ parentId });
    void files.loadChildren(parentId);
    return () => files.setListingShown(null);
    // `accountId` is in here because opening a share changes which account the
    // same route means: at /files the parent is null before and after, so
    // without it the listing would keep showing the previous account's folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.available, files.accountId, parentId]);

  /*
   * Opening Files lands where this device left off -- the folder that was open
   * last time, when it belongs to the account being browsed and still exists.
   * The attempt belongs to an account rather than to the mount: opening a share
   * later in the session is when *its* place can be honoured, and the record is
   * the folder of the account it names. Only from the top level, because a link
   * to a folder somebody followed is a place they chose now. The tree has to
   * have answered first, since that is what says which folders exist.
   */
  const restoredFor = useRef<Id | null | undefined>(undefined);
  useEffect(() => {
    if (parentId !== null || !files.available || !files.treeLoaded) return;
    if (restoredFor.current === files.accountId) return;
    restoredFor.current = files.accountId;
    const place = loadPlace(placeOwnerFrom(useSession.getState())).files;
    if (!place?.parentId || place.accountId !== files.accountId) return;
    if (!files.dirIds.includes(place.parentId)) return;
    navigate(`/files/${place.parentId}`);
  }, [
    parentId,
    files.available,
    files.treeLoaded,
    files.dirIds,
    files.accountId,
    navigate,
  ]);

  // The sidebar's primary button asks for an upload here, the way it asks the
  // calendar for a new event.
  useEffect(() => {
    const open = () => inputRef.current?.click();
    window.addEventListener("ihm:files-upload", open);
    return () => window.removeEventListener("ihm:files-upload", open);
  }, []);

  // Ensure ancestors are loaded for breadcrumbs
  useEffect(() => {
    if (!files.available || !parentId) return;
    const n = files.nodes[parentId];
    if (!n) {
      void client
        .call<{ list: FileNode[] }>("FileNode/get", {
          accountId: files.accountId,
          ids: [parentId],
          fetchParents: true,
        })
        .then((r) => {
          useFiles.setState((s) => {
            const nodes = { ...s.nodes };
            for (const x of r.list) nodes[x.id] = x;
            return { nodes };
          });
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId, files.available]);

  if (!files.available)
    return (
      <div className="p-16">
        <Empty icon={<FolderOpen size={40} />} title={t("File storage is not available")}>
          {t("This account does not have the JMAP file storage capability.")}
        </Empty>
      </div>
    );

  const ids = files.children[parentId ?? "root"] ?? [];
  /* The rows, in the order the reader asked for: `sortFiles` is the one
     definition of that order, and everything below -- the selection a
     shift-click takes, the bar's count, the drag -- reads this list, so what is
     on screen and what a click means cannot disagree. */
  const nodes = sortFiles(
    ids.map((id) => files.nodes[id]).filter((n): n is FileNode => Boolean(n)),
    sort,
  );
  const path = files.pathTo(parentId);

  /*
   * One definition for the three sortable headers.
   *
   * The column the listing is in is **bold** and carries a small arrow for the
   * direction; the other two are plain names you can click. There is no third
   * state to draw, because there is no third state: a listing is always in some
   * order, and the header in force is the one that says which.
   */
  const sortHeader = (key: FilesSortKey, label: string, className?: string) => {
    const active = sort.key === key;
    return (
      <th
        className={className}
        aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
      >
        <button
          type="button"
          className={`th-sort ${active ? "sorted" : ""}`}
          onClick={() => toggleSort(key)}
        >
          {label}
          {active && (sort.desc ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}
        </button>
      </th>
    );
  };

  /* A drop lands in `into`, which is the folder under the pointer when there is
     one and the folder being listed otherwise. Entries have to be read out
     before the first await -- the list is emptied the moment the handler
     returns -- so that happens here, synchronously, for every path. */
  const dropOnto = (into: string | null, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
    if (e.dataTransfer.types.includes(NODE_MIME)) {
      const ids = readDraggedIds(e.dataTransfer);
      setDragging([]);
      if (canDropFileNodes(files.nodes, ids, into)) {
        setSelection(new Set());
        void files
          .moveMany(ids, into)
          .catch((err) => toast.error((err as Error).message));
      }
      return;
    }
    if (!e.dataTransfer.types.includes("Files")) return;
    const entries = entriesFromDrop(e.dataTransfer);
    const flat = Array.from(e.dataTransfer.files);
    void (async () => {
      /*
       * The entries are the tree and the flat list is the fallback, and which
       * one is worth reading is decided per drop rather than up front: a folder
       * arrives with entries and no readable files, a set of loose files with
       * both. Walking the entries answers `dirs` as well as files, so a folder
       * that holds nothing is still created -- `planUpload` is the walk that
       * does, and `flat` is only ever the fallback.
       */
      if (entries.length && hasDirectory(entries)) {
        const plan = await planUpload(entries);
        if (plan.files.length || plan.dirs.length) await files.uploadPlan(into, plan);
        return;
      }
      if (flat.length) await files.upload(into, flat);
    })();
  };

  const onDrop = (e: React.DragEvent) => dropOnto(parentId, e);

  const blobUrl = (n: FileNode, inline: boolean) =>
    client.downloadUrl(
      files.accountId!,
      n.blobId!,
      n.name,
      n.type ?? "application/octet-stream",
      inline,
    );

  const download = (n: FileNode) => {
    if (!n.blobId) return;
    const a = document.createElement("a");
    a.href = blobUrl(n, false);
    a.download = n.name;
    a.click();
  };

  /*
   * Every downloadable file of a selection, one after the other.
   *
   * A folder has no blob and no archive to ask for, so it is not one of them:
   * what the action names is how many *files* it will put on disk, which is
   * also what keeps it from looking like it silently skipped something.
   */
  const downloadAll = (list: FileNode[]) => {
    for (const n of downloadable(list)) download(n);
  };

  const downloadable = (list: FileNode[]) =>
    list.filter((n) => n.nodeType !== "directory" && n.blobId);

  /*
   * Clicking a row, with the conventions a file manager has taught everyone:
   * plain replaces the selection, ctrl/cmd adds or removes one, shift takes
   * the run from the last row clicked to this one -- `rangeIds`, the same rule
   * the mail list extends a selection by. The anchor is the row a shift
   * measures from, and a plain or toggling click moves it.
   */
  const clickRow = (n: FileNode, ev: React.MouseEvent) => {
    // Over the rows on screen rather than the listing's ids: the two are the
    // same almost always, and where they are not -- a node still loading -- a
    // run must not name rows nobody can see.
    const run = ev.shiftKey
      ? rangeIds(
          nodes.map((r) => r.id),
          anchor,
          n.id,
        )
      : null;
    if (run) {
      setSelection(new Set(ev.ctrlKey || ev.metaKey ? [...selection, ...run] : run));
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      tick(n.id, !selection.has(n.id));
      return;
    }
    setSelection(new Set([n.id]));
    setAnchor(n.id);
  };

  /* One row's box: the row joins the selection or leaves it, and the anchor
     follows the box rather than the row it belongs to. */
  const tick = (id: Id, on: boolean) => {
    const next = new Set(selection);
    if (on) next.add(id);
    else next.delete(id);
    setSelection(next);
    setAnchor(id);
  };

  /* Right-clicking inside the selection acts on all of it; right-clicking
     outside it means you meant that row, so the selection follows the pointer
     rather than the menu quietly applying to something off-screen. */
  const menuFor = (
    n: FileNode,
    at: (x: number, y: number) => void,
    x: number,
    y: number,
  ) => {
    if (!selection.has(n.id)) {
      setSelection(new Set([n.id]));
      setAnchor(n.id);
    }
    setMenuNode(n);
    at(x, y);
  };

  const selectedNodes = () => nodes.filter((n) => selection.has(n.id));
  /*
   * What the reader has actually selected: the selection filtered to the rows
   * on screen.
   *
   * One value, because the bar that counts a selection and the menu that acts
   * on it have to name the same set. A node can vanish from under a selection
   * -- another client deletes it, a push re-reads the folder -- and a count
   * taken from the selection itself would then say three while the menu offered
   * to delete two.
   */
  const sel = selectedNodes();
  /* What the menu and the bar act on: the whole selection when the row is part
     of it, and that row alone otherwise. */
  const targets = (n: FileNode | null) =>
    n && selection.has(n.id) && selection.size > 1
      ? selectedNodes()
      : n
        ? [n]
        : selectedNodes();

  /**
   * Whether the selection is the one thing Merge is for: **two folders, and
   * not one or three.**
   *
   * The rule is about the node that survives as much as about the gesture.
   * Merging is defined between exactly two, because the dialog asks which of
   * the two names to keep -- and with three there is no such question, only a
   * choice among three with a second answer that is not a name. So the entry is
   * offered for two and disabled for anything else, including a selection of two
   * files.
   *
   * Rights are read here too, and the same way round: either folder may be the
   * one given up, so both have to be deletable, and either may be the one kept,
   * so both have to take children. Which of the two it actually is is settled in
   * the dialog, and a collision the plan then finds is refused with the name it
   * is about.
   */
  const canMerge = (list: FileNode[]) =>
    list.length === 2 &&
    list.every((n) => n.nodeType === "directory") &&
    list.every(
      (n) => n.myRights?.mayDelete !== false && n.myRights?.mayAddChildren !== false,
    );

  const allSelected = nodes.length > 0 && nodes.every((n) => selection.has(n.id));

  /*
   * The actions a whole selection has, in one definition.
   *
   * They are the same actions wherever a selection is acted on -- the bar that
   * counts it and the menu a right-click opens on one of its rows -- and two
   * copies of them would part company the first time one gained an entry.
   * What a list gets is only what it can be asked: a folder is not
   * downloadable, so a selection holding none offers no Download.
   */
  const groupActions = (list: FileNode[]) => {
    const files = downloadable(list);
    return (
      <>
        {files.length > 0 && (
          <MenuItem
            icon={<Download size={16} />}
            label={plural(files.length, {
              one: "Download {n} file",
              other: "Download {n} files",
            })}
            onClick={() => downloadAll(files)}
          />
        )}
        <MenuItem
          icon={<FolderInput size={16} />}
          label={plural(list.length, {
            one: "Move {n} item…",
            other: "Move {n} items…",
          })}
          onClick={() => setMoveNodes(list)}
        />
        {/*
         * Always here, and usable only for two folders. A menu entry that
         * appears and disappears leaves the reader wondering whether it exists
         * at all, which is worse than a greyed one that says what it is waiting
         * for -- so it is drawn for any selection and disabled until the
         * selection is one it can act on.
         */}
        <MenuItem
          icon={<Folders size={16} />}
          label={t("Merge folders…")}
          disabled={!canMerge(list)}
          onClick={() => setMergeNodes(list)}
        />
        <MenuSep />
        <MenuItem
          danger
          icon={<Trash2 size={16} />}
          label={plural(list.length, {
            one: "Delete {n} item",
            other: "Delete {n} items",
          })}
          onClick={() => void removeNodes(list)}
        />
      </>
    );
  };

  const removeNodes = async (list: FileNode[]) => {
    if (!list.length) return;
    const title =
      list.length === 1
        ? t("Delete “{name}”?", { name: list[0]!.name })
        : plural(list.length, { one: "Delete {n} item?", other: "Delete {n} items?" });
    if (!(await confirmDialog({ title, confirmLabel: t("Delete"), danger: true })))
      return;
    try {
      await files.destroy(list.map((n) => n.id));
      setSelection(new Set());
      toast.success(t("Deleted"));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  /* A file with nothing to show still does what it always did. */
  const canPreview = (n: FileNode) =>
    Boolean(n.blobId) &&
    n.nodeType !== "directory" &&
    previewKind(n.type, n.name) !== null;

  const openPreview = (n: FileNode, edit = false) => {
    setPreview({
      name: n.name,
      type: n.type ?? "application/octet-stream",
      size: n.size,
      url: blobUrl(n, false),
      inlineUrl: blobUrl(n, true),
    });
    setEditTarget({ id: n.id, blobId: n.blobId });
    setStartInEdit(edit);
  };

  /* What the menu can tell from a row: text, and the right to write it. Whether
     it is *really* editable needs the bytes -- a truncated or non-UTF-8 file
     opens read-only and says so. */
  const canEditFile = (n: FileNode) =>
    canPreview(n) &&
    previewKind(n.type, n.name) === "text" &&
    Boolean(n.myRights?.mayModifyContent);

  /*
   * Only offered where the reader may actually write: a folder shared read-only
   * still opens, and the Edit button is simply not there. `saveText` checks the
   * blob it started from, so two people editing the same file get told rather
   * than one of them losing the work.
   */
  const canEditNode = (n: FileNode | undefined) => Boolean(n?.myRights?.mayModifyContent);
  const saveEdited = async (text: string) => {
    const target = editTarget;
    if (!target) return;
    const next = await files.saveText(target.id, text, target.blobId);
    // The file has a new blob now; the next save in this same session is
    // checked against that one, not the one we opened.
    setEditTarget({ id: target.id, blobId: next });
    toast.success(t("Saved"));
  };

  /* Double-clicking a file opens what can be opened and downloads the rest,
     so looking at a picture does not mean putting it on disk first. */
  const activate = (n: FileNode) => {
    if (n.nodeType === "directory") navigate(`/files/${n.id}`);
    else if (canPreview(n)) openPreview(n);
    else download(n);
  };

  return (
    <div
      className={`files-layout ${dropping ? "dropping" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDropping(true);
        } else if (
          e.dataTransfer.types.includes(NODE_MIME) &&
          canDropFileNodes(files.nodes, draggingIds, parentId)
        ) {
          e.preventDefault();
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <div className="files-toolbar">
        <div className="breadcrumb">
          <button
            className={path.length ? "" : "current"}
            onClick={() => navigate("/files")}
          >
            <Home size={16} />
          </button>
          {path.map((n, i) => (
            <span key={n.id} className="row gap-4">
              <ChevronRight size={14} className="faint" />
              <button
                className={i === path.length - 1 ? "current" : ""}
                onClick={() => navigate(`/files/${n.id}`)}
              >
                {n.name}
              </button>
            </span>
          ))}
        </div>
        <button className="btn btn-sm" onClick={() => inputRef.current?.click()}>
          <Upload size={16} /> {t("Upload")}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const l = Array.from(e.target.files ?? []);
            if (l.length) void files.upload(parentId, l);
            e.target.value = "";
          }}
        />
        <button
          className="btn btn-sm"
          onClick={async () => {
            const n = await promptDialog({
              title: t("New folder"),
              placeholder: t("Folder name"),
            });
            if (n?.trim()) {
              try {
                await files.mkdir(parentId, n.trim());
              } catch (err) {
                toast.error((err as Error).message);
              }
            }
          }}
        >
          <FolderPlus size={16} /> {t("New folder")}
        </button>
      </div>
      {files.runs.length > 0 && (
        <div
          className="list-hint"
          style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}
        >
          {files.runs.map((u) => (
            <div key={u.id} className="row">
              <span className="truncate grow">{u.name}</span>
              {u.error ? (
                <>
                  <span style={{ color: "var(--danger)" }}>{u.error}</span>
                  {/*
                   * The reason is worth keeping until it has been read, and
                   * worth being able to put away afterwards: nothing else in
                   * the tray offers a way out of a row that failed, so this
                   * is the only one there is.
                   */}
                  <button
                    className="icon-btn sm"
                    aria-label={t("Dismiss")}
                    title={t("Dismiss")}
                    onClick={() => files.dismissRun(u.id)}
                  >
                    <X size={16} />
                  </button>
                </>
              ) : (
                <>
                  {/*
                   * How far the run has come, in the units of the gesture,
                   * beside the percentage of the step in flight. A folder of
                   * two hundred items is one job with a size rather than two
                   * hundred unrelated files: the count is the run's -- steps
                   * through out of the steps it named -- and it moves as each
                   * one lands, which is the only sense of "how much is left" a
                   * percentage of a single step cannot give. A step that moves
                   * no bytes -- a folder merge's move or its delete -- has no
                   * percentage, and none is drawn for it.
                   */}
                  <span>
                    {u.unit === "item"
                      ? plural(
                          u.total,
                          { one: "{done} of {n} item", other: "{done} of {n} items" },
                          { done: u.done },
                        )
                      : plural(
                          u.total,
                          { one: "{done} of {n} file", other: "{done} of {n} files" },
                          { done: u.done },
                        )}
                  </span>
                  {u.progress !== null && <span>{u.progress}%</span>}
                  {/*
                   * The way out of a run that is taking too long, which
                   * is the whole of what a big file or a folder of many
                   * offers otherwise: a percentage and no switch. Cancelling
                   * a row cancels the run it belongs to -- the drop, the merge
                   * or the picker action that started it -- so a folder of two
                   * hundred items does not owe the reader two hundred
                   * presses. What it has done by then stays done.
                   */}
                  <button className="btn btn-sm" onClick={() => files.cancelRun(u.id)}>
                    {t("Cancel")}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {/*
       * The bar is always there, counting zero when nothing is ticked.
       *
       * It used to be drawn only with a selection, and a bar that appears out of
       * nothing moves every row below it down by its own height: ticking one box
       * made the listing jump under the pointer, and the second click of a
       * two-row selection landed somewhere other than the first. A bar that is
       * always where it was costs an empty strip and buys a listing that never
       * moves.
       *
       * What changes with the count is what can be done, not what is drawn: with
       * nothing ticked the two buttons are there and inert.
       */}
      <div className="selection-bar">
        <span className="grow">
          {plural(sel.length, {
            one: "{n} item selected",
            other: "{n} items selected",
          })}
        </span>
        {/* The selection's actions, in one menu: the bar counts and offers
            them, the rows are what gets ticked. */}
        <button
          className="btn btn-sm"
          aria-label={t("Actions")}
          title={t("Actions")}
          disabled={sel.length === 0}
          onClick={selMenu.open}
        >
          <MoreVertical size={16} /> {t("Actions")}
        </button>
        <button
          className="icon-btn sm"
          aria-label={t("Clear selection")}
          title={t("Clear selection")}
          disabled={sel.length === 0}
          onClick={() => setSelection(new Set())}
        >
          <X size={16} />
        </button>
      </div>
      {files.error && (
        <div className="error-box" style={{ margin: 12 }}>
          {files.error}
        </div>
      )}
      <div
        className="files-scroll"
        /* Clicking past the last row clears the selection, the way it does in
           every file manager. Rows stop the click from reaching here by
           handling it themselves, so this only ever sees the empty space. */
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("tr")) return;
          setSelection((cur) => (cur.size ? new Set() : cur));
        }}
        onContextMenu={(e) => {
          // Only the empty space below the rows: a row has its own menu.
          if ((e.target as HTMLElement).closest("tr")) return;
          e.preventDefault();
          setMenuNode(null);
          menu.openAt(e.clientX, e.clientY);
        }}
      >
        {files.loading && !nodes.length ? (
          <Spinner />
        ) : !nodes.length ? (
          <Empty icon={<FolderOpen size={40} />} title={t("This folder is empty")}>
            {t("Drag files here or use Upload.")}
          </Empty>
        ) : (
          <table className={`files-table ${sel.length ? "has-selection" : ""}`}>
            <thead>
              <tr>
                <th className="f-check-col">
                  <SelectAllCheckbox
                    checked={allSelected}
                    partial={sel.length > 0 && !allSelected}
                    label={t("Select all")}
                    onChange={() =>
                      allSelected || sel.length > 0
                        ? setSelection(new Set())
                        : setSelection(new Set(nodes.map((n) => n.id)))
                    }
                  />
                </th>
                {sortHeader("name", t("Name"))}
                {sortHeader("size", t("Size"), "hide-mobile")}
                {sortHeader("modified", t("Modified"), "hide-mobile")}
                <th />
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr
                  key={n.id}
                  className={`${selection.has(n.id) ? "selected" : ""} ${n.nodeType === "directory" && canDropFileNodes(files.nodes, draggingIds, n.id) ? "drop-target" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    /* Dragging a row that is part of the selection drags all of
                       it; dragging one outside the selection means that row. */
                    const ids = selection.has(n.id) ? [...selection] : [n.id];
                    if (!selection.has(n.id)) {
                      setSelection(new Set([n.id]));
                      setAnchor(n.id);
                    }
                    e.dataTransfer.setData(NODE_MIME, ids.join(","));
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(ids);
                  }}
                  onDragEnd={() => setDragging([])}
                  onDragOver={(e) => {
                    if (n.nodeType !== "directory") return;
                    const node = e.dataTransfer.types.includes(NODE_MIME);
                    if (
                      node
                        ? !canDropFileNodes(files.nodes, draggingIds, n.id)
                        : !e.dataTransfer.types.includes("Files")
                    )
                      return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = node ? "move" : "copy";
                  }}
                  onDrop={(e) => {
                    if (n.nodeType === "directory") dropOnto(n.id, e);
                  }}
                  onClick={(e) => clickRow(n, e)}
                  onDoubleClick={() => activate(n)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    menuFor(n, menu.openAt, e.clientX, e.clientY);
                  }}
                >
                  <td className="f-check-col">
                    <RowCheckbox
                      checked={selection.has(n.id)}
                      className="f-check"
                      label={t("Select")}
                      onChange={(on) => tick(n.id, on)}
                    />
                  </td>
                  <td>
                    <div
                      className={`f-name ${n.nodeType === "directory" ? "is-folder" : ""}`}
                    >
                      {n.nodeType === "directory" ? (
                        <Folder size={18} />
                      ) : (
                        <File size={18} />
                      )}
                      {/*
                       * A name is a label, not a door. Clicking it selects the
                       * row — the same thing clicking anywhere else on the row
                       * does — and opening a folder is the double click, the
                       * way it is in every file manager. A single click that
                       * navigated would also mean a click meant to tick a row,
                       * or to start a drag, left the folder instead.
                       */}
                      <span>{n.name}</span>
                      {isShared(n) && (
                        <Share2 size={13} className="faint" aria-label={t("Shared")} />
                      )}
                    </div>
                  </td>
                  <td className="hide-mobile muted">
                    {n.nodeType === "directory" ? "—" : formatSize(n.size)}
                  </td>
                  <td className="hide-mobile muted">
                    {formatListDate(n.modified ?? n.created)}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="icon-btn sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!selection.has(n.id)) {
                          setSelection(new Set([n.id]));
                          setAnchor(n.id);
                        }
                        setMenuNode(n);
                        menu.open(e);
                      }}
                      aria-label={t("Options")}
                    >
                      <MoreVertical size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Popover
        anchor={menu.anchor}
        onClose={menu.close}
        trigger={menu.trigger}
        width={200}
      >
        {!menuNode && (
          <>
            <MenuItem
              icon={<Upload size={16} />}
              label={t("Upload files…")}
              onClick={() => inputRef.current?.click()}
            />
            <MenuItem
              icon={<FolderPlus size={16} />}
              label={t("New folder")}
              onClick={async () => {
                const n = await promptDialog({
                  title: t("New folder"),
                  placeholder: t("Folder name"),
                });
                if (n?.trim()) {
                  try {
                    await files.mkdir(parentId, n.trim());
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }
              }}
            />
          </>
        )}
        {menuNode && targets(menuNode).length > 1 && groupActions(targets(menuNode))}
        {menuNode && targets(menuNode).length <= 1 && (
          <>
            {menuNode.nodeType === "directory" ? (
              <MenuItem
                icon={<FolderOpen size={16} />}
                label={t("Open")}
                onClick={() => navigate(`/files/${menuNode.id}`)}
              />
            ) : (
              <>
                {canPreview(menuNode) && (
                  <MenuItem
                    icon={<Eye size={16} />}
                    label={t("Preview")}
                    onClick={() => openPreview(menuNode)}
                  />
                )}
                {canEditFile(menuNode) && (
                  <MenuItem
                    icon={<FilePen size={16} />}
                    label={t("Edit")}
                    onClick={() => openPreview(menuNode, true)}
                  />
                )}
                <MenuItem
                  icon={<Download size={16} />}
                  label={t("Download")}
                  onClick={() => download(menuNode)}
                />
              </>
            )}
            <MenuItem
              icon={<Pencil size={16} />}
              label={t("Rename")}
              disabled={!menuNode.myRights?.mayRename}
              onClick={async () => {
                const n = await promptDialog({
                  title: t("Rename"),
                  defaultValue: menuNode.name,
                });
                if (n?.trim() && n !== menuNode.name) {
                  try {
                    await files.rename(menuNode.id, n.trim());
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }
              }}
            />
            <MenuItem
              icon={<FolderInput size={16} />}
              label={t("Move to…")}
              onClick={() => setMoveNodes([menuNode])}
            />
            <MenuItem
              icon={<Share2 size={16} />}
              label={t("Share…")}
              disabled={!menuNode.myRights?.mayShare}
              onClick={() => setShareNode(menuNode)}
            />
            <MenuSep />
            <MenuItem
              danger
              icon={<Trash2 size={16} />}
              label={t("Delete")}
              disabled={!menuNode.myRights?.mayDelete}
              onClick={() => void removeNodes([menuNode])}
            />
          </>
        )}
      </Popover>
      {sel.length > 0 && (
        <Popover
          anchor={selMenu.anchor}
          onClose={selMenu.close}
          trigger={selMenu.trigger}
          width={240}
        >
          {groupActions(sel)}
        </Popover>
      )}
      {moveNodes && (
        <MoveDialog
          nodes={moveNodes}
          onClose={() => setMoveNodes(null)}
          onMoved={() => setSelection(new Set())}
        />
      )}
      {mergeNodes && (
        <MergeFoldersDialog
          nodes={mergeNodes}
          onClose={() => setMergeNodes(null)}
          onMerged={() => setSelection(new Set())}
        />
      )}
      {preview && (
        <Suspense fallback={null}>
          <LazyFilePreviewDialog
            file={preview}
            onClose={() => {
              setPreview(null);
              setEditTarget(null);
              setStartInEdit(false);
            }}
            onSave={
              editTarget && canEditNode(files.nodes[editTarget.id])
                ? saveEdited
                : undefined
            }
            startInEdit={startInEdit}
          />
        </Suspense>
      )}
      {shareNode && (
        <Suspense fallback={null}>
          <LazyShareDialog
            kind="FileNode"
            id={shareNode.id}
            name={shareNode.name}
            shareWith={shareNode.shareWith ?? null}
            onClose={() => setShareNode(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

function MoveDialog({
  nodes,
  onClose,
  onMoved,
}: {
  nodes: FileNode[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const files = useFiles();
  const [cur, setCur] = useState<string | null>(null);
  useEffect(() => {
    void files.loadChildren(cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);
  /* None of the folders being moved can be their own destination, and neither
     can a folder already holding all of them -- "Move here" would be a no-op. */
  const moving = new Set(nodes.map((n) => n.id));
  const dirs = (files.children[cur ?? "root"] ?? [])
    .map((id) => files.nodes[id])
    .filter((n): n is FileNode =>
      Boolean(n && n.nodeType === "directory" && !moving.has(n.id)),
    );
  const path = files.pathTo(cur);
  const already = nodes.every((n) => (n.parentId ?? null) === cur);
  const title =
    nodes.length === 1
      ? t("Move \u201c{name}\u201d", { name: nodes[0]!.name })
      : plural(nodes.length, { one: "Move {n} item", other: "Move {n} items" });
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            className="btn btn-primary"
            disabled={already}
            onClick={async () => {
              try {
                await files.moveMany(
                  nodes.map((n) => n.id),
                  cur,
                );
                toast.success(t("Moved"));
                onMoved();
                onClose();
              } catch (err) {
                toast.error((err as Error).message);
              }
            }}
          >
            {t("Move here")}
          </button>
        </>
      }
    >
      <div className="breadcrumb mb-8">
        <button onClick={() => setCur(null)}>
          <Home size={14} />
        </button>
        {path.map((n) => (
          <span key={n.id} className="row gap-4">
            <ChevronRight size={12} />
            <button onClick={() => setCur(n.id)}>{n.name}</button>
          </span>
        ))}
      </div>
      {dirs.map((d) => (
        <button key={d.id} className="menu-item" onClick={() => setCur(d.id)}>
          <Folder size={16} />
          <span className="grow">{d.name}</span>
          <ChevronRight size={14} />
        </button>
      ))}
      {!dirs.length && <p className="hint">{t("No subfolders here.")}</p>}
    </Dialog>
  );
}

/**
 * Which of the two folders survives, asked once, before anything is written.
 *
 * Merging is defined between exactly two folders and one of them has to go, so
 * there is one question — which name stays — and the answer settles the rest:
 * the folder whose name is kept is the node that survives, and everything the
 * other one holds moves into it before that folder is destroyed. The dialog
 * therefore chooses a *folder*, not a name to rename something to: renaming the
 * survivor would move a folder's identity onto a name the reader picked from a
 * different folder, which is a rename dressed up as a merge.
 *
 * Both lines say what happens to the folder they are on, because the
 * consequence is asymmetric — one of the two is destroyed — and a reader who
 * read only the title would be choosing between two words.
 *
 * The merge itself runs in the tray, like an upload: it is a run the reader can
 * watch and stop, and this dialog closes once it has been asked for. A
 * collision the plan finds is reported there too, with nothing written, because
 * the tray is the one place this view reports a failure.
 */
function MergeFoldersDialog({
  nodes,
  onClose,
  onMerged,
}: {
  nodes: FileNode[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const files = useFiles();
  const [keepId, setKeepId] = useState<Id>(() => nodes[0]!.id);
  const mergeId = nodes.find((n) => n.id !== keepId)!.id;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("Merge folders")}
      size="md"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              /*
               * The press asks for the merge and the dialog goes with it: the
               * question is answered, and the run is watched and stopped in the
               * tray, where a second Cancel for one run would be one place too
               * many. Waiting here would hold the reader in a dialog about a
               * question already settled until the last step of the run -- the
               * dialog is not what the merge reports to.
               *
               * Closing cannot hide anything: the scan and the plan come first,
               * so nothing has been written at this point, and a collision, a
               * stopped run or a failed one is carried by the tray.
               */
              const asked = files.mergeFolders(keepId, mergeId);
              onMerged();
              onClose();
              void asked.catch((err) => {
                // The guard the menu already keeps, reached again in case the
                // listing moved under the reader. Nothing was written either
                // way and the dialog is gone, so the toast is what says why the
                // merge did not start.
                toast.error((err as Error).message);
              });
            }}
          >
            {t("Merge")}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        {t(
          "Which folder should keep its name? The other one's contents move into it, and it is deleted.",
        )}
      </p>
      <div className="dialog-choices" style={{ marginTop: 8 }}>
        {nodes.map((n) => (
          <label key={n.id} className="btn dialog-choice" htmlFor={`merge-keep-${n.id}`}>
            <span className="row gap-8" style={{ alignItems: "flex-start" }}>
              {/*
               * A radio, not a checkbox: the answer is one of two rather than
               * any of two, and two boxes that can both be ticked (or neither)
               * would describe a state this question does not have.
               */}
              <input
                id={`merge-keep-${n.id}`}
                type="radio"
                name="merge-keep"
                checked={keepId === n.id}
                onChange={() => setKeepId(n.id)}
              />
              <Folder size={16} />
              {/*
               * The name is the whole question, so it is read entire: a long
               * one wraps rather than being cut off, and one with nothing to
               * break on breaks inside itself.
               */}
              <span className="grow" style={{ overflowWrap: "anywhere" }}>
                {n.name}
              </span>
            </span>
            <small>
              {keepId === n.id
                ? t("Its name stays, and the other folder's contents move in here.")
                : t("This folder is deleted once its contents have moved.")}
            </small>
          </label>
        ))}
      </div>
    </Dialog>
  );
}
