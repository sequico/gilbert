/**
 * The knowledge base store (ADR 0020).
 *
 * One store serves both tiers — the company KB and each group's — because the
 * documents and the surface are the same and only the owning account differs.
 * The company tier is read through the server route that acts as the Master;
 * a group tier is the reader's own FileNode tree, read through their session on
 * the group's account. Writes go through the server route for both.
 *
 * The company lead is the scope that ships first, but nothing here is
 * company-shaped: `tiers` is an ordered list, the company tier first, then one
 * per probed group mailbox, the contact sidebar's own arrangement.
 *
 * Search is Orama in-process over the articles' `text`, rebuilt lazily per
 * search (ADR 0020 Q14), so the human box shares a corpus with the server's
 * own lookup — which reads the same `text` without Orama — without a second
 * service and without a cached index to go stale.
 */

import { mapLimit, READ_CONCURRENCY } from "@gilbert/shared/concurrency";
import { errorMessage } from "@gilbert/shared/errors";
import { sessionIsAdmin } from "@gilbert/shared/sessionAccount";
import { create } from "zustand";
import type { Id } from "@/jmap/types";
import { t } from "@/lib/i18n";
import {
  approveArticle,
  articleKey,
  checklistBlocks,
  companyArticle,
  companyText,
  companyTree,
  createArticle,
  createKnowledgeFolder,
  deleteArticle,
  findKnowledgeFolder,
  type KnowledgeArticleInput,
  type KnowledgeArticleView,
  type KnowledgeChecklist,
  type KnowledgeSummary,
  type KnowledgeTarget,
  listArticles,
  moveKnowledgeArticle,
  plainTextFromBlocks,
  readArticle,
  readArticleText,
  renameArticle,
  reorderKnowledgeArticle,
  reorderKnowledgeArticles,
  restoreArticle,
  saveDraft,
} from "@/lib/knowledge";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";

interface KnowledgeTierState {
  scope: "company" | "group";
  accountId: Id;
  /** The group's own name (address) for a group tier, null for the company. */
  group: string | null;
  /** Whether the reader is an installation administrator (approval's gate). */
  canApprove: boolean;
  articles: KnowledgeSummary[];
}

/** The open article's unsaved edits, as the editor holds them. */
interface KnowledgeEdit {
  title: string;
  tags: string[];
  blocks: unknown[];
  text: string;
  /** A checklist template's rules, or null for an ordinary page (ADR 0026). */
  checklist: KnowledgeChecklist | null;
  dirty: boolean;
}

/** One knowledge-base search hit, as the sidebar lists it and opens it. */
export interface KnowledgeSearchResult {
  accountId: Id;
  nodeId: Id;
  scope: "company" | "group";
  title: string;
  snippet: string;
}

