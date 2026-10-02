import {
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  Fragment,
  type MouseEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { uid } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  compareKnowledgeSiblings,
  type KnowledgeSummary,
  type KnowledgeTierView,
  siblingDropPlan,
} from "@/lib/knowledge";
import { type KnowledgeSearchResult, useKnowledge } from "@/store/knowledge";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { type Anchor, anchorFromEl, MenuItem, Popover } from "@/ui/popover";
import { KnowledgeRevBadge } from "./KnowledgeRevBadge";

/**
 * The knowledge base's tree of articles and topic folders (ADR 0024).
 *
 * Two tiers, one shape: the company KB leads -- it is the installation's, read
 * by everyone -- and each group the reader is in follows. The tree is the
 * FileNode tree the store flattens into `articles`, rebuilt here by `parentId`
 * so a sub-article or a folder's contents sit under the node that owns them.
 * `kind` tells an article (a page) from a topic folder (a group); both are
 * FileNodes, so the same `parentId` walk carries them.
 *
 * Search replaces the tree rather than filtering it: a hit can live in any tier
 * and any depth, and an article is found by its text, not by where it sits.
 *
 * Reordering is a free `order` among siblings (shared `KnowledgeSummary`), so a
 * drop lands between two neighbours by taking the midpoint of their orders and
 * only the moved row is written — unless the midpoint has collapsed onto a
 * sibling, when the family is renumbered in one request. Moving a row onto a
 * folder nests it there.
 */

/**
 * The drag payload's own MIME type.
 *
 * A private type keeps a KB drag from being mistaken for a files or mail drag
 * by a drop zone elsewhere on the page, and the node id in the payload is only
 * a marker -- the dragged row is held in state, which is where its folder path
 * and current order live.
 */
const KB_NODE_MIME = "application/x-gilbert-kb-node";

/** The dragged row: which tier it came from and the summary itself. */
interface Dragging {
  accountId: string;
  summary: KnowledgeSummary;
}

/** Where a hovered row would take the drop. */
interface DropTarget {
  nodeId: string;
  mode: "before" | "after" | "inside";
}

/** Siblings of a node, in the order they are shown: `order`, then title. */
function siblingsOf(
  tier: KnowledgeTierView,
  parentId: string | null,
): KnowledgeSummary[] {
  return tier.articles
    .filter((a) => (a.parentId ?? "") === (parentId ?? ""))
    .sort(compareKnowledgeSiblings);
}

/** Whether `nodeId` is `ancestorId` itself or sits anywhere below it. */
function isWithin(tier: KnowledgeTierView, ancestorId: string, nodeId: string): boolean {
  if (ancestorId === nodeId) return true;
  const byId = new Map(tier.articles.map((a) => [a.nodeId, a]));
  let current = byId.get(nodeId);
  while (current) {
    if (current.parentId === ancestorId) return true;
    if (!current.parentId) break;
    current = byId.get(current.parentId);
  }
  return false;
}

/** The company tier is the installation's; a group tier is named by its group. */
export function tierLabel(tier: KnowledgeTierView): string {
  return tier.scope === "company" ? t("Company") : (tier.group ?? t("Company"));
}

/**
 * The first step a new checklist template starts with.
 *
 * A template is a page whose body holds checklist steps (ADR 0024), so a create
 * that starts with one makes the page a template from its first moment rather
 * than after a save. The author renames it and adds more.
 */
function checklistSeedBlocks(): unknown[] {
  return [
    {
      type: "checkListItem",
      id: uid("step"),
      content: [{ type: "text", text: "" }],
      children: [],
    },
  ];
}

/**
 * The inline "new page / new folder / new checklist template" row.
 *
 * Creation happens where the node will land: a text input appears in the tree at
 * the parent's depth, Enter commits it, Escape drops it, and blur commits what is
 * typed. No `window.prompt`, no dialog — the reader never leaves the tree.
 */
