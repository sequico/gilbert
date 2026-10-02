import { FileText, Plus, Search } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import type { KnowledgeSummary, KnowledgeTierView } from "@/lib/knowledge";
import { useKnowledge } from "@/store/knowledge";

/**
 * The knowledge base's tree of articles (ADR 0024).
 *
 * Two tiers, one shape: the company KB leads -- it is the installation's, read
 * by everyone -- and each group the reader is in follows. The tree is the
 * FileNode tree the store flattens into `articles`, rebuilt here by `parentId`
 * so a sub-article sits under the article that owns it.
 *
 * Search replaces the tree rather than filtering it: a hit can live in any tier
 * and any depth, and an article is found by its text, not by where it sits.
 */

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

export function KnowledgeSidebar() {
  const tiers = useKnowledge((s) => s.tiers);
  const search = useKnowledge((s) => s.search);
  const results = useKnowledge((s) => s.results);
  const searching = useKnowledge((s) => s.searching);
  const article = useKnowledge((s) => s.article);
  const open = useKnowledge((s) => s.open);
  const create = useKnowledge((s) => s.create);
  const reload = useKnowledge((s) => s.reload);
  const setSearch = useKnowledge((s) => s.setSearch);
  const runSearch = useKnowledge((s) => s.runSearch);

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
   * A new article is created in a tier, and under the selected article when one
   * is open in that same tier: a sub-page is what the reader was looking at,
   * and the parent's folder is what the writer takes. With nothing selected it
   * lands at the tier root.
   */
  const addPage = async (tier: KnowledgeTierView) => {
    const name = window.prompt(t("New page"));
    if (!name?.trim()) return;
    const under =
      article && article.scope === tier.scope && article.accountId === tier.accountId
        ? article.summary.folder
        : null;
    await create(tier, name.trim(), under);
  };

  const articleRow = (a: KnowledgeSummary, depth: number, tier: KnowledgeTierView) => {
    const selected = article?.summary.nodeId === a.nodeId;
    return (
      <button
        key={a.nodeId}
        type="button"
        className={`nav-item ${selected ? "active" : ""}`}
        style={{ width: "100%", paddingLeft: 12 + depth * 16, textAlign: "left" }}
        title={a.title}
        onClick={() => void open(tier.accountId, a.folder, a.nodeId)}
      >
        {/* A folder without a `draft.json` is a page that exists but was never
            saved; the faint glyph is what says so, and the store's `saved` flag
            is what it reads. */}
        <FileText size={16} className={a.saved ? "" : "faint"} aria-hidden="true" />
        <span className="grow truncate">{a.title}</span>
        {a.pending && <span className="hint">{t("Pending")}</span>}
        {a.retired && <span className="hint">{t("Retired")}</span>}
      </button>
    );
  };

  /** One tier's articles, nested by `parentId`. */
  const renderTree = (tier: KnowledgeTierView) => {
    const byParent = new Map<string, KnowledgeSummary[]>();
    for (const a of tier.articles) {
      const key = a.parentId ?? "";
      const list = byParent.get(key) ?? [];
      list.push(a);
      byParent.set(key, list);
    }
    const out: ReactNode[] = [];
    const walk = (parentId: string, depth: number) => {
      for (const a of byParent.get(parentId) ?? []) {
        out.push(articleRow(a, depth, tier));
        walk(a.nodeId, depth + 1);
      }
    };
    walk("", 0);
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
                <button
                  className="icon-btn sm"
                  title={t("New page")}
                  aria-label={t("New page")}
                  onClick={() => void addPage(tier)}
                >
                  <Plus size={14} />
                </button>
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
