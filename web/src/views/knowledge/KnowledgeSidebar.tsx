import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Plus,
  Search,
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  Fragment,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { t } from "@/lib/i18n";
import {
  compareKnowledgeSiblings,
  type KnowledgeSummary,
  type KnowledgeTierView,
  orderBetween,
} from "@/lib/knowledge";
import { useKnowledge } from "@/store/knowledge";
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
 * only the moved row is written. Moving a row onto a folder nests it there.
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

/**
 * One search hit, read tolerantly.
 *
 * The store owns the shape of a result; this view only needs the page's id, its
 * title and a snippet, and reads those fields rather than trusting a layout.
 */
interface SearchHit {
  accountId: string;
  nodeId: string;
  title: string;
  snippet: string;
}

function readHit(raw: unknown): SearchHit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (key: string) => (typeof r[key] === "string" ? (r[key] as string) : "");
  const nodeId = str("nodeId");
  if (!nodeId) return null;
  return {
    accountId: str("accountId"),
    nodeId,
    title: str("title"),
    snippet: str("snippet"),
  };
}

/** The company tier is the installation's; a group tier is named by its group. */
export function tierLabel(tier: KnowledgeTierView): string {
  return tier.scope === "company" ? t("Company") : (tier.group ?? t("Company"));
}

/**
 * The inline "new page / new folder" row.
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
  kind: "page" | "folder";
  depth: number;
}) {
  const create = useKnowledge((s) => s.create);
  const createFolder = useKnowledge((s) => s.createFolder);
  const cancelCreate = useKnowledge((s) => s.cancelCreate);
  const [name, setName] = useState("");
  // One commit per row: a blur after Enter must not create twice.
  const committed = useRef(false);
  const label = kind === "page" ? t("New page") : t("New folder");

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
    else void createFolder(tier, value, parentFolder);
  };

  return (
    <div
      className="nav-item"
      style={{
        paddingLeft: 12 + depth * 16,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {kind === "page" ? (
        <FileText size={16} className="faint" aria-hidden="true" />
      ) : (
        <Folder size={16} className="faint" aria-hidden="true" />
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
  const move = useKnowledge((s) => s.move);
  const creating = useKnowledge((s) => s.creating);
  const beginCreate = useKnowledge((s) => s.beginCreate);
  const reload = useKnowledge((s) => s.reload);
  const setSearch = useKnowledge((s) => s.setSearch);
  const runSearch = useKnowledge((s) => s.runSearch);

  /*
   * Expansion is the reader's own view state, not a document: the KB stores no
   * "open" flag, and a reload rebuilds the tree, so a folded folder stays
   * folded for as long as this sidebar is mounted.
   */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

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
    beginCreate(tier, inTier ? (article?.summary.parentId ?? null) : null, "page");
  };

  const addFolder = (tier: KnowledgeTierView, parentNodeId: string | null) => {
    beginCreate(tier, parentNodeId, "folder");
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
    const sameParent = (drag.summary.parentId ?? "") === (a.parentId ?? "");
    // A before/after drop means "between siblings", so it is only meaningful
    // between rows that share a parent; a drop on a folder still nests.
    if (mode !== "inside" && !sameParent) {
      if (dropTarget) setDropTarget(null);
      return;
    }
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
    if ((drag.summary.parentId ?? "") !== (a.parentId ?? "")) return;
    const siblings = siblingsOf(tier, a.parentId);
    const at = siblings.findIndex((s) => s.nodeId === a.nodeId);
    if (at < 0) return;
    const prev = target.mode === "before" ? siblings[at - 1] : siblings[at];
    const next = target.mode === "before" ? siblings[at] : siblings[at + 1];
    void reorder(
      tier,
      drag.summary.folder,
      orderBetween(prev?.order ?? null, next?.order ?? null),
    );
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
      paddingLeft: 12 + depth * 16,
      textAlign: "left",
      ...dropStyle(a.nodeId),
    };
    /*
     * The drag handlers are shared: a folder row and an article row differ only
     * in their tag and what a click does, so the events live in one place.
     */
    const rowDrag = {
      draggable: true,
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
        ) : (
          /* A page without a `draft.json` is one that exists but was never
             saved; the faint glyph is what says so, and `saved` is what it
             reads. */
          <FileText size={16} className={a.saved ? "" : "faint"} aria-hidden="true" />
        )}
        <span className="grow truncate">{a.title}</span>
        {/* The in-force revision number, read-only: it belongs to the
            lifecycle, not to the title anyone edits. */}
        <KnowledgeRevBadge rev={a.kind === "article" ? a.rev : null} />
        {a.pending && <span className="hint">{t("Pending")}</span>}
        {a.retired && <span className="hint">{t("Retired")}</span>}
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
      <button
        key={a.nodeId}
        type="button"
        className={className}
        style={style}
        title={a.title}
        {...rowDrag}
        onClick={() => void open(tier.accountId, a.folder, a.nodeId)}
      >
        {body}
      </button>
    );
  };

  /** One tier's rows, nested by `parentId` and folded by `expanded`. */
  const renderTree = (tier: KnowledgeTierView) => {
    const out: ReactNode[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const a of siblingsOf(tier, parentId)) {
        out.push(row(a, depth, tier));
        if (a.kind === "folder" && expanded[a.nodeId]) walk(a.nodeId, depth + 1);
      }
      // The inline "new page / folder" input sits at the level it will join.
      if (
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

  const selectedHit = (hit: SearchHit) => article?.summary.nodeId === hit.nodeId;

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
          {results.map((raw, i) => {
            const hit = readHit(raw);
            if (!hit) return null;
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
                </span>
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
    </>
  );
}
