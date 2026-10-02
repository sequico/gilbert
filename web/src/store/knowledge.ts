/**
 * The knowledge base store (ADR 0024).
 *
 * One store serves both tiers — the company KB and each group's — because the
 * documents and the surface are the same and only the owning account differs.
 * The company tier is discovered through the server route that acts as the
 * Master; a group tier is the reader's own FileNode tree, read through their
 * session on the group's account. Writes go through the server route; reads go
 * straight to JMAP Files.
 *
 * The company lead is the scope that ships first, but nothing here is
 * company-shaped: `tiers` is an ordered list, the company tier first, then one
 * per probed group mailbox, the contact sidebar's own arrangement.
 *
 * Search is Orama in-process over the articles' `text`, rebuilt lazily per
 * search (ADR 0024 Q14), so the human box shares a corpus with the fleet's
 * lookup — which reads the same `text` without Orama — without a second service
 * and without a cached index to go stale.
 */

import {
  create as createIndex,
  insertMultiple,
  search as searchIndex,
} from "@orama/orama";
import { create } from "zustand";
import type { Id } from "@/jmap/types";
import {
  approveArticle,
  articleKey,
  companyKnowledge,
  createArticle,
  deleteArticle,
  findKnowledgeFolder,
  type KnowledgeArticleInput,
  type KnowledgeArticleView,
  type KnowledgeSummary,
  type KnowledgeTarget,
  listArticles,
  plainTextFromBlocks,
  readArticle,
  renameArticle,
  restoreArticle,
  saveDraft,
} from "@/lib/knowledge";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";

export interface KnowledgeTierState {
  scope: "company" | "group";
  accountId: Id;
  /** The group's own name (address) for a group tier, null for the company. */
  group: string | null;
  /** Whether the reader is an installation administrator (approval's gate). */
  canApprove: boolean;
  articles: KnowledgeSummary[];
}

/** The open article's unsaved edits, as the editor holds them. */
export interface KnowledgeEdit {
  title: string;
  tags: string[];
  blocks: unknown[];
  text: string;
  dirty: boolean;
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
  /** Show retired articles beside the standing ones, off by default. */
  showRetired: boolean;
  results: Array<{
    accountId: Id;
    nodeId: Id;
    scope: "company" | "group";
    title: string;
    snippet: string;
  }>;

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
  ): Promise<boolean>;
  save(): Promise<boolean>;
  approve(effectiveAt: string): Promise<boolean>;
  restore(revision: string): Promise<boolean>;
  rename(title: string): Promise<boolean>;
  remove(): Promise<boolean>;
  setSearch(term: string): void;
  setShowRetired(on: boolean): void;
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

