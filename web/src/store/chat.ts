/**
 * Group chat store (ADR 0006).
 *
 * One conversation per group mailbox the session holds. Everything durable
 * lives in the group account's own Files: the `gilbert/chat` folder holds one
 * immutable JSON node per message, `gilbert/chat-state` holds the reader's own
 * marker. Membership is the grant -- nothing here is stored in the member's
 * account or shared out.
 *
 * The store is warm, not lazy: each chat account's transcript is loaded once
 * per session (like the group folder trees the mail probe loads) so the
 * launcher badge can show an honest unread count without the panel being
 * opened. New messages arrive over the FileNode state-change rail the App
 * dispatches into `applyChanges`.
 */
import { create } from "zustand";
import { client } from "@/jmap/client";
import type { ChangesResponse, FileNode, GetResponse, Id } from "@/jmap/types";
import { findInFolder, listChildrenWithState } from "@/lib/appFolder";
import {
  type ChatMessage,
  compareMessages,
  createDoc,
  ensureChatFolders,
  fetchMessage,
  isChatMarkerDoc,
  isChatMessageDoc,
  MAX_TEXT,
  MESSAGE_TYPE,
  markerNameFor,
  messageProps,
  readDoc,
  unreadCount,
  writeDoc,
} from "@/lib/chat";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { toast } from "@/ui/toast";

export interface ChatConversation {
  accountId: Id;
  name: string;
  /** The chat/chat-state folders once ensured; null until the first load. */
  folders: { chat: Id; state: Id } | null;
  /** Messages in transcript order (server creation order, see compareMessages). */
  nodes: ChatMessage[];
  /** The FileNode state the transcript was last synced from. */
  stateToken: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** The reader's own marker: the marker node id and the message it reads to. */
  marker: { id: Id | null; lastRead: Id | null } | null;
  /** Draft and reply target, kept per conversation while the panel is open. */
  draft: string;
  replyTo: Id | null;
  /** A send is in flight; the composer must not fire a second one. */
  sending: boolean;
}

interface ChatState {
  conversations: Record<Id, ChatConversation>;
  /** The conversation the panel is showing, if any. */
  openAccountId: Id | null;
  /** Reconcile the conversation set with the session's group mailboxes. */
  syncAccounts(): void;
  /** Load (or reload) a conversation: folders, transcript, marker. */
  ensureAccount(accountId: Id): Promise<void>;
  /** Open the panel on a conversation: load it, then read up to the newest. */
  open(accountId: Id): void;
  /** The reader's own address, which names their marker and their messages. */
  me(): string;
  setDraft(accountId: Id, text: string): void;
  setReply(accountId: Id, replyTo: Id | null): void;
  /** Send the conversation's draft, optionally as a reply. */
  send(accountId: Id): Promise<void>;
  /** A FileNode state change arrived for a chat account: fetch what is new. */
  applyChanges(accountId: Id): Promise<void>;
  /** Drop everything (sign-out). */
  reset(): void;
  /** Re-read a conversation from the server (error retry). */
  reload(accountId: Id): Promise<void>;
}

const empty = (accountId: Id, name: string): ChatConversation => ({
  accountId,
  name,
  folders: null,
  nodes: [],
  stateToken: null,
  loading: false,
  loaded: false,
  error: null,
  marker: null,
  draft: "",
  replyTo: null,
  sending: false,
});

function sortedInsert(nodes: ChatMessage[], m: ChatMessage): boolean {
  if (nodes.some((n) => n.id === m.id)) return false;
  const i = nodes.findIndex((n) => compareMessages(n, m) > 0);
  if (i < 0) nodes.push(m);
  else nodes.splice(i, 0, m);
  return true;
}

/** Marker writes coalesce and serialise per account, like the settings push. */
const markerTimers = new Map<Id, number>();
const markerPending = new Map<Id, Id | null>(); // accountId -> lastRead target
let markerChain: Promise<void> = Promise.resolve();
/** Transcript loads in flight, so open() can await the warm pass. */
const transcriptLoads = new Map<Id, Promise<void>>();

