/**
 * Group chat store (ADR 0005).
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

import { appDocumentJson } from "@gilbert/shared/appDocument";
import { APP_DOCUMENT_TYPE } from "@gilbert/shared/appFolder";
import { create } from "zustand";
import { client } from "@/jmap/client";
import type { ChangesResponse, FileNode, GetResponse, Id } from "@/jmap/types";
import { findInFolder, listChildrenWithState } from "@/lib/appFolder";
import {
  CHAT_PAGE,
  type ChatMessage,
  compareMessages,
  createDoc,
  ensureChatFolders,
  fetchMessage,
  isChatMarkerDoc,
  MAX_TEXT,
  markerNameFor,
  mentionablesOf,
  mentionsFromText,
  messageDoc,
  messageProps,
  parseMessages,
  participantsOf,
  readDoc,
  unreadCount,
  writeDoc,
} from "@/lib/chat";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { playNewMailSound, showNotification } from "@/lib/notify";
import { agentViewKey, useAgents } from "@/store/agents";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
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
  /** Transcript paging: the server position of the oldest held message. */
  earliestPos: number;
  /** A page of older messages is being fetched (scroll-up). */
  pagingMore: boolean;
  /** The whole transcript is in hand: position 0 was reached. */
  reachedStart: boolean;
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
  /**
   * The panel no longer shows a conversation. Setting the open one back to none
   * is what stops an arrival being marked read behind a **closed** panel: the
   * badge and the notification are the signal while nothing is on screen.
   */
  close(): void;
  /** The reader's own address, which names their marker and their messages. */
  me(): string;
  setDraft(accountId: Id, text: string): void;
  setReply(accountId: Id, replyTo: Id | null): void;
  /** Send the conversation's draft, optionally as a reply. */
  send(accountId: Id): Promise<void>;
  /** A FileNode state change arrived for a chat account: fetch what is new. */
  applyChanges(accountId: Id, signal?: AbortSignal): Promise<void>;
  /** Drop everything (sign-out). */
  reset(): void;
  /** Re-read a conversation from the server (error retry). */
  reload(accountId: Id): Promise<void>;
  /** Fetch the page of messages older than the ones held (scroll-up). */
  loadOlder(accountId: Id): Promise<void>;
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
  earliestPos: 0,
  pagingMore: false,
  reachedStart: false,
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

/*
 * The re-syncs in flight, one per account.
 *
 * A live FileNode push, the reconnect catch-up and the two-minute poll can all
 * call `applyChanges` for the same account off the same unadvanced state. Two
 * passes would read the same `created` set and announce the same message
 * twice -- the tag collapses the visual, but the sound would play twice. A
 * skipped pass loses nothing: the state is only advanced by the pass that
 * runs, so the next event reads what this one did not.
 */