export const useKnowledge = create<KnowledgeStore>((set, get) => {
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
   * read once through the same `readArticle` the surface opens it with. The
   * bound is the loaded tiers: nothing is discovered beyond them, so a search
   * never walks an account nobody asked for.
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
      const view = await readArticle(
        tier.accountId,
        summary.nodeId,
        summary.nodeId,
        summary.folder,
        tier.scope,
        summary.parentId,
      );
      return view?.draft?.text ?? "";
    } catch {
      return "";
    }
  }

  /** Re-open the article a write just changed, by the summary the route echoed. */
  async function reopen(accountId: Id, summary: KnowledgeSummary): Promise<void> {
    await get().open(accountId, summary.folder, summary.nodeId);
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
    showRetired: false,
    results: [],

    async load() {
      if (get().loading) {
        // A probe that lands mid-load is not dropped: the tiers are rebuilt
        // again once this one finishes, so a group discovered meanwhile appears.
        loadPending = true;
        return;
      }
      set({ loading: true, error: null });
      const canApprove = useSession.getState().session?.gilbert?.isAdmin === true;
      const tiers: KnowledgeTierState[] = [];

      /*
       * The company KB first, discovered through the route that acts as the
       * Master. A boot with no company folder yet — or a route that fails —
       * leaves the company tier out and still loads the group tiers; one tier's
       * failure never takes `load()` down with it.
       */
      try {
        const company = await companyKnowledge();
        if (company) {
          let articles: KnowledgeSummary[] = [];
          try {
            articles = await listArticles(
              company.accountId,
              company.folderId,
              get().showRetired,
            );
          } catch {
            articles = [];
          }
          tiers.push({
            scope: "company",
            accountId: company.accountId,
            group: null,
            canApprove,
            articles,
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
      for (const group of groupMailboxAccounts(useMail.getState().mailAccounts)) {
        let articles: KnowledgeSummary[] = [];
        try {
          const folderId = await findKnowledgeFolder(group.accountId);
          if (folderId)
            articles = await listArticles(group.accountId, folderId, get().showRetired);
        } catch {
          articles = [];
        }
        tiers.push({
          scope: "group",
          accountId: group.accountId,
          group: group.name,
          canApprove,
          articles,
        });
      }

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
      set({ articleLoading: true, article: null, edit: null });
      try {
        const tier = get().tiers.find((t) => t.accountId === accountId);
        const summary = tier?.articles.find((a) => a.nodeId === nodeId);
        const view = await readArticle(
          accountId,
          nodeId,
          nodeId,
          folder,
          tier?.scope ?? scopeOf(accountId),
          summary?.parentId,
        );
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
            dirty: false,
          },
          articleLoading: false,
        });
      } catch (err) {
        set({ articleLoading: false, error: (err as Error).message });
      }
    },

    close() {
      set({ article: null, articleLoading: false, edit: null });
    },

    setEdit(patch) {
      const edit = get().edit;
      if (!edit) return;
      const next: KnowledgeEdit = { ...edit, ...patch, dirty: true };
      // The editor's blocks are the source of truth for the body; the plain text
      // is derived from them so search and every reader see the same bytes.
      if (patch.blocks !== undefined) next.text = plainTextFromBlocks(patch.blocks);
      set({ edit: next });
    },

    async create(tier, title, parentFolder) {
      const target: KnowledgeTarget = {
        scope: tier.scope,
        ...(tier.group ? { group: tier.group } : {}),
      };
      try {
        await createArticle(target, title, parentFolder);
        await get().reload();
        return true;
      } catch (err) {
        set({ error: (err as Error).message });
        return false;
      }
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
      };
      try {
        // A save rewrites the document; only a rename moves the folder, so the
        // re-open follows the folder the article already has.
        const summary = await saveDraft(target, input);
        await reopen(article.accountId, summary);
        return true;
      } catch (err) {
        set({ error: (err as Error).message });
        return false;
      }
    },

    async approve(effectiveAt) {
      const { article } = get();
      if (!article) return false;
      const target = targetOf(article);
      if (!target) return false;
      try {
        const summary = await approveArticle(target, effectiveAt);
        await reopen(article.accountId, summary);
        return true;
      } catch (err) {
        set({ error: (err as Error).message });
        return false;
      }
    },

    async restore(revision) {
      const { article } = get();
      if (!article) return false;
      const target = targetOf(article);
      if (!target) return false;
      try {
        const summary = await restoreArticle(target, revision);
        await reopen(article.accountId, summary);
        return true;
      } catch (err) {
        set({ error: (err as Error).message });
        return false;
      }
    },

    async rename(title) {
      const { article } = get();
      if (!article) return false;
      const target = targetOf(article);
      if (!target) return false;
      try {
        const summary = await renameArticle(target, title);
        await reopen(article.accountId, summary);
        // The folder moved, and the sidebar still carries the old path; the
        // tiers are re-listed so a click sends the path the door resolves.
        await get().reload();
        return true;
      } catch (err) {
        set({ error: (err as Error).message });
        return false;
      }
    },

    async remove() {
      const { article } = get();
      if (!article) return false;
      const target = targetOf(article);
      if (!target) return false;
      try {
        await deleteArticle(target);
        set({ article: null, edit: null, articleLoading: false });
        await get().reload();
        return true;
      } catch (err) {
        set({ error: (err as Error).message });
        return false;
      }
    },

    setSearch(term) {
      set({ search: term });
    },

    setShowRetired(on) {
      set({ showRetired: on });
      void get().reload();
    },

    /**
     * A group's KB rides the FileNode push rail (ADR 0024); the company tier is
     * read when opened, so a change there is picked up on the next open. The
     * store ignores an account it does not hold, so every FileNode change can be
     * offered to it.
     */
    async applyChanges(accountId) {
      const tier = get().tiers.find((t) => t.accountId === accountId);
      if (!tier) return;
      try {
        const folderId =
          tier.scope === "company"
            ? ((await companyKnowledge())?.folderId ?? null)
            : await findKnowledgeFolder(accountId);
        if (!folderId) return;
        const articles = await listArticles(accountId, folderId, get().showRetired);
        set((s) => ({
          tiers: s.tiers.map((t) =>
            t.accountId === accountId && t.scope === tier.scope ? { ...t, articles } : t,
          ),
        }));
      } catch {
        /* a failed reconcile leaves the tree as it was; the next event retries */
      }
    },

    async runSearch() {
      const term = get().search.trim();
      if (!term) {
        set({ results: [], searching: false });
        return;
      }
      set({ searching: true });
      try {
        const docs: Array<{ id: string; title: string; text: string; tags: string }> = [];
        const index = new Map<
          string,
          { tier: KnowledgeTierState; summary: KnowledgeSummary }
        >();
        for (const tier of get().tiers) {
          for (const summary of tier.articles) {
            const key = articleKey(tier.accountId, summary.nodeId);
            docs.push({
              id: key,
              title: summary.title,
              text: await textOf(tier, summary),
              tags: summary.tags.join(" "),
            });
            index.set(key, { tier, summary });
          }
        }
        // Rebuilt per search, on purpose: the container is disposable and a
        // cached index is a second store that can disagree with Stalwart.
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
        set({ results, searching: false });
      } catch {
        // A search that cannot run offers no results rather than a failure the
        // reader cannot act on; the box is not a load.
        set({ results: [], searching: false });
      }
    },

    reset() {
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
        showRetired: false,
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