export const useChat = create<ChatState>((set, get) => {
  function startLoad(accountId: Id, name: string): Promise<void> {
    const running = transcriptLoads.get(accountId);
    if (running) return running;
    const load = (async () => {
      try {
        await loadTranscript(accountId, name);
      } finally {
        transcriptLoads.delete(accountId);
      }
    })();
    transcriptLoads.set(accountId, load);
    return load;
  }

  async function loadTranscript(accountId: Id, name: string): Promise<void> {
    const conv = get().conversations[accountId] ?? empty(accountId, name);
    set((s) => ({
      conversations: {
        ...s.conversations,
        [accountId]: { ...conv, loading: true, error: null },
      },
    }));
    try {
      const folders = conv.folders ?? (await ensureChatFolders(accountId));
      // One page of the newest thousand: v1 chat is a glance surface and the
      // ADR accepts unbounded append-only growth, so a transcript past that is
      // trimmed at the oldest end until chat gains paging.
      const { list, state: readState } = await listChildrenWithState(
        accountId,
        folders.chat,
        messageProps(),
      );
      const nodes: ChatMessage[] = [];
      for (const node of list) {
        if (node.nodeType !== "file" || !node.blobId) continue;
        try {
          const doc = await readDoc(accountId, node.blobId);
          if (!isChatMessageDoc(doc)) continue;
          nodes.push({ id: node.id, created: node.created ?? "", ...doc });
        } catch {
          /* a node that is not a readable message is not part of the transcript */
        }
      }
      nodes.sort(compareMessages);
      // The state the server reported with that read is the change anchor for
      // everything after it: `FileNode/changes` from here misses nothing the
      // transcript does not already have, and reports nothing twice.
      const stateToken = readState;
      set((s) => ({
        conversations: {
          ...s.conversations,
          [accountId]: {
            ...(s.conversations[accountId] ?? empty(accountId, name)),
            folders,
            nodes,
            stateToken,
            loading: false,
            loaded: true,
            error: null,
          },
        },
      }));
      // The badge must be honest without the panel being opened: read the
      // reader's own marker as part of the warm pass, so "unread = messages
      // newer than my marker" holds from sign-in and the first open does not
      // silently consume messages nobody was ever shown as unread.
      await readOwnMarker(accountId);
    } catch (err) {
      set((s) => ({
        conversations: {
          ...s.conversations,
          [accountId]: {
            ...(s.conversations[accountId] ?? empty(accountId, name)),
            loading: false,
            error: (err as Error).message,
          },
        },
      }));
    }
  }

  async function readOwnMarker(accountId: Id): Promise<void> {
    const conv = get().conversations[accountId];
    const folders = conv?.folders;
    const me = get().me();
    if (!conv || !folders || !me || conv.marker) return;
    const node = await findInFolder(accountId, folders.state, markerNameFor(me));
    if (!node?.blobId) return;
    try {
      const doc = await readDoc(accountId, node.blobId);
      if (!isChatMarkerDoc(doc)) return;
      set((s) => ({
        conversations: {
          ...s.conversations,
          [accountId]: {
            ...s.conversations[accountId]!,
            marker: { id: node.id, lastRead: doc.lastRead },
          },
        },
      }));
    } catch {
      /* an unreadable marker is treated as absent; the next open rewrites it */
    }
  }

  async function flushMarker(accountId: Id): Promise<void> {
    const target = markerPending.get(accountId);
    if (target === undefined) return;
    markerPending.delete(accountId);
    const conv = get().conversations[accountId];
    const folders = conv?.folders;
    const me = get().me();
    if (!conv || !folders || !me) return;
    if (conv.marker?.lastRead === target) return;
    try {
      const doc = { v: 1 as const, lastRead: target };
      const marker = conv.marker;
      let markerId = marker?.id ?? null;
      if (marker?.id) {
        // Rewrite the existing marker node's blob.
        const json = JSON.stringify(doc);
        const blob = new Blob([json], { type: MESSAGE_TYPE });
        const up = await client.upload(accountId, blob, { type: MESSAGE_TYPE });
        await client.call("FileNode/set", {
          accountId,
          update: {
            [marker.id]: { blobId: up.blobId, type: MESSAGE_TYPE, size: blob.size },
          },
        });
      } else {
        markerId = await writeDoc(accountId, folders.state, markerNameFor(me), doc);
      }
      set((s) => ({
        conversations: {
          ...s.conversations,
          [accountId]: {
            ...s.conversations[accountId]!,
            marker: { id: markerId, lastRead: target },
          },
        },
      }));
    } catch {
      /* a marker that fails to write only costs an unread badge, never a message */
    }
  }

  /** Queue a marker write at the newest message (coalesced and serialised). */
  function markAt(accountId: Id): void {
    const conv = get().conversations[accountId];
    if (!conv?.loaded) return;
    const newest = conv.nodes[conv.nodes.length - 1]?.id ?? null;
    markerPending.set(accountId, newest);
    const timer = markerTimers.get(accountId);
    if (timer !== undefined) window.clearTimeout(timer);
    markerTimers.set(
      accountId,
      window.setTimeout(() => {
        markerTimers.delete(accountId);
        markerChain = markerChain
          .then(() => flushMarker(accountId))
          .catch(() => undefined);
      }, 600),
    );
  }

  return {
    conversations: {},
    openAccountId: null,

    me() {
      return useSession.getState().session?.username ?? "";
    },

    syncAccounts() {
      const session = useSession.getState();
      if (session.status !== "authenticated") {
        get().reset();
        return;
      }
      const wanted = groupMailboxAccounts(useMail.getState().mailAccounts);
      const wantedIds = new Set(wanted.map((a) => a.accountId));
      const have = get().conversations;
      // Drop conversations the session lost (ADR: leaving removes access);
      // keep the open conversation only while it is still a group mailbox.
      const next: Record<Id, ChatConversation> = {};
      for (const a of wanted)
        next[a.accountId] = have[a.accountId] ?? empty(a.accountId, a.name);
      for (const id of Object.keys(have))
        if (!wantedIds.has(id)) transcriptLoads.delete(id);
      set({ conversations: next });
      if (get().openAccountId && !wantedIds.has(get().openAccountId!))
        set({ openAccountId: null });
      for (const a of wanted) {
        const conv = next[a.accountId]!;
        if (!conv.loaded && !conv.loading) void startLoad(a.accountId, a.name);
      }
    },

    async ensureAccount(accountId) {
      const conv = get().conversations[accountId];
      if (!conv) return;
      // Join the warm pass when it is still loading, so the first open does
      // not race it: the badge and the transcript are ready together.
      if (!conv.loaded) await startLoad(accountId, conv.name);
      if (!get().conversations[accountId]!.marker) await readOwnMarker(accountId);
    },

    open(accountId) {
      set({ openAccountId: accountId });
      void get()
        .ensureAccount(accountId)
        .then(() => {
          // The marker is born at first open, reading up to the newest message:
          // no marker ever means "everything is unread" (ADR 0006 kind rule).
          markAt(accountId);
        });
    },

    setDraft(accountId, text) {
      const conv = get().conversations[accountId];
      if (!conv) return;
      if (text.length > MAX_TEXT) return; // the input caps, but never trust it here
      set((s) => ({
        conversations: { ...s.conversations, [accountId]: { ...conv, draft: text } },
      }));
    },

    setReply(accountId, replyTo) {
      const conv = get().conversations[accountId];
      if (!conv) return;
      set((s) => ({
        conversations: { ...s.conversations, [accountId]: { ...conv, replyTo } },
      }));
    },

    async reload(accountId) {
      const conv = get().conversations[accountId];
      if (!conv) return;
      set((s) => ({
        conversations: {
          ...s.conversations,
          [accountId]: { ...conv, loaded: false, loading: false, error: null },
        },
      }));
      await startLoad(accountId, conv.name);
    },

    async send(accountId) {
      const conv = get().conversations[accountId];
      if (!conv || conv.sending) return;
      const text = conv.draft.trim();
      if (!text) return;
      set((s) => ({
        conversations: {
          ...s.conversations,
          [accountId]: { ...s.conversations[accountId]!, sending: true },
        },
      }));
      try {
        const folders = conv.folders ?? (await ensureChatFolders(accountId));
        const me = get().me();
        if (!me) return;
        const doc = {
          v: 1 as const,
          from: me,
          at: new Date().toISOString(),
          text: text.slice(0, MAX_TEXT),
          ...(conv.replyTo ? { replyTo: conv.replyTo } : {}),
        };
        const id = await createDoc(accountId, folders.chat, doc);
        const m = await fetchMessage(accountId, id, folders.chat);
        if (m) {
          const nodes = [...get().conversations[accountId]!.nodes];
          sortedInsert(nodes, m);
          set((s) => ({
            conversations: {
              ...s.conversations,
              [accountId]: { ...s.conversations[accountId]!, folders, nodes },
            },
          }));
        }
        set((s) => ({
          conversations: {
            ...s.conversations,
            [accountId]: {
              ...s.conversations[accountId]!,
              draft: "",
              replyTo: null,
            },
          },
        }));
        markAt(accountId);
      } catch (err) {
        toast.show(t("Message not sent — {what}", { what: (err as Error).message }));
      } finally {
        set((s) => {
          const c = s.conversations[accountId];
          return c
            ? {
                conversations: {
                  ...s.conversations,
                  [accountId]: { ...c, sending: false },
                },
              }
            : {};
        });
      }
    },

    async applyChanges(accountId) {
      const conv = get().conversations[accountId];
      if (!conv?.loaded || !conv.folders || conv.stateToken === null) return;
      try {
        let since = conv.stateToken;
        const created: Id[] = [];
        let hasMore = true;
        let guard = 0;
        while (hasMore && guard++ < 8) {
          const ch = await client.call<ChangesResponse>("FileNode/changes", {
            accountId,
            sinceState: since,
            maxChanges: 500,
          });
          created.push(...ch.created);
          since = ch.newState;
          hasMore = ch.hasMoreChanges;
        }
        if (hasMore) {
          // More pages than the guard allows: rather than advancing the token
          // past content we never fetched, reload the transcript wholesale --
          // cheap and self-healing.
          void get().reload(accountId);
          return;
        }
        const nodes = [...conv.nodes];
        const known = new Set(nodes.map((n) => n.id));
        const fresh = created.filter((id) => !known.has(id));
        let changed = false;
        if (fresh.length) {
          // One get for the batch, then a blob read per message document.
          const got = await client.call<GetResponse<FileNode>>("FileNode/get", {
            accountId,
            ids: fresh,
            properties: messageProps(),
          });
          for (const node of got.list) {
            if (node.nodeType !== "file" || !node.blobId) continue;
            if (node.parentId !== conv.folders.chat) continue;
            try {
              const doc = await readDoc(accountId, node.blobId);
              if (!isChatMessageDoc(doc)) continue;
              const m: ChatMessage = {
                id: node.id,
                created: node.created ?? "",
                ...doc,
              };
              changed = sortedInsert(nodes, m) || changed;
            } catch {
              /* not a readable message; skip */
            }
          }
        }
        if (changed || since !== conv.stateToken) {
          set((s) => ({
            conversations: {
              ...s.conversations,
              [accountId]: { ...s.conversations[accountId]!, nodes, stateToken: since },
            },
          }));
          if (changed && get().openAccountId === accountId) markAt(accountId);
        }
      } catch {
        /* the next event or the next open retries; a failed sync loses nothing */
      }
    },

    reset() {
      for (const timer of markerTimers.values()) window.clearTimeout(timer);
      markerTimers.clear();
      markerPending.clear();
      set({ conversations: {}, openAccountId: null });
    },
  };
});

// Keep the conversation set in step with the session's group mailboxes: a
// membership change (added later, or leaving) warms or drops conversations,
// and signing out empties the store. Cheap because mailAccounts only changes
// when the probed set actually changes.
useSession.subscribe((s, prev) => {
  if (s.status !== prev.status) useChat.getState().syncAccounts();
});
useMail.subscribe((s, prev) => {
  if (s.mailAccounts === prev.mailAccounts) return;
  if (useSession.getState().status === "authenticated") useChat.getState().syncAccounts();
});

/** Unread for a conversation, by the ADR kind rule (exported for selectors). */
export function unreadOf(conv: ChatConversation): number {
  return unreadCount(conv.nodes, conv.marker);
}