const chatSyncs = new Set<Id>();

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
      // Page the transcript from the tail: the newest messages first, older
      // ones fetched on scroll-up (loadOlder). The chat opens at the bottom;
      // a member added later scrolls back through the whole conversation.
      const first = await fetchPage(accountId, folders, 0, 0);
      const total = first.total;
      const from = Math.max(0, total - CHAT_PAGE);
      const page = await fetchPage(accountId, folders, from, total - from || CHAT_PAGE);
      const nodes = page.nodes.sort(compareMessages);
      set((s) => ({
        conversations: {
          ...s.conversations,
          [accountId]: {
            ...(s.conversations[accountId] ?? empty(accountId, name)),
            folders,
            nodes,
            stateToken: page.state,
            earliestPos: from,
            reachedStart: from === 0,
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

  /** One position window of the transcript, as ordered server-side. */
  async function fetchPage(
    accountId: Id,
    folders: { chat: Id },
    position: number,
    limit: number,
  ): Promise<{ nodes: ChatMessage[]; state: string; total: number }> {
    const {
      list,
      state: readState,
      total,
    } = await listChildrenWithState(accountId, folders.chat, messageProps(), {
      position,
      limit,
    });
    /*
     * The population the query matched, which is what the paging arithmetic
     * needs. A server that reports no `total` leaves it unknown, and the honest
     * substitute is what this page actually holds -- the transcript is then
     * walked one page at a time from where the read got to, rather than the
     * caller being handed a number that claims to be a population and is a page
     * size. That distinction is why `listChildrenWithState` no longer fills it
     * in itself.
     */
    return {
      nodes: await parseMessages(accountId, list),
      state: readState,
      total: total ?? list.length,
    };
  }

  async function loadOlderImpl(accountId: Id): Promise<void> {
    const conv = get().conversations[accountId];
    if (!conv?.loaded || conv.pagingMore || conv.reachedStart) return;
    if (conv.earliestPos <= 0) {
      set((s) => ({
        conversations: {
          ...s.conversations,
          [accountId]: { ...s.conversations[accountId]!, reachedStart: true },
        },
      }));
      return;
    }
    set((s) => ({
      conversations: {
        ...s.conversations,
        [accountId]: { ...s.conversations[accountId]!, pagingMore: true },
      },
    }));
    try {
      const folders = conv.folders!;
      const from = Math.max(0, conv.earliestPos - CHAT_PAGE);
      const page = await fetchPage(accountId, folders, from, conv.earliestPos - from);
      const byId = new Set(conv.nodes.map((n) => n.id));
      const extra = page.nodes.filter((n) => !byId.has(n.id));
      const nodes = [...extra, ...conv.nodes].sort(compareMessages);
      set((s) => ({
        conversations: {
          ...s.conversations,
          [accountId]: {
            ...s.conversations[accountId]!,
            nodes,
            earliestPos: from,
            reachedStart: from === 0,
            pagingMore: false,
          },
        },
      }));
    } catch {
      set((s) => ({
        conversations: {
          ...s.conversations,
          [accountId]: { ...s.conversations[accountId]!, pagingMore: false },
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
        const json = appDocumentJson(doc);
        const blob = new Blob([json], { type: APP_DOCUMENT_TYPE });
        const up = await client.upload(accountId, blob, { type: APP_DOCUMENT_TYPE });
        await client.call("FileNode/set", {
          accountId,
          update: {
            [marker.id]: { blobId: up.blobId, type: APP_DOCUMENT_TYPE, size: blob.size },
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
          // no marker ever means "everything is unread" (ADR 0005 kind rule).
          markAt(accountId);
        });
    },

    close() {
      set({ openAccountId: null });
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

    async loadOlder(accountId) {
      await loadOlderImpl(accountId);
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
        const body = text.slice(0, MAX_TEXT);
        /* The group's agent is a participant before it has ever posted (ADR
           0003 resolution 11): the picker offers it, so a mention of it has to
           reach the document too — otherwise the mention lives in the text and
           in nothing else. It is offered exactly when the group's view says it
           is granted, which is the picker's own rule; a view this panel has not
           loaded leaves the mention unnamed, which the transcript still
           delivers. The member door is the one read here: the chat is every
           member's, and a member's session cannot open the admin route. */
        const agentView = useAgents.getState().memberViews[agentViewKey(conv.name)];
        const agent = agentView?.granted ? agentView.agentAddress : null;
        /* The same list the picker offered (ADR 0005): the roster when one was
           read, the transcript otherwise, so a mention the writer could pick
           is a mention the document records. */
        const participants = mentionablesOf(
          participantsOf(conv.nodes, me),
          useAgents.getState().groupMembers[agentViewKey(conv.name)] ?? null,
          [me, agent ?? ""],
        );
        const doc = messageDoc(
          me,
          body,
          conv.replyTo ?? undefined,
          mentionsFromText(body, participants),
        );
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

    async applyChanges(accountId, signal) {
      const conv = get().conversations[accountId];
      if (!conv?.loaded || !conv.folders || conv.stateToken === null) return;
      if (signal?.aborted) return;
      if (chatSyncs.has(accountId)) return;
      chatSyncs.add(accountId);
      const chatFolder = conv.folders.chat;
      try {
        let since = conv.stateToken;
        const created: Id[] = [];
        const destroyed = new Set<Id>();
        const updated = new Set<Id>();
        let hasMore = true;
        let guard = 0;
        while (hasMore && guard++ < 8) {
          const ch = await client.call<ChangesResponse>(
            "FileNode/changes",
            {
              accountId,
              sinceState: since,
              maxChanges: 500,
            },
            [],
            signal,
          );
          created.push(...ch.created);
          for (const id of ch.destroyed) destroyed.add(id);
          for (const id of ch.updated) updated.add(id);
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
        const nodes = conv.nodes.filter((n) => !destroyed.has(n.id));
        let changed = nodes.length !== conv.nodes.length;
        /*
         * A marker or a reply target names a node by id, and a node that has
         * been destroyed -- the retirement path ADR 0005 names, an
         * administrator clearing the chat folders through Files -- leaves
         * both pointing at nothing: the marker falls into `unreadCount`'s
         * `at < 0` branch and reads as nothing unread, and a reply would name
         * a message nobody can open.
         */
        const markerGone =
          conv.marker !== null &&
          ((conv.marker.id !== null && destroyed.has(conv.marker.id)) ||
            (conv.marker.lastRead !== null && destroyed.has(conv.marker.lastRead)));
        const replyGone = conv.replyTo !== null && destroyed.has(conv.replyTo);
        /*
         * A message document is otherwise immutable, so an updated node we
         * hold in the transcript has changed under us and the copy on screen
         * is stale.
         */
        const copyStale = conv.nodes.some((n) => updated.has(n.id));
        const stale = markerGone || replyGone || copyStale;
        const known = new Set(nodes.map((n) => n.id));
        const fresh = created.filter((id) => !known.has(id));
        const arrived: ChatMessage[] = [];
        if (fresh.length) {
          // One get for the batch, then the shared parser keeps only the
          // nodes that actually live in this conversation's chat folder.
          const got = await client.call<GetResponse<FileNode>>(
            "FileNode/get",
            {
              accountId,
              ids: fresh,
              properties: messageProps(),
            },
            [],
            signal,
          );
          const onlyHere = got.list.filter((n) => n.parentId === chatFolder);
          for (const m of await parseMessages(accountId, onlyHere))
            if (sortedInsert(nodes, m)) arrived.push(m);
          changed = changed || arrived.length > 0;
        }
        if (changed || since !== conv.stateToken || stale) {
          set((s) => {
            const c = s.conversations[accountId];
            if (!c) return {};
            return {
              conversations: {
                ...s.conversations,
                [accountId]: {
                  ...c,
                  nodes,
                  stateToken: since,
                  ...(markerGone ? { marker: null } : {}),
                  ...(replyGone ? { replyTo: null } : {}),
                },
              },
            };
          });
          if (changed && get().openAccountId === accountId) markAt(accountId);
        }
        if (arrived.length) notifyNewChat(conv.name, accountId, arrived, get().me());
        // What names a destroyed node is not patched but re-read from the
        // server, which re-derives the marker from what is left.
        if (stale) void get().reload(accountId);
      } catch {
        /* the next event or the next open retries; a failed sync loses nothing */
      } finally {
        chatSyncs.delete(accountId);
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

/** How much of a message a system notification carries before it truncates. */
const CHAT_BODY_MAX = 180;

/**
 * Tell the reader a chat message arrived, the way mail already does.
 *
 * The sound and the system notification are the two switches mail honours, and
 * both are device-local. `showNotification` already stays silent while a
 * focused, visible window of this app is on screen, so a reader looking at
 * Gilbert is not interrupted -- the launcher badge and the transcript are the
 * in-app signal there. A message the reader wrote is never announced: a phone
 * that has just sent one is the ordinary case, and its own write wakes it too.
 * The click asks the launcher to open that conversation, which is the only
 * surface that has one.
 */
export function notifyNewChat(
  groupName: string,
  accountId: Id,
  arrived: ChatMessage[],
  me: string,
): void {
  /*
   * Without the reader's own address ownership cannot be told, and announcing
   * their own message as somebody else's is worse than saying nothing. The
   * session always has one by the time a change is routed here; this is the
   * fail-closed side of that race.
   */
  if (!me) return;
  const fromOthers = arrived.filter((m) => m.from && m.from !== me);
  if (!fromOthers.length) return;
  const s = useSettings.getState().settings;
  if (s.notificationSound) playNewMailSound();
  if (!s.desktopNotifications) return;
  for (const m of fromOthers.slice(0, 3)) {
    showNotification(groupName, {
      body: `${m.from}: ${m.text}`.slice(0, CHAT_BODY_MAX).trim(),
      tag: `gilbert-chat-${m.id}`,
      onClick: () => {
        window.dispatchEvent(new CustomEvent("gilbert:open-chat", { detail: accountId }));
      },
    });
  }
}

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
  // `conv.nodes` is a page, not always the whole transcript (`CHAT_PAGE`
  // below) — `fromStart` must say so, or a marker sitting outside the loaded
  // page reads as "everything held is read" instead of "everything held is
  // unread", and a member away longer than one page is told there is nothing
  // to catch up on.
  return unreadCount(conv.nodes, conv.marker, conv.reachedStart);
}