function InlineCreateRow({
  tier,
  parentNodeId,
  kind,
  depth,
}: {
  tier: KnowledgeTierView;
  parentNodeId: string | null;
  kind: "page" | "folder" | "template";
  depth: number;
}) {
  const create = useKnowledge((s) => s.create);
  const createFolder = useKnowledge((s) => s.createFolder);
  const cancelCreate = useKnowledge((s) => s.cancelCreate);
  const [name, setName] = useState("");
  // One commit per row: a blur after Enter must not create twice.
  const committed = useRef(false);
  const label =
    kind === "folder"
      ? t("New folder")
      : kind === "template"
        ? t("New checklist template")
        : t("New page");

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const value = name.trim();
    const parentFolder = parentNodeId
      ? (tier.articles.find((a) => a.nodeId === parentNodeId)?.folder ?? null)
      : null;
    cancelCreate();
    if (!value) return;
    if (kind === "page") void create(tier, value, parentFolder);
    else if (kind === "template")
      void create(tier, value, parentFolder, checklistSeedBlocks());
    else void createFolder(tier, value, parentFolder);
  };

  return (
    <div
      className="nav-item"
      style={{
        paddingLeft: 12 + depth * 30,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {kind === "folder" ? (
        <Folder size={16} className="faint" aria-hidden="true" />
      ) : kind === "template" ? (
        <ClipboardCheck size={16} className="kb-checklist-icon" aria-hidden="true" />
      ) : (
        <FileText size={16} className="faint" aria-hidden="true" />
      )}
      <input
        className="input sm grow"
        autoFocus
        value={name}
        placeholder={label}
        aria-label={label}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelCreate();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

export function KnowledgeSidebar() {
  const tiers = useKnowledge((s) => s.tiers);
  const search = useKnowledge((s) => s.search);
  const results = useKnowledge((s) => s.results);
  const searching = useKnowledge((s) => s.searching);
  const article = useKnowledge((s) => s.article);
  const open = useKnowledge((s) => s.open);
  const reorder = useKnowledge((s) => s.reorder);
  const renumber = useKnowledge((s) => s.renumber);
  const move = useKnowledge((s) => s.move);
  const creating = useKnowledge((s) => s.creating);
  const beginCreate = useKnowledge((s) => s.beginCreate);
  const reload = useKnowledge((s) => s.reload);
  const renameNode = useKnowledge((s) => s.renameNode);
  const removeNode = useKnowledge((s) => s.removeNode);
  const setSearch = useKnowledge((s) => s.setSearch);
  const runSearch = useKnowledge((s) => s.runSearch);

  /*
   * A row's own menu: rename or delete the node the row names, whichever kind
   * it is. Anchored to the button that opened it, like every other row menu in
   * the app.
   */
  const [menu, setMenu] = useState<{
    tier: KnowledgeTierView;
    summary: KnowledgeSummary;
    anchor: Anchor | null;
  } | null>(null);

  /*
   * Expansion is the reader's own view state, not a document: the KB stores no
   * "open" flag, and a reload rebuilds the tree, so a folded folder stays
   * folded for as long as this sidebar is mounted.
   */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  /** Show only checklist templates and the folders on the way to them. */
  const [templatesOnly, setTemplatesOnly] = useState(false);

  /*
   * Where a hit lives. The result carries the account but not the article's
   * folder name, and the writer needs both: the page id is unique across the
   * tiers, so its tier and summary answer what the search result does not.
   */
  const tierOf = (accountId: string, nodeId: string) =>
    accountId
      ? tiers.find((tier) => tier.accountId === accountId)
      : tiers.find((tier) => tier.articles.some((a) => a.nodeId === nodeId));
  const folderOf = (nodeId: string): string =>
    tiers.flatMap((tier) => tier.articles).find((a) => a.nodeId === nodeId)?.folder ?? "";

  /*
   * "New page" opens an inline input in the tree — no `window.prompt`: the row
   * appears where the node will land (under the open page when it is in this
   * tier) and Enter commits it. "New folder" does the same at the tier root.
   */
  const addPage = (tier: KnowledgeTierView) => {
    // A new page lands in the folder that holds the open one, or at the tier
    // root: an article is a leaf, so it cannot be a page's parent.
    const inTier =
      article && article.scope === tier.scope && article.accountId === tier.accountId;
    const parentNodeId = inTier ? (article?.summary.parentId ?? null) : null;
    expandChain(tier, parentNodeId);
    beginCreate(tier, parentNodeId, "page");
  };

  const addFolder = (tier: KnowledgeTierView, parentNodeId: string | null) => {
    expandChain(tier, parentNodeId);
    beginCreate(tier, parentNodeId, "folder");
  };

  /** A page that starts as a checklist template: same place as a new page. */
  const addTemplate = (tier: KnowledgeTierView) => {
    const inTier =
      article && article.scope === tier.scope && article.accountId === tier.accountId;
    const parentNodeId = inTier ? (article?.summary.parentId ?? null) : null;
    expandChain(tier, parentNodeId);
    beginCreate(tier, parentNodeId, "template");
  };

  /** Open a row's Rename/Delete menu, anchored to the button that asked. */
  const openRowMenu = (
    e: MouseEvent,
    summary: KnowledgeSummary,
    tier: KnowledgeTierView,
  ) => {
    e.stopPropagation();
    setMenu({ tier, summary, anchor: anchorFromEl(e.currentTarget as Element) });
  };

  const renameFromMenu = async (tier: KnowledgeTierView, summary: KnowledgeSummary) => {
    const name = await promptDialog({
      title: summary.kind === "folder" ? t("Rename folder") : t("Rename page"),
      defaultValue: summary.title,
    });
    if (name?.trim() && name.trim() !== summary.title)
      void renameNode(tier, summary, name.trim());
  };

  /**
   * Whether a folder holds an approved page anywhere under it, read from the
   * tier the tree already lists. The server refuses to destroy such a folder,
   * so the control says so rather than inviting the click (ADR 0024).
   */
  const approvedDescendantsOf = (tier: KnowledgeTierView, nodeId: string): boolean => {
    const seen = new Set<string>([nodeId]);
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop()!;
      for (const child of tier.articles) {
        if ((child.parentId ?? "") !== id || seen.has(child.nodeId)) continue;
        seen.add(child.nodeId);
        if (child.inForce || child.pending) return true;
        stack.push(child.nodeId);
      }
    }
    return false;
  };

  const deleteFromMenu = async (tier: KnowledgeTierView, summary: KnowledgeSummary) => {
    // An article something was issued from is retired, not destroyed; a folder
    // holding one is not deleted at all — the same rule the panel states.
    const everApproved = Boolean(summary.inForce || summary.pending);
    if (!everApproved && approvedDescendantsOf(tier, summary.nodeId)) return;
    const ok = await confirmDialog(
      everApproved
        ? {
            title: t("Retire “{title}”?", { title: summary.title }),
            message: t(
              "It leaves the tree but stays on record, with its revisions; find it again by showing retired articles.",
            ),
            confirmLabel: t("Retire"),
          }
        : {
            title: t("Delete “{title}”?", { title: summary.title }),
            message:
              summary.kind === "folder"
                ? t("The pages and folders inside it go too.")
                : t("This cannot be undone."),
            confirmLabel: t("Delete"),
            danger: true,
          },
    );
    if (ok) void removeNode(tier, summary);
  };

  /*
   * Open every folder on the way to `nodeId`, so the row created inside it is
   * actually mounted: a collapsed parent would take the input where nobody can
   * see it, and the click would read as doing nothing.
   */
  const expandChain = (tier: KnowledgeTierView, nodeId: string | null) => {
    if (!nodeId) return;
    const byId = new Map(tier.articles.map((a) => [a.nodeId, a]));
    const opened: Record<string, boolean> = {};
    let id: string | null = nodeId;
    while (id) {
      opened[id] = true;
      id = byId.get(id)?.parentId ?? null;
    }
    setExpanded((prev) => ({ ...prev, ...opened }));
  };

  const toggleFolder = (nodeId: string) =>
    setExpanded((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }));

  /*
   * A row's drop zone is decided from where the pointer is: the middle of a
   * folder nests the row inside it, an edge (or either half of an article)
   * lands it before or after. Only a folder accepts a nest; an article is a
   * leaf.
   */
  const modeFor = (a: KnowledgeSummary, e: DragEvent): DropTarget["mode"] => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    if (a.kind === "folder" && ratio > 0.3 && ratio < 0.7) return "inside";
    return ratio < 0.5 ? "before" : "after";
  };

  function dragStart(e: DragEvent, a: KnowledgeSummary, tier: KnowledgeTierView) {
    setDragging({ accountId: tier.accountId, summary: a });
    e.dataTransfer.setData(KB_NODE_MIME, a.nodeId);
    e.dataTransfer.effectAllowed = "move";
  }

  function dragEnd() {
    setDragging(null);
    setDropTarget(null);
  }

  function dragOver(e: DragEvent, a: KnowledgeSummary, tier: KnowledgeTierView) {
    const drag = dragging;
    if (!drag || drag.accountId !== tier.accountId) return;
    // A row cannot be dropped into itself or into its own descendant: that is
    // the cycle the FileNode tree must not grow.
    if (isWithin(tier, drag.summary.nodeId, a.nodeId)) {
      if (dropTarget) setDropTarget(null);
      return;
    }
    const mode = modeFor(a, e);
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropTarget({ nodeId: a.nodeId, mode });
  }

  function drop(e: DragEvent, a: KnowledgeSummary, tier: KnowledgeTierView) {
    e.preventDefault();
    e.stopPropagation();
    const target = dropTarget;
    const drag = dragging;
    setDropTarget(null);
    setDragging(null);
    if (!target || !drag || drag.accountId !== tier.accountId) return;
    if (isWithin(tier, drag.summary.nodeId, a.nodeId)) return;
    if (target.mode === "inside") {
      void move(tier, drag.summary.folder, a.folder);
      return;
    }
    const sameParent = (drag.summary.parentId ?? "") === (a.parentId ?? "");
    // The target's siblings, plus the moved node: `siblingDropPlan` removes the
    // moved node and re-inserts it at the drop, so including it here is what
    // lets a before/after drop land beside a row in *another* folder.
    const list = [...siblingsOf(tier, a.parentId), drag.summary];
    const plan = siblingDropPlan(list, drag.summary.nodeId, a.nodeId, target.mode);
    if (!plan) return;
    if (!sameParent) {
      /*
       * A before/after drop beside a row in another folder means "move it here,
       * at this position": reparent to that row's folder, then order it among
       * its new siblings. This is also how a page leaves a folder for the tier
       * root, which has no row of its own to drop onto.
       */
      const parentFolder = a.parentId
        ? (tier.articles.find((x) => x.nodeId === a.parentId)?.folder ?? null)
        : null;
      const leaf = drag.summary.folder.split("/").pop() ?? drag.summary.folder;
      // The path the node has *after* the move: a reorder naming the old path
      // is a 404, since no folder carries it any more.
      const newFolder = parentFolder ? `${parentFolder}/${leaf}` : leaf;
      void (async () => {
        if (!(await move(tier, drag.summary.folder, parentFolder))) return;
        if (plan.kind === "order") await reorder(tier, newFolder, plan.order);
        else if (plan.orders.length)
          await renumber(
            tier,
            plan.orders.map((o) =>
              o.folder === drag.summary.folder ? { ...o, folder: newFolder } : o,
            ),
          );
      })();
      return;
    }
    // A collapsed midpoint renumbers the whole family in one request; an
    // ordinary drop writes the one number between its neighbours.
    if (plan.kind === "renumber") {
      if (plan.orders.length) void renumber(tier, plan.orders);
      return;
    }
    void reorder(tier, plan.folder, plan.order);
  }

  /*
   * The drop indicator, drawn on the target row's own box.
   *
   * An inline shadow rather than a new stylesheet rule keeps the marker with
   * the component that decides it; the accent line is the gap the row would
   * land in, and "inside" reuses the tree's existing `.drop-target`.
   */
  const dropStyle = (nodeId: string): CSSProperties => {
    if (dropTarget?.nodeId !== nodeId) return {};
    if (dropTarget.mode === "before") return { boxShadow: "inset 0 2px 0 var(--accent)" };
    if (dropTarget.mode === "after") return { boxShadow: "inset 0 -2px 0 var(--accent)" };
    return {};
  };

  const row = (a: KnowledgeSummary, depth: number, tier: KnowledgeTierView) => {
    const selected = a.kind === "article" && article?.summary.nodeId === a.nodeId;
    const openFolder = a.kind === "folder" && Boolean(expanded[a.nodeId]);
    const inside = dropTarget?.nodeId === a.nodeId && dropTarget.mode === "inside";
    const className = `nav-item ${selected ? "active" : ""} ${inside ? "drop-target" : ""}`;
    const style: CSSProperties = {
      width: "100%",
      paddingLeft: 12 + depth * 30,
      textAlign: "left",
      ...dropStyle(a.nodeId),
    };
    /*
     * The drag handlers are shared: a folder row and an article row differ only
     * in their tag and what a click does, so the events live in one place.
     */
    const rowDrag = {
      // Moving a page or a folder is an administrator's, as the route enforces:
      // a member's write is the draft. A row a member cannot move is not
      // draggable at all.
      draggable: tier.canApprove,
      onDragStart: (e: DragEvent) => dragStart(e, a, tier),
      onDragEnd: dragEnd,
      onDragOver: (e: DragEvent) => dragOver(e, a, tier),
      onDragLeave: (e: DragEvent) => {
        // Leaving for a child element is not leaving the row; only a pointer
        // that has actually left the box clears the indicator.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (dropTarget?.nodeId === a.nodeId) setDropTarget(null);
      },
      onDrop: (e: DragEvent) => drop(e, a, tier),
    };
    const body = (
      <>
        {a.kind === "folder" ? (
          <>
            <button
              type="button"
              className="nav-twisty"
              aria-label={openFolder ? t("Collapse") : t("Expand")}
              onClick={(e) => {
                e.stopPropagation();
                toggleFolder(a.nodeId);
              }}
            >
              {openFolder ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {openFolder ? (
              <FolderOpen size={16} aria-hidden="true" />
            ) : (
              <Folder size={16} aria-hidden="true" />
            )}
          </>
        ) : /* A checklist template — a page whose body holds checklist steps a
             workorder instantiates — is marked in red so it is told apart from
             an ordinary page at a glance. A page without a `draft.json` is one
             that exists but was never saved; the faint glyph says so. */
        a.template === "checklist" ? (
          <ClipboardCheck size={16} className="kb-checklist-icon" aria-hidden="true" />
        ) : (
          <FileText size={16} className={a.saved ? "" : "faint"} aria-hidden="true" />
        )}
        <span className="grow truncate">{a.title}</span>
        {/* The in-force revision number, read-only: it belongs to the
            lifecycle, not to the title anyone edits. */}
        <KnowledgeRevBadge rev={a.kind === "article" ? a.rev : null} />
        {a.pending && <span className="hint">{t("Pending")}</span>}
        {a.retired && <span className="hint">{t("Retired")}</span>}
        {tier.canApprove && (
          <button
            type="button"
            className="icon-btn sm nav-row-menu"
            aria-label={t("More")}
            title={t("More")}
            onClick={(e) => openRowMenu(e, a, tier)}
          >
            <MoreHorizontal size={15} />
          </button>
        )}
      </>
    );
    // A folder's row carries the twisty button, which a button row could not
    // legally nest; an article stays a button, as it was.
    if (a.kind === "folder") {
      return (
        <div
          key={a.nodeId}
          className={className}
          style={style}
          title={a.title}
          {...rowDrag}
          onClick={() => toggleFolder(a.nodeId)}
        >
          {body}
        </div>
      );
    }
    return (
      <div
        key={a.nodeId}
        role="button"
        tabIndex={0}
        className={className}
        style={style}
        title={a.title}
        {...rowDrag}
        onClick={() => void open(tier.accountId, a.folder, a.nodeId)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void open(tier.accountId, a.folder, a.nodeId);
          }
        }}
      >
        {body}
      </div>
    );
  };

  /** One tier's rows, nested by `parentId` and folded by `expanded`. */
  const renderTree = (tier: KnowledgeTierView) => {
    const out: ReactNode[] = [];
    // When the Templates filter is on, only checklist templates and the folders
    // that lead to them are shown, and those folders are opened so the template
    // is visible without a click.
    const show = (() => {
      if (!templatesOnly) return null;
      const byId = new Map(tier.articles.map((a) => [a.nodeId, a]));
      const set = new Set<string>();
      for (const a of tier.articles) {
        if (a.kind !== "article" || a.template !== "checklist") continue;
        let cur: KnowledgeSummary | undefined = a;
        while (cur) {
          set.add(cur.nodeId);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
      }
      return set;
    })();
    const walk = (parentId: string | null, depth: number) => {
      for (const a of siblingsOf(tier, parentId)) {
        if (show && !show.has(a.nodeId)) continue;
        out.push(row(a, depth, tier));
        if (a.kind === "folder" && (expanded[a.nodeId] || show))
          walk(a.nodeId, depth + 1);
      }
      // The inline "new page / folder" input sits at the level it will join.
      if (
        !show &&
        creating &&
        creating.accountId === tier.accountId &&
        creating.scope === tier.scope &&
        (creating.parentNodeId ?? null) === parentId
      )
        out.push(
          <InlineCreateRow
            key="__creating__"
            tier={tier}
            parentNodeId={parentId}
            kind={creating.kind}
            depth={depth}
          />,
        );
    };
    walk(null, 0);
    return out;
  };

  const selectedHit = (hit: KnowledgeSearchResult) =>
    article?.summary.nodeId === hit.nodeId;

  return (
    <>
      <div className="list-search row" style={{ padding: "10px 12px" }}>
        <div
          className="search-input"
          style={{
            flex: 1,
            minWidth: 0,
            height: 38,
            background: "var(--bg-sunken)",
            borderRadius: 999,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 12px",
          }}
        >
          <Search size={16} className="muted" aria-hidden="true" />
          <input
            style={{
              flex: 1,
              minWidth: 0,
              border: 0,
              background: "transparent",
              outline: "none",
            }}
            value={search}
            placeholder={t("Search pages")}
            aria-label={t("Search pages")}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runSearch();
              }
            }}
          />
          {searching && <span className="spinner" />}
          <button
            type="button"
            className="icon-btn sm"
            aria-pressed={templatesOnly}
            title={t("Only checklist templates")}
            aria-label={t("Only checklist templates")}
            onClick={() => setTemplatesOnly((v) => !v)}
          >
            <ClipboardCheck
              size={15}
              className={templatesOnly ? "kb-checklist-icon" : "muted"}
            />
          </button>
        </div>
      </div>

      {search.trim() ? (
        <>
          <div className="nav-section">
            <span>{t("Results")}</span>
          </div>
          {results.length === 0 && !searching && (
            <p className="hint" style={{ padding: "4px 12px" }}>
              {t("Nothing found.")}
            </p>
          )}
          {results.map((hit, i) => {
            return (
              <button
                key={`${hit.nodeId}:${i}`}
                type="button"
                className={`nav-item ${selectedHit(hit) ? "active" : ""}`}
                style={{
                  width: "100%",
                  height: "auto",
                  flexDirection: "column",
                  alignItems: "stretch",
                  gap: 2,
                  paddingTop: 6,
                  paddingBottom: 6,
                  textAlign: "left",
                }}
                title={hit.title}
                onClick={() => {
                  const tier = tierOf(hit.accountId, hit.nodeId);
                  const folder = folderOf(hit.nodeId);
                  if (tier && folder) {
                    void open(tier.accountId, folder, hit.nodeId);
                    return;
                  }
                  // The index outran the tier list: re-list, then resolve it,
                  // rather than opening a page with no folder.
                  void reload().then(() => {
                    const t2 = tierOf(hit.accountId, hit.nodeId);
                    const f2 = folderOf(hit.nodeId);
                    if (t2 && f2) void open(t2.accountId, f2, hit.nodeId);
                  });
                }}
              >
                <span className="truncate">{hit.title}</span>
                {hit.snippet && <span className="hint truncate">{hit.snippet}</span>}
              </button>
            );
          })}
        </>
      ) : (
        <>
          {tiers.length === 0 && (
            <p className="hint" style={{ padding: "4px 12px" }}>
              {t("No knowledge base yet.")}
            </p>
          )}
          {tiers.map((tier) => (
            <Fragment key={`${tier.scope}:${tier.accountId}`}>
              <div className="nav-section">
                <span title={tierLabel(tier)}>{tierLabel(tier)}</span>
                {tier.canApprove && (
                  <span className="row" style={{ gap: 2 }}>
                    <button
                      className="icon-btn sm"
                      title={t("New page")}
                      aria-label={t("New page")}
                      onClick={() => void addPage(tier)}
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title={t("New folder")}
                      aria-label={t("New folder")}
                      onClick={() => void addFolder(tier, null)}
                    >
                      <FolderPlus size={14} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title={t("New checklist template")}
                      aria-label={t("New checklist template")}
                      onClick={() => void addTemplate(tier)}
                    >
                      <ClipboardCheck size={14} className="kb-checklist-icon" />
                    </button>
                  </span>
                )}
              </div>
              {renderTree(tier)}
              {tier.articles.length === 0 && (
                <p className="hint" style={{ padding: "4px 12px" }}>
                  {t("No pages yet.")}
                </p>
              )}
            </Fragment>
          ))}
        </>
      )}
      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} width={200}>
          <MenuItem
            label={t("Rename")}
            onClick={() => {
              const m = menu;
              setMenu(null);
              void renameFromMenu(m.tier, m.summary);
            }}
          />
          {menu.tier.canApprove && (
            <MenuItem
              label={
                menu.summary.inForce || menu.summary.pending ? t("Retire") : t("Delete")
              }
              danger={!(menu.summary.inForce || menu.summary.pending)}
              disabled={
                !(menu.summary.inForce || menu.summary.pending) &&
                approvedDescendantsOf(menu.tier, menu.summary.nodeId)
              }
              onClick={() => {
                const m = menu;
                setMenu(null);
                void deleteFromMenu(m.tier, m.summary);
              }}
            />
          )}
        </Popover>
      )}
    </>
  );
}
