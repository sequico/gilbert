import { BookOpen, Eye } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatDateTime } from "@/lib/datetime";
import { t } from "@/lib/i18n";
import { articleKey } from "@/lib/knowledge";
import { useKnowledge } from "@/store/knowledge";
import { confirmDialog, Dialog, promptDialog } from "@/ui/dialog";
import { Empty, Spinner } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { KnowledgeEditor } from "./KnowledgeEditor";
import { KnowledgeRevBadge } from "./KnowledgeRevBadge";
import { tierLabel } from "./KnowledgeSidebar";

/**
 * The knowledge base's reading and editing pane (ADR 0024).
 *
 * The sidebar chooses the page and this shows it: the body read through
 * `KnowledgeEditor`, the title, tags and lifecycle state around it, and the
 * controls the state allows -- drafting for anyone, approval and the effective
 * date for an administrator only. The store holds the article and the
 * in-progress edit; this view only decides what to draw and when to ask.
 */

/** Now in the `yyyy-mm-ddThh:mm` a native datetime input reads and writes. */
function nowInput(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A stored instant in the reader's own locale, unchanged when unreadable. */
function dateText(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTime(d);
}

export function KnowledgeView({ nodeId }: { nodeId?: string }) {
  const tiers = useKnowledge((s) => s.tiers);
  const loading = useKnowledge((s) => s.loading);
  const article = useKnowledge((s) => s.article);
  const articleLoading = useKnowledge((s) => s.articleLoading);
  const edit = useKnowledge((s) => s.edit);
  const error = useKnowledge((s) => s.error);
  const load = useKnowledge((s) => s.load);
  const open = useKnowledge((s) => s.open);
  const setEdit = useKnowledge((s) => s.setEdit);
  const beginCreate = useKnowledge((s) => s.beginCreate);
  const save = useKnowledge((s) => s.save);
  const approve = useKnowledge((s) => s.approve);
  const restore = useKnowledge((s) => s.restore);
  const rename = useKnowledge((s) => s.rename);
  const remove = useKnowledge((s) => s.remove);
  const showRetired = useKnowledge((s) => s.showRetired);
  const setShowRetired = useKnowledge((s) => s.setShowRetired);

  const [approveOpen, setApproveOpen] = useState(false);
  const [approveDate, setApproveDate] = useState(nowInput);
  const [historyOpen, setHistoryOpen] = useState(false);
  /*
   * Reading and editing are two modes over one open article. The store seeds
   * the working draft (`edit`) whenever it opens a page, so this only says
   * whether the editor is live; leaving the mode is re-opening the page (see
   * `cancelEdit`), which is what discards an uncommitted edit.
   */
  const [editing, setEditing] = useState(false);

  // A different page opens in read mode.
  useEffect(() => {
    setEditing(false);
  }, [article?.accountId, article?.summary.nodeId]);

  // The tree is the store's to read; asking once on mount is enough.
  useEffect(() => {
    void load();
  }, [load]);

  /*
   * A page named by the route -- a link, a bookmark, the back button -- is
   * opened through the store. The sidebar's own clicks open directly and leave
   * the route at `/kb`, so this resolves a page id once and never re-opens it
   * when the store's article changes underneath.
   */
  const resolvedNode = useRef<string | null>(null);
  useEffect(() => {
    if (!nodeId) {
      resolvedNode.current = null;
      return;
    }
    if (resolvedNode.current === nodeId) return;
    for (const tier of tiers) {
      const found = tier.articles.find((a) => a.nodeId === nodeId);
      if (found) {
        resolvedNode.current = nodeId;
        void open(tier.accountId, found.folder, found.nodeId);
        return;
      }
    }
  }, [nodeId, tiers, open]);

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  const activeTier =
    article === null
      ? null
      : (tiers.find(
          (tier) => tier.scope === article.scope && tier.accountId === article.accountId,
        ) ?? null);

  /*
   * The shell's "New page" is a button in the module bar, so the page it starts
   * is asked for here: the current tier, or the first when none is open. The
   * sidebar's inline input is what names it — nothing is asked in a dialog.
   */
  useEffect(() => {
    const onNew = () => {
      const tier = activeTier ?? tiers[0];
      if (!tier) return;
      beginCreate(tier, null, "page");
    };
    window.addEventListener("ihm:knowledge-new", onNew);
    return () => window.removeEventListener("ihm:knowledge-new", onNew);
  }, [activeTier, tiers, beginCreate]);

  if (loading || articleLoading) return <Spinner size="lg" />;
  if (!article) {
    return (
      <div className="p-16">
        <Empty icon={<BookOpen size={40} />} title={t("Select a page, or create one.")} />
      </div>
    );
  }

  /*
   * The reader sees the revision in force; a page with nothing issued shows its
   * unapproved draft, read-only, so there is still something to read. Editing
   * works on the store's draft, which `open` seeded.
   */
  const readerTitle =
    article.effective?.title ?? article.draft?.title ?? article.summary.title;
  const readerTags =
    article.effective?.tags ?? article.draft?.tags ?? article.summary.tags;
  // An article something was issued from is retired, not destroyed; one no
  // approval ever touched is removed outright (ADR 0024). A folder whose own
  // state is unapproved can still hold an approved sub-article, which the server
  // refuses to destroy — the control says so rather than inviting the click.
  const approvedDescendants = (() => {
    const list = activeTier?.articles ?? [];
    const seen = new Set<string>([article.summary.nodeId]);
    const stack = [article.summary.nodeId];
    while (stack.length) {
      const id = stack.pop()!;
      for (const child of list) {
        if ((child.parentId ?? "") !== id || seen.has(child.nodeId)) continue;
        seen.add(child.nodeId);
        if (child.inForce || child.pending) return true;
        stack.push(child.nodeId);
      }
    }
    return false;
  })();
  const everApproved =
    article.revisions.length > 0 ||
    Boolean(article.summary.inForce) ||
    Boolean(article.summary.pending);
  const title = editing && edit ? edit.title : readerTitle;
  const tags = editing && edit ? edit.tags : readerTags;
  const body =
    editing && edit
      ? edit.blocks
      : (article.effective?.blocks ?? article.draft?.blocks ?? []);

  /*
   * Leaving edit mode re-opens the page, which re-seeds the store's draft and
   * drops whatever was typed. That is the only way to discard an edit: the
   * store's `setEdit` has no reset, and a working draft left dirty would return
   * the next time Edit is pressed.
   */
  const cancelEdit = async () => {
    setEditing(false);
    await open(article.accountId, article.summary.folder, article.summary.nodeId);
  };

  const doSave = async () => {
    // Only leave edit mode when the save landed: a failed save keeps the
    // working draft on screen so it is not quietly thrown away.
    if (await save()) setEditing(false);
  };

  const doRename = async () => {
    const name = await promptDialog({
      title: t("Rename"),
      defaultValue: readerTitle,
    });
    if (!name?.trim() || name === readerTitle) return;
    await rename(name.trim());
  };

  const doRemove = async () => {
    const ok = await confirmDialog(
      everApproved
        ? {
            title: t("Retire “{title}”?", { title: readerTitle }),
            message: t(
              "It leaves the tree but stays on record, with its revisions; find it again by showing retired articles.",
            ),
            confirmLabel: t("Retire"),
          }
        : {
            title: t("Delete “{title}”?", { title: readerTitle }),
            message: t("This cannot be undone."),
            confirmLabel: t("Delete"),
            danger: true,
          },
    );
    if (!ok) return;
    await remove();
  };

  return (
    <div className="files-layout">
      <div
        className="row"
        style={{
          gap: 8,
          flexWrap: "wrap",
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {/*
         * The tier can be switched here, but the page is the sidebar's to
         * choose: picking a tier opens its first page, which is the only page
         * this control could name without a tree of its own.
         */}
        <select
          className="select"
          style={{ width: "auto", maxWidth: 240, flex: "0 0 auto" }}
          value={activeTier ? `${activeTier.scope}:${activeTier.accountId}` : ""}
          aria-label={t("KB")}
          onChange={(e) => {
            const tier = tiers.find(
              (x) => `${x.scope}:${x.accountId}` === e.target.value,
            );
            const first = tier?.articles.find((a) => a.kind !== "folder");
            if (tier && first) void open(tier.accountId, first.folder, first.nodeId);
          }}
        >
          {!activeTier && <option value="">{t("KB")}</option>}
          {tiers.map((tier) => (
            <option
              key={`${tier.scope}:${tier.accountId}`}
              value={`${tier.scope}:${tier.accountId}`}
            >
              {tierLabel(tier)}
            </option>
          ))}
        </select>
        {/* Retired pages are hidden by default so they do not confuse the tree;
            this toggle is how a reader asks to see them. A labelled pill with a
            pressed state, not a loose checkbox. */}
        <button
          type="button"
          className={`btn btn-sm ${showRetired ? "btn-primary" : "btn-ghost"}`}
          aria-pressed={showRetired}
          title={t("Show retired pages")}
          onClick={() => setShowRetired(!showRetired)}
        >
          <Eye size={14} /> {t("Retired")}
        </button>
        <span className="spacer" />
        <button
          className="btn btn-sm"
          disabled={editing}
          onClick={() => setEditing(true)}
        >
          {t("Edit")}
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={!editing || !edit?.dirty}
          onClick={() => void doSave()}
        >
          {t("Save")}
        </button>
        {/* Leaving edit mode re-reads the page, which is what drops the typed
            changes (see `cancelEdit`). */}
        <button
          className="btn btn-sm"
          disabled={!editing}
          onClick={() => void cancelEdit()}
        >
          {t("Cancel")}
        </button>
        {activeTier?.canApprove && (
          <button
            className="btn btn-sm"
            onClick={() => {
              setApproveDate(nowInput());
              setApproveOpen(true);
            }}
          >
            {t("Approve")}
          </button>
        )}
        <button className="btn btn-sm" onClick={() => setHistoryOpen(true)}>
          {t("History")}
        </button>
        {/* Creating, renaming and deleting pages is an administrator's; a
            member's write is the draft itself (ADR 0024). */}
        {activeTier?.canApprove && (
          <button className="btn btn-sm" onClick={() => void doRename()}>
            {t("Rename")}
          </button>
        )}
        {/* Deleting is an administrator's, as the route enforces; the button is
            drawn only where the server would accept it, and named for what it
            does: an approved article is retired, a draft is deleted. */}
        {activeTier?.canApprove && (
          <button
            className={`btn btn-sm ${everApproved ? "" : "btn-danger"}`}
            disabled={!everApproved && approvedDescendants}
            title={
              !everApproved && approvedDescendants
                ? t("This folder holds an approved article; retire or move it first.")
                : undefined
            }
            onClick={() => void doRemove()}
          >
            {everApproved ? t("Retire") : t("Delete")}
          </button>
        )}
      </div>

      <div style={{ padding: "16px 16px 0" }}>
        {/* The in-force revision number sits beside the title, read-only: it is
            the lifecycle's fact, never part of the title string the editor
            writes, so it stays out of the input and out of `edit`. */}
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          {editing && edit ? (
            <input
              className="input"
              style={{ flex: 1, minWidth: 0 }}
              value={edit.title}
              aria-label={t("Title")}
              placeholder={t("Title")}
              onChange={(e) => setEdit({ title: e.target.value })}
            />
          ) : (
            <h2 className="truncate" style={{ margin: 0, flex: 1, minWidth: 0 }}>
              {title}
            </h2>
          )}
          <KnowledgeRevBadge rev={article.summary.rev} />
        </div>

        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {editing && edit ? (
            <input
              className="input sm grow"
              value={edit.tags.join(", ")}
              aria-label={t("Tags")}
              placeholder={t("Tags, comma separated")}
              onChange={(e) =>
                setEdit({
                  tags: e.target.value
                    .split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                })
              }
            />
          ) : (
            tags.map((tag) => (
              <span key={tag} className="chip">
                {tag}
              </span>
            ))
          )}
        </div>

        <div className="row" style={{ gap: 10, marginTop: 10 }}>
          {/* In force and pending can both be true: an issued revision is what
              readers see until a future-dated one takes over. */}
          {article.effective && (
            <span className="hint">
              {t("In force")} · {dateText(article.effective.effectiveAt)}
            </span>
          )}
          {article.summary.pending && (
            <span className="hint">
              {t("Pending until {date}", {
                date: dateText(article.summary.pending.effectiveAt),
              })}
            </span>
          )}
          {!article.effective && !article.summary.pending && (
            <span className="hint">{t("Draft")}</span>
          )}
        </div>

        {/* v1's honest conflict note (ADR 0024 Q13): the whole draft is saved,
            several people can edit it, and a save that would overwrite
            somebody else's change is refused rather than losing it. */}
        <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
          {t(
            "Saving writes the whole draft. Several people can edit a page at once; real-time co-editing comes later (ADR 0024).",
          )}
        </p>
      </div>

      <div className="files-scroll">
        {/* BlockNote is uncontrolled, so a new article -- or a switch between
            reading and editing, which seeds different blocks -- remounts it. */}
        <KnowledgeEditor
          key={`${articleKey(article.accountId, article.summary.nodeId)}:${editing ? "edit" : "read"}`}
          blocks={body}
          editable={editing}
          onChange={(blocks, text) => setEdit({ blocks, text })}
        />
      </div>

      <Dialog
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title={t("Approve")}
        size="sm"
        footer={
          <>
            <button className="btn" onClick={() => setApproveOpen(false)}>
              {t("Cancel")}
            </button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                // The instant the administrator chose, in their own timezone,
                // stored as one UTC instant so every reader sees it in theirs.
                const at = new Date(approveDate).toISOString();
                if (await approve(at)) setApproveOpen(false);
              }}
            >
              {t("Approve")}
            </button>
          </>
        }
      >
        <label htmlFor="kb-effective" style={{ display: "block" }}>
          {t("Date it takes effect")}
        </label>
        <input
          id="kb-effective"
          className="input"
          type="datetime-local"
          value={approveDate}
          onChange={(e) => setApproveDate(e.target.value)}
        />
      </Dialog>

      <Dialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title={t("History")}
        size="md"
      >
        {article.revisions.length === 0 && (
          <p className="hint" style={{ marginTop: 0 }}>
            {t("No revisions yet.")}
          </p>
        )}
        {article.revisions.map((rev) => (
          <div
            key={rev.revision}
            className="row"
            style={{
              gap: 10,
              padding: "8px 0",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="truncate">{rev.title}</div>
              <div className="hint">
                {t("Approved {date} by {who}", {
                  date: dateText(rev.approvedAt),
                  who: rev.approvedBy,
                })}
              </div>
              <div className="hint">
                {t("In force from {date}", { date: dateText(rev.effectiveAt) })}
              </div>
            </div>
            {activeTier?.canApprove && (
              <button
                className="btn btn-sm"
                onClick={async () => {
                  try {
                    await restore(rev.revision);
                    setHistoryOpen(false);
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }}
              >
                {t("Restore")}
              </button>
            )}
          </div>
        ))}
      </Dialog>
    </div>
  );
}