interface KnowledgeStore {
  tiers: KnowledgeTierState[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The open article, or null when none is. */
  article: KnowledgeArticleView | null;
  articleLoading: boolean;
  /** Unsaved edits of the open article, or null when none is open. */
  edit: KnowledgeEdit | null;
  search: string;
  searching: boolean;
  /** The term the last run searched; gates "Nothing found." while typing. */
  searchedTerm: string;
  /** Show retired articles beside the standing ones, off by default. */
  showRetired: boolean;
  results: KnowledgeSearchResult[];

  /** Discover the tiers and list their articles. */
  load(): Promise<void>;
  reload(): Promise<void>;
  open(accountId: Id, folder: string, nodeId: Id): Promise<void>;
  close(): void;
  setEdit(patch: Partial<KnowledgeEdit>): void;
  create(
    tier: KnowledgeTierState,
    title: string,
    parentFolder: string | null,
    /** Initial blocks, for an ordinary page. */
    blocks?: unknown[],
    /** Initial rules, for a checklist template (ADR 0026). */
    checklist?: KnowledgeChecklist | null,
  ): Promise<boolean>;
  createFolder(
    tier: KnowledgeTierState,
    name: string,
    parentFolder: string | null,
  ): Promise<boolean>;
  reorder(tier: KnowledgeTierState, folder: string, order: number): Promise<boolean>;
  /**
   * Renumber a family of siblings in one request, when a drop's fractional
   * order has run out of precision. The `orders` are the changed places; a row
   * not named keeps its own.
   */
  renumber(
    tier: KnowledgeTierState,
    orders: Array<{ folder: string; order: number }>,
  ): Promise<boolean>;
  move(
    tier: KnowledgeTierState,
    folder: string,
    parentFolder: string | null,
  ): Promise<boolean>;
  save(): Promise<boolean>;
  approve(effectiveAt: string): Promise<boolean>;
  restore(revision: string): Promise<boolean>;
  rename(title: string): Promise<boolean>;
  remove(): Promise<boolean>;
  /** Rename one tree node — an article or a topic folder — from its row. */
  renameNode(
    tier: KnowledgeTierState,
    summary: KnowledgeSummary,
    title: string,
  ): Promise<boolean>;
  /** Delete one tree node from its row; a folder goes with what it holds. */
  removeNode(tier: KnowledgeTierState, summary: KnowledgeSummary): Promise<boolean>;
  setSearch(term: string): void;
  /** Empty the box and its results, so the tree is what shows again. */
  clearSearch(): void;
  setShowRetired(on: boolean): void;
  /**
   * Where an inline "new page / new folder" input is open, or null. Creation is
   * inline in the tree — no `window.prompt`, no dialog: the row appears where
   * the node will land and Enter commits it.
   */
  creating: {
    accountId: Id;
    scope: "company" | "group";
    parentNodeId: string | null;
    kind: "page" | "folder" | "template";
  } | null;
  beginCreate(
    tier: KnowledgeTierState,
    parentNodeId: string | null,
    kind: "page" | "folder" | "template",
  ): void;
  cancelCreate(): void;
  runSearch(): Promise<void>;
  /** A FileNode change arrived for an account the store holds: re-list its tier. */
  applyChanges(accountId: Id): Promise<void>;
  reset(): void;
}

/** The snippet a result shows: the term's neighbourhood, or the text's start. */
function snippetOf(text: string, term: string): string {
  const at = text.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return text.slice(0, 160).trim();
  const start = Math.max(0, at - 60);
  return text.slice(start, start + 180).trim();
}

/** A load asked for while one is already running, run again when it ends. */
let loadPending = false;

/*
 * Bumped when the store is emptied, so a load that started under the old
 * session drops its answer instead of repopulating the store behind a sign-out.
 */
let loadEpoch = 0;

/*
 * Names the open in progress. Every `open` -- and `close` -- takes the next
 * value, so an answer from an earlier request is discarded rather than applied
 * over the article the reader is actually on.
 */
let openToken = 0;

/**
 * The text a search reads, kept for the session and dropped on every re-list.
 *
 * The box searches as the reader types, so a page must be read once rather than
 * once per keystroke; and a page changed since — any write re-lists the tree —
 * is read again rather than searched at its old body, which is the staleness
 * the per-search rebuild exists to avoid.
 */
const searchText = new Map<string, string>();

/**
 * The search whose answer is still wanted.
 *
 * A run is asked again on every keystroke, and the session can end while one is
 * reading: an answer that lands after either describes a term nobody is looking
 * at, or a page read under a session that has gone. Each run takes the next
 * number and writes its answer only while it still holds the latest.
 */
let searchToken = 0;

/**
 * How long a burst of FileNode changes is collapsed over before the one
 * re-list it causes.
 *
 * The rail names an account and nothing else, and a group's chat, knowledge
 * base and settings all ride it: answering every change with a full tree walk
 * would re-read the KB once per message. The first change of a burst opens the
 * window and later ones ride it, so the surface is at most one window behind
 * the rail — the same arrangement the workorder store keeps.
 */
export const KNOWLEDGE_CHANGE_WINDOW_MS = 1500;

/** The window each followed account has open, by account id. */
const changeWindows = new Map<string, ReturnType<typeof setTimeout>>();

export const useKnowledge = create<KnowledgeStore>((set, get) => {
  /**
   * A write, and the re-read that follows it — the two told apart.
   *
   * Every mutation here writes a document and then re-reads what it changed: the
   * article, the tree that mirrors its title, the folder a rename moved. Both sat
   * in one `try`, so a `reload()` that failed — a **read** — was reported as the
   * write having failed: the reader was told their text was not saved when it
   * was, so they typed it again or pressed save again, and the retry was a second
   * write. `false` now means exactly one thing, that the document was not
   * written; a refresh that fails says so without claiming the write went with
   * it.
   */
  const writeThenRefresh = async <T>(
    write: () => Promise<T>,
    refresh: (written: T) => Promise<void>,
  ): Promise<boolean> => {
    let written: T;
    try {
      set({ error: null });
      written = await write();
    } catch (err) {
      set({ error: errorMessage(err) });
      return false;
    }
    try {
      await refresh(written);
    } catch (err) {
      set({
        error: t("Saved, but the view could not be refreshed: {error}", {
          error: errorMessage(err),
        }),
      });
    }
    return true;
  };

  /** The open article's write target: its scope, its group and its folder. */
  function targetOf(view: KnowledgeArticleView): KnowledgeTarget | null {
    const tier = get().tiers.find(
      (t) => t.accountId === view.accountId && t.scope === view.scope,
    );
    if (!tier) return null;
    return {
      scope: tier.scope,
      ...(tier.group ? { group: tier.group } : {}),
      folder: view.summary.folder,
    };
  }

  /** The tier's scope for an account, company when no tier names it. */
  function scopeOf(accountId: Id): "company" | "group" {
    return get().tiers.find((t) => t.accountId === accountId)?.scope ?? "company";
  }

  /**
   * The article text the index carries, read lazily.
   *
   * The open article answers from the draft in hand — including unsaved edits,
   * which is what the reader sees and should search — and any other article is
   * read once through the tier's own door: the company route that acts as the
   * Master, or `readArticle` on the group's own session. The bound is the
   * loaded tiers: nothing is discovered beyond them, so a search never walks an
   * account nobody asked for.
   */
  async function textOf(
    tier: KnowledgeTierState,
    summary: KnowledgeSummary,
  ): Promise<string> {
    const { article, edit } = get();
    if (
      article &&
      article.accountId === tier.accountId &&
      article.summary.nodeId === summary.nodeId
    ) {
      return edit?.text ?? article.draft?.text ?? "";
    }
    try {
      /*
       * Search indexes a page's text, not its history: the whole article view
       * would make reading one page's body cost its revision history, and a
       * cold search pays that once per page.
       */
      const text =
        tier.scope === "company"
          ? await companyText(summary.folder)
          : await readArticleText(tier.accountId, summary.nodeId);
      return text ?? "";
    } catch {
      return "";
    }
  }

  /** Re-open the article a write just changed, by the summary the route echoed. */
  async function reopen(accountId: Id, summary: KnowledgeSummary): Promise<void> {
    await get().open(accountId, summary.folder, summary.nodeId);
  }

  /**
   * Re-list one group's tier after a burst of changes on its rail.
   *
   * The pages of that account drop their remembered text: a body that changed
   * elsewhere must be searched at its new words, and the memory is keyed by
   * the account, so its own entries are the whole of what is stale.
   */
  async function rereadTier(accountId: Id): Promise<void> {
    try {
      set({ error: null });
      const folderId = await findKnowledgeFolder(accountId);
      if (!folderId) return;
      const articles = await listArticles(accountId, folderId, get().showRetired);
      for (const key of searchText.keys())
        if (key.startsWith(`${accountId}:`)) searchText.delete(key);
      set((s) => ({
        tiers: s.tiers.map((tier) =>
          tier.accountId === accountId ? { ...tier, articles } : tier,
        ),
      }));
      // The open page is reconciled too, unless it holds unsaved edits.
      const open = get().article;
      if (open && open.accountId === accountId && !get().edit?.dirty)
        await get().open(open.accountId, open.summary.folder, open.summary.nodeId);
    } catch {
      /* a failed reconcile leaves the tree as it was; the next event retries */
    }
  }

  return {
    tiers: [],
    loaded: false,
    loading: false,
    error: null,
    article: null,
    articleLoading: false,
    edit: null,
    search: "",
    searching: false,
    searchedTerm: "",
    showRetired: false,
    creating: null,
    results: [],

    async load() {
      if (get().loading) {
        // A probe that lands mid-load is not dropped: the tiers are rebuilt
        // again once this one finishes, so a group discovered meanwhile appears.
        loadPending = true;
        return;
      }
      set({ loading: true, error: null });
      const epoch = loadEpoch;
      const canApprove = sessionIsAdmin(useSession.getState().session);
      const tiers: KnowledgeTierState[] = [];

      /*
       * The company KB first, read through the route that acts as the Master.
       * The route answers the account and the tree, honouring the reader's
       * "show retired" choice the same way a group tier does. A boot that fails
       * the route leaves the company tier out and still loads the group tiers;
       * one tier's failure never takes `load()` down with it.
       */
      try {
        set({ error: null });
        const company = await companyTree(get().showRetired);
        if (company.accountId) {
          tiers.push({
            scope: "company",
            accountId: company.accountId,
            group: null,
            canApprove,
            articles: company.articles,
          });
        }
      } catch {
        /* the company tier is absent this load; nothing else is affected */
      }

      /*
       * Then one tier per probed group mailbox, in the probe's own order. A
       * group that has no `knowledge` folder yet is still a tier, with an empty
       * list: creating the folder is the group's first article's job, not a
       * read's, and a surface that hid the tier would offer no way to start one.
       */
      const groupTiers = await mapLimit(
        groupMailboxAccounts(useMail.getState().mailAccounts),
        READ_CONCURRENCY,
        async (group) => {
          let articles: KnowledgeSummary[] = [];
          try {
            const folderId = await findKnowledgeFolder(group.accountId);
            if (folderId)
              articles = await listArticles(group.accountId, folderId, get().showRetired);
          } catch {
            articles = [];
          }
          return {
            scope: "group" as const,
            accountId: group.accountId,
            group: group.name,
            canApprove,
            articles,
          };
        },
      );
      tiers.push(...groupTiers);

      // The store was emptied while the tiers were being read -- a sign-out --
      // so this answer belongs to nobody and is dropped.
      if (epoch !== loadEpoch) return;
      searchText.clear();
      set({ tiers, loaded: true, loading: false });
      if (loadPending) {
        loadPending = false;
        void get().load();
      }
    },

    async reload() {
      set({ loaded: false });
      await get().load();
    },

    async open(accountId, folder, nodeId) {
      const token = ++openToken;
      set({ articleLoading: true, article: null, edit: null });
      try {
        set({ error: null });
        const tier = get().tiers.find((t) => t.accountId === accountId);
        const summary = tier?.articles.find((a) => a.nodeId === nodeId);
        // A topic folder is a group, not a page: it has no draft to open and
        // must never be turned into an article by an edit (ADR 0020).
        if (summary?.kind === "folder") {
          set({ articleLoading: false });
          return;
        }
        // The company tier is opened through the route that acts as the
        // Master; a group's is opened through the reader's own session, where
        // a uid and a folder are theirs to read.
        const view =
          tier?.scope === "company"
            ? await companyArticle(folder)
            : await readArticle(
                accountId,
                nodeId,
                nodeId,
                folder,
                tier?.scope ?? scopeOf(accountId),
                summary?.parentId,
              );
        // A newer open (or a close) has landed since this one asked: its answer
        // is not the article on screen, and applying it would throw away the
        // reader's edits to the one that is.
        if (token !== openToken) return;
        if (!view) {
          set({ articleLoading: false });
          return;
        }
        const draft = view.draft;
        set({
          article: view,
          edit: {
            title: draft?.title ?? "",
            tags: draft?.tags ?? [],
            blocks: draft?.blocks ?? [],
            text: draft?.text ?? "",
            checklist: draft?.checklist ?? null,
            dirty: false,
          },
          articleLoading: false,
        });
      } catch (err) {
        if (token !== openToken) return;
        set({ articleLoading: false, error: errorMessage(err) });
      }
    },

    close() {
      // A close outranks any open still in flight: its answer must not land on
      // an article nobody is looking at.
      openToken += 1;
      set({ article: null, articleLoading: false, edit: null });
    },

    setEdit(patch) {
      const edit = get().edit;
      if (!edit) return;
      const next: KnowledgeEdit = { ...edit, ...patch, dirty: true };
      // A template's rules are the source of truth for its body and the editor's
      // blocks are for an ordinary page: whichever moved, the plain text follows
      // it so search and every reader see the same bytes.
      if (patch.checklist !== undefined) {
        next.text = patch.checklist
          ? plainTextFromBlocks(checklistBlocks(patch.checklist))
          : "";
      } else if (patch.blocks !== undefined) {
        next.text = plainTextFromBlocks(patch.blocks);
      }
      set({ edit: next });
    },

    async create(tier, title, parentFolder, blocks, checklist) {
      const target: KnowledgeTarget = {
        scope: tier.scope,
        ...(tier.group ? { group: tier.group } : {}),
      };
      return writeThenRefresh(
        () => createArticle(target, title, parentFolder, blocks, checklist),
        async () => {
          await get().reload();
        },
      );
    },

    async createFolder(tier, name, parentFolder) {
      const target: KnowledgeTarget = {
        scope: tier.scope,
        ...(tier.group ? { group: tier.group } : {}),
      };
      return writeThenRefresh(
        () => createKnowledgeFolder(target, name, parentFolder),
        async () => {
          await get().reload();
        },
      );
    },

    async reorder(tier, folder, order) {
      // The tier is the caller's, not the open page's: a drag happens in a
      // tier that may hold no open article at all.
      const target: KnowledgeTarget = {
        scope: tier.scope,
        ...(tier.group ? { group: tier.group } : {}),
        folder,
      };
      return writeThenRefresh(
        () => reorderKnowledgeArticle(target, folder, order),
        async () => {
          // Ordering is the tier's fact, not the open article's, so a re-list
          // refreshes the tree without losing what is open.
          await get().reload();
        },
      );
    },

    async renumber(tier, orders) {
      if (!orders.length) return true;
      // The tier is the caller's, not one open page's: a renumber spans a whole
      // family, and each order carries its own folder.
      const target: KnowledgeTarget = {
        scope: tier.scope,
        ...(tier.group ? { group: tier.group } : {}),
      };
      return writeThenRefresh(
        () => reorderKnowledgeArticles(target, orders),
        async () => {
          await get().reload();
        },
      );
    },

    async move(tier, folder, parentFolder) {
      const target: KnowledgeTarget = {
        scope: tier.scope,
        ...(tier.group ? { group: tier.group } : {}),
        folder,
      };
      return writeThenRefresh(
        () => moveKnowledgeArticle(target, folder, parentFolder),
        async () => {
          await get().reload();
        },
      );
    },

    async save() {
      const { article, edit } = get();
      if (!article || !edit) return false;
      const target = targetOf(article);
      if (!target) return false;
      const input: KnowledgeArticleInput = {
        title: edit.title,
        tags: edit.tags,
        blocks: edit.blocks,
        text: edit.text,
        checklist: edit.checklist,
      };
      return writeThenRefresh(
        // A save rewrites the document; only a rename moves the folder, so the
        // re-open follows the folder the article already has.
        () => saveDraft(target, input),
        async (summary) => {
          await reopen(article.accountId, summary);
          // A save rewrites the title a listing mirrors, so the tree is
          // re-listed rather than left reading its old one.
          await get().reload();
        },
      );
    },

    async approve(effectiveAt) {
      const { article } = get();
      if (!article) return false;
      const target = targetOf(article);
      if (!target) return false;
      return writeThenRefresh(
        () => approveArticle(target, effectiveAt),
        async (summary) => {
          await reopen(article.accountId, summary);
          // The approval moves `rev` and the pending marker the sidebar badges,
          // which the tree — not the open article — carries.
          await get().reload();
        },
      );
    },

    async restore(revision) {
      const { article } = get();
      if (!article) return false;
      const target = targetOf(article);
      if (!target) return false;
      return writeThenRefresh(
        () => restoreArticle(target, revision),
        async (summary) => {
          await reopen(article.accountId, summary);
          // Restoring an older revision moves `rev` and the pending marker, so
          // the tree is re-listed with the open article kept.
          await get().reload();
        },
      );
    },

    async rename(title) {
      const { article } = get();
      if (!article) return false;
      const target = targetOf(article);
      if (!target) return false;
      return writeThenRefresh(
        () => renameArticle(target, title),
        async (summary) => {
          await reopen(article.accountId, summary);
          // The folder moved, and the sidebar still carries the old path; the
          // tiers are re-listed so a click sends the path the door resolves.
          await get().reload();
        },
      );
    },

    async remove() {
      const { article } = get();
      if (!article) return false;
      const target = targetOf(article);
      if (!target) return false;
      return writeThenRefresh(
        async () => {
          await deleteArticle(target);
          set({ article: null, edit: null, articleLoading: false });
        },
        async () => {
          await get().reload();
        },
      );
    },

    async renameNode(tier, summary, title) {
      const target: KnowledgeTarget = {
        scope: tier.scope,
        ...(tier.group ? { group: tier.group } : {}),
        folder: summary.folder,
      };
      return writeThenRefresh(
        () => renameArticle(target, title),
        async (renamed) => {
          // The open page, if it is this node, follows the folder the door moved.
          const open = get().article;
          if (open && open.summary.nodeId === summary.nodeId)
            await reopen(tier.accountId, renamed);
          await get().reload();
        },
      );
    },

    async removeNode(tier, summary) {
      const target: KnowledgeTarget = {
        scope: tier.scope,
        ...(tier.group ? { group: tier.group } : {}),
        folder: summary.folder,
      };
      return writeThenRefresh(
        async () => {
          await deleteArticle(target);
          // A folder takes its descendants with it: close the open page if it is
          // the node itself or anything under it.
          const open = get().article;
          if (
            open &&
            (open.summary.nodeId === summary.nodeId ||
              open.summary.folder === summary.folder ||
              open.summary.folder.startsWith(`${summary.folder}/`))
          )
            set({ article: null, edit: null, articleLoading: false });
        },
        async () => {
          await get().reload();
        },
      );
    },

    setSearch(term) {
      set({ search: term });
    },

    clearSearch() {
      set({ search: "", results: [], searching: false, searchedTerm: "" });
    },

    setShowRetired(on) {
      set({ showRetired: on });
      void get().reload();
    },

    beginCreate(tier, parentNodeId, kind) {
      set({
        creating: { accountId: tier.accountId, scope: tier.scope, parentNodeId, kind },
      });
    },

    cancelCreate() {
      set({ creating: null });
    },

    /**
     * A group's KB rides the FileNode push rail (ADR 0020); the company tier is
     * read when opened, so a change there is picked up on the next open. The
     * store ignores an account it does not hold, so every FileNode change can be
     * offered to it.
     */
    async applyChanges(accountId) {
      const tier = get().tiers.find((t) => t.accountId === accountId);
      // Only a group's KB rides the FileNode rail; the company tier is read when
      // opened, so it is not pushed (ADR 0020).
      if (tier?.scope !== "group") return;
      // The first change of a burst opens the window; the rest ride it.
      if (changeWindows.has(accountId)) return;
      changeWindows.set(
        accountId,
        setTimeout(() => {
          changeWindows.delete(accountId);
          void rereadTier(accountId);
        }, KNOWLEDGE_CHANGE_WINDOW_MS),
      );
    },

    async runSearch() {
      const term = get().search.trim();
      if (!term) {
        set({ results: [], searching: false, searchedTerm: "" });
        return;
      }
      const token = ++searchToken;
      set({ searching: true, searchedTerm: term });
      try {
        set({ error: null });
        // The engine arrives with the search that needs it -- this store is
        // reached from the boot shell, which applies its changes, and a reader
        // who never searches should not carry a search library to find that
        // out -- and it is asked for here so its fetch overlaps the reads below
        // rather than following them. The handler is attached at the request
        // itself, so a read that fails first cannot leave a rejected chunk
        // unhandled; what a failure means is settled at the run's own exit.
        let engineError: unknown = null;
        const engine = import("@orama/orama").catch((err: unknown) => {
          engineError = err;
          return null;
        });
        const index = new Map<
          string,
          { tier: KnowledgeTierState; summary: KnowledgeSummary }
        >();
        const pages: Array<{ tier: KnowledgeTierState; summary: KnowledgeSummary }> = [];
        for (const tier of get().tiers) {
          for (const summary of tier.articles) {
            // A topic folder groups articles; it is not a page to find.
            if (summary.kind === "folder") continue;
            pages.push({ tier, summary });
            index.set(articleKey(tier.accountId, summary.nodeId), { tier, summary });
          }
        }
        /*
         * A page not read before is one listing and one download, and the pages
         * are independent: they are read a bounded few at a time rather than one
         * after another, so a first search does not pay per page in series.
         */
        const docs = await mapLimit(
          pages,
          READ_CONCURRENCY,
          async ({ tier, summary }) => {
            const id = articleKey(tier.accountId, summary.nodeId);
            let text = searchText.get(id);
            if (text === undefined) {
              text = await textOf(tier, summary);
              searchText.set(id, text);
            }
            return {
              id,
              title: summary.title,
              text,
              tags: summary.tags.join(" "),
            };
          },
        );
        const orama = await engine;
        if (!orama) {
          // The engine is a chunk, and the one thing a search cannot run
          // without: a fetch that failed is a failure the reader can act on,
          // unlike a page whose text could not be read.
          if (token === searchToken)
            set({
              error: errorMessage(engineError),
              results: [],
              searching: false,
            });
          return;
        }
        const { create: createIndex, insertMultiple, search: searchIndex } = orama;
        // Rebuilt per search, on purpose: the container is disposable and a
        // cached index is a second store that can disagree with Stalwart. What
        // it indexes is the session's own read of each page's text, dropped
        // whenever the tree is re-listed, so a changed page is read again.
        const db = createIndex({
          schema: { title: "string", text: "string", tags: "string" },
        });
        await insertMultiple(db, docs);
        const found = await searchIndex(db, { term, limit: 50 });
        const results: KnowledgeStore["results"] = [];
        for (const hit of found.hits) {
          const entry = index.get(hit.id);
          if (!entry) continue;
          results.push({
            accountId: entry.tier.accountId,
            nodeId: entry.summary.nodeId,
            scope: entry.tier.scope,
            title: entry.summary.title,
            snippet: snippetOf(hit.document.text, term),
          });
        }
        if (token === searchToken) set({ results, searching: false });
      } catch {
        // A search that cannot run offers no results rather than a failure the
        // reader cannot act on; the box is not a load.
        if (token === searchToken) set({ results: [], searching: false });
      }
    },

    reset() {
      // Whatever is in flight was read under the session being left behind.
      loadEpoch += 1;
      loadPending = false;
      openToken += 1;
      searchToken += 1;
      for (const timer of changeWindows.values()) clearTimeout(timer);
      changeWindows.clear();
      set({
        tiers: [],
        loaded: false,
        loading: false,
        error: null,
        article: null,
        articleLoading: false,
        edit: null,
        search: "",
        searching: false,
        searchedTerm: "",
        showRetired: false,
        creating: null,
        results: [],
      });
    },
  };
});

// Signing out empties the store: the articles are the reader's mail account's
// Files, and the company KB is read through their session, so nothing here
// survives the session it was read under.
useSession.subscribe((s, prev) => {
  if (s.status !== prev.status && s.status !== "authenticated")
    useKnowledge.getState().reset();
});

/*
 * A group tier is a probed group mailbox, so the tiers are rebuilt when the
 * probe lands -- or when a membership changes and one appears or goes. The same
 * arrangement the chat store keeps: a `/kb` opened straight after a reload can
 * beat the probe, and without this the group tiers would stay missing until
 * something else happened to reload.
 */
useMail.subscribe((s, prev) => {
  if (s.mailAccounts === prev.mailAccounts) return;
  if (useSession.getState().status === "authenticated")
    void useKnowledge.getState().load();
});
