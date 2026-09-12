/**
 * The chat panel (ADR 0005): a glance-and-reply conversation surface.
 *
 * Shown as a popover under the top-bar launcher on desktop and a full-screen
 * sheet on mobile. It holds the conversation switcher (one entry per group
 * mailbox), the thread as bubbles with quote replies and scroll-up paging
 * into older messages, a search over the selected group's messages, and the
 * composer. Everything here is a view over the chat store; the durable data
 * lives in the group accounts' own Files.
 */
import { Bot, CornerUpLeft, Search, Send, Smile, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Id } from "@/jmap/types";
import {
  type ChatMention,
  type ChatMessage,
  MAX_TEXT,
  mentionRegex,
  participantsOf,
  shortName,
} from "@/lib/chat";
import { COMMON_EMOJI, emojiAsset } from "@/lib/emoji";
import { formatListDate } from "@/lib/format";
import { plural, t } from "@/lib/i18n";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { agentViewKey, useAgents } from "@/store/agents";
import { unreadOf, useChat } from "@/store/chat";
import { useSession } from "@/store/session";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { GroupAgentPanel } from "./GroupAgentPanel";

interface ChatPanelProps {
  accounts: MailAccountInfo[];
  onClose: () => void;
}

/** One line of a message, for the search results list. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/**
 * Render a message's text with its known emoticons as bundled Twemoji
 * images (yellow, WhatsApp style) instead of the OS's glyphs; anything not
 * in the fixed set stays text, exactly as typed. Emoticon → image is display
 * only -- the message itself is plain text (ADR 0005).
 */
function EmojiText({ text }: { text: string }) {
  const parts = useMemo(() => {
    try {
      return [
        ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      ].map((s) => s.segment);
    } catch {
      return [text];
    }
  }, [text]);
  return (
    <>
      {parts.map((part, i) => {
        const src = emojiAsset(part);
        return src ? (
          <img key={i} className="chat-emoji-img" src={src} alt={part} loading="lazy" />
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

/** Message text with `@address` mentions highlighted; emoticons still render. */
function MentionedText({
  text,
  mentions,
  me,
}: {
  text: string;
  mentions?: ChatMention[];
  me: string;
}) {
  const addrs = mentions?.map((m) => m.id) ?? [];
  if (!addrs.length) return <EmojiText text={text} />;
  const re = mentionRegex(addrs);
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className={`chat-mention${p === me ? " me" : ""}`} title={p}>
            @{shortName(p)}
          </span>
        ) : (
          <EmojiText key={i} text={p} />
        ),
      )}
    </>
  );
}

export function ChatPanel({ accounts, onClose }: ChatPanelProps) {
  const me = useSession((s) => s.session?.username ?? "");
  const conversations = useChat((s) => s.conversations);
  const openAccountId = useChat((s) => s.openAccountId);
  const open = openAccountId ? (conversations[openAccountId] ?? null) : null;
  /*
   * The group's own agent documents (ADR 0003), read through the agents store's
   * member door. The chat is open to every member, so the read a member's
   * session can actually make is the one this panel uses: the admin route needs
   * Stalwart administration, and a member who is not one would read nothing.
   * The store keeps one entry per group, keyed by the group's lower-cased
   * address — the form the server stores a group's name in.
   */
  const memberViews = useAgents((s) => s.memberViews);
  const loadMemberView = useAgents((s) => s.loadMemberView);
  const groupName = open?.name ?? null;
  const agentView = groupName ? memberViews[agentViewKey(groupName)] : undefined;
  const [agentOpen, setAgentOpen] = useState(false);

  // Loaded with the conversation rather than with the panel: the `@` picker
  // owes the agent's address as soon as the composer is on screen, whether or
  // not anyone has opened the panel (ADR 0003 resolution 11).
  useEffect(() => {
    if (groupName) void loadMemberView(groupName);
  }, [groupName, loadMemberView]);

  const agentAddress = agentView?.granted ? agentView.agentAddress : null;
  /*
   * Who the `@` picker offers. The client knows only the participants it has
   * seen in the transcript, so a freshly granted agent that has never posted
   * cannot be mentioned at all; the group's own agent association is the
   * picker's second source, and the agent is offered exactly when it is
   * granted — membership is presence.
   */
  const mentionables = useMemo(() => {
    const seen = open ? participantsOf(open.nodes, me) : [];
    if (!agentAddress?.trim() || seen.includes(agentAddress)) return seen;
    return [...seen, agentAddress];
  }, [open, me, agentAddress]);
  const threadRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const chatInputRef = useRef<ChatInputHandle>(null);
  /** Where the viewport was pinned before older messages were prepended. */
  const pinTop = useRef<number | null>(null);
  const searchingRef = useRef(false);

  const setDraft = useChat((s) => s.setDraft);
  const setReply = useChat((s) => s.setReply);
  const send = useChat((s) => s.send);
  const reload = useChat((s) => s.reload);
  const loadOlder = useChat((s) => s.loadOlder);
  const openConv = useChat((s) => s.open);

  // ----- transcript paging on scroll-up -----
  const nodeCount = open?.nodes.length ?? 0;
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    // Paging up: keep the viewport on the same message while older ones are
    // prepended above it. Without this the added height shoves the reader
    // downwards with every page.
    if (pinTop.current !== null) {
      el.scrollTop += el.scrollHeight - pinTop.current;
      pinTop.current = null;
    }
    // Stick to the newest message unless the reader has scrolled up or is
    // mid-page. `open?.replyTo` (a reply was just composed) pins to bottom.
    if (atBottom.current || open?.replyTo) {
      el.scrollTop = el.scrollHeight;
      atBottom.current = true;
    }
  }, [nodeCount, openAccountId, open?.replyTo]);

  const older = async () => {
    if (!openAccountId || searchingRef.current) return;
    const conv = useChat.getState().conversations[openAccountId];
    if (!conv?.loaded || conv.pagingMore || conv.reachedStart) return;
    const el = threadRef.current;
    if (el) pinTop.current = el.scrollHeight;
    await loadOlder(openAccountId);
  };

  const onScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    // Reaching the top of the loaded window asks for the older page.
    if (el.scrollTop < 24) void older();
  };

  // ----- search across the selected group's messages -----
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChatMessage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    setQuery("");
    setResults(null);
    setSearching(false);
    setEmojiOpen(false);
    // A different group has a different agent: the panel is not carried over.
    setAgentOpen(false);
  }, [openAccountId]);

  useEffect(() => {
    if (!searchOpen || !openAccountId) {
      setResults(null);
      return;
    }
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    const token = ++seq.current;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void (async () => {
        // The search covers the whole history, so pull every older page in
        // first (they are only fetched on demand). A cap keeps a runaway
        // transcript from spinning forever on one query.
        let guard = 0;
        let conv = useChat.getState().conversations[openAccountId];
        while (conv?.loaded && !conv.reachedStart && guard++ < 500) {
          await loadOlder(openAccountId);
          conv = useChat.getState().conversations[openAccountId];
        }
        if (token !== seq.current) return;
        const all = useChat.getState().conversations[openAccountId]?.nodes ?? [];
        const hits = all.filter((m) => m.text.toLowerCase().includes(q)).slice(0, 200);
        if (token !== seq.current) return;
        setResults(hits);
        setSearching(false);
      })();
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [searchOpen, query, openAccountId, loadOlder]);

  const exitSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setResults(null);
  };

  const jumpTo = (id: Id) => {
    threadRef.current
      ?.querySelector(`[data-mid="${id}"]`)
      ?.scrollIntoView({ block: "center" });
  };

  // Focus the composer when a conversation opens. The editor lives in a
  // popover that starts `visibility: hidden` until it has been positioned,
  // and focusing a hidden element is a silent no-op, so retry on the next
  // animation frames until the composer actually holds the focus.
  useEffect(() => {
    if (!openAccountId || searchOpen) return;
    let raf = 0;
    const tick = () => {
      const input = chatInputRef.current;
      if (input) {
        input.focus();
        if (input.isFocused()) return;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [openAccountId, searchOpen, open?.loading]);

  const byId = useMemo(() => {
    const m = new Map<Id, ChatMessage>();
    for (const n of open?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [open?.nodes]);

  // ----- emoji picker -----
  const [emojiOpen, setEmojiOpen] = useState(false);

  if (!accounts.length) return null;

  const pickAccount = (id: Id) => {
    atBottom.current = true;
    openConv(id);
  };

  const submit = () => {
    if (!openAccountId) return;
    void send(openAccountId);
    chatInputRef.current?.focus();
  };

  const showHistoryNote =
    !!open &&
    open.loaded &&
    open.reachedStart &&
    !open.pagingMore &&
    open.nodes.length >= 200;

  return (
    <div className="chat-panel">
      <div className="chat-head">
        {/* Name the active conversation even when there is only one team:
            with a single group there is no switcher, and an unnamed "Chat"
            header would not say whose chat it is. */}
        <span className="chat-title" title={open?.name}>
          {open ? (
            <span className="notranslate" translate="no">
              {open.name}
            </span>
          ) : (
            t("Chat")
          )}
        </span>
        <span className="chat-head-actions">
          {open && (
            <button
              type="button"
              className={`icon-btn xs ${agentOpen ? "active" : ""}`}
              aria-label={t("The group's agent")}
              title={t("The group's agent")}
              aria-expanded={agentOpen}
              onClick={() => {
                setSearchOpen(false);
                setAgentOpen((v) => !v);
              }}
            >
              <Bot size={15} />
            </button>
          )}
          {open && (
            <button
              type="button"
              className={`icon-btn xs ${searchOpen ? "active" : ""}`}
              aria-label={t("Search messages")}
              title={t("Search messages")}
              onClick={() => {
                setAgentOpen(false);
                setSearchOpen((v) => !v);
              }}
            >
              <Search size={15} />
            </button>
          )}
          <button
            className="icon-btn chat-close"
            aria-label={t("Close")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </span>
      </div>
      {accounts.length > 1 && (
        <div className="chat-switcher" role="tablist" aria-label={t("Conversations")}>
          {accounts.map((a) => {
            const conv = conversations[a.accountId];
            const unread = conv ? unreadOf(conv) : 0;
            return (
              <button
                key={a.accountId}
                role="tab"
                aria-selected={a.accountId === openAccountId}
                className={`chat-switch ${a.accountId === openAccountId ? "active" : ""}`}
                onClick={() => pickAccount(a.accountId)}
              >
                <span className="chat-switch-name">{a.name}</span>
                {unread > 0 && <span className="chat-badge">{unread}</span>}
              </button>
            );
          })}
        </div>
      )}
      {searchOpen && (
        <div className="chat-search-row">
          <input
            className="chat-search-input"
            autoFocus
            value={query}
            placeholder={t("Search in this chat")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") exitSearch();
            }}
          />
          <button
            type="button"
            className="icon-btn xs"
            aria-label={t("Close")}
            onClick={exitSearch}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="chat-thread" ref={threadRef} onScroll={onScroll}>
        {searchOpen ? (
          query.trim().length >= 2 ? (
            searching ? (
              <div className="chat-empty">{t("Searching…")}</div>
            ) : results && results.length > 0 ? (
              <>
                <div className="chat-search-summary">
                  {plural(results.length, {
                    one: "{n} match",
                    other: "{n} matches",
                  })}
                </div>
                {results.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="chat-result-row"
                    onClick={() => {
                      exitSearch();
                      window.setTimeout(() => jumpTo(m.id), 0);
                    }}
                  >
                    <span className="chat-result-meta">
                      <span className="chat-result-who">
                        {m.from === me ? t("You") : shortName(m.from)}
                      </span>
                      <span className="chat-result-date">{formatListDate(m.at)}</span>
                    </span>
                    <span className="chat-result-text">{snippet(m.text)}</span>
                  </button>
                ))}
              </>
            ) : (
              <div className="chat-empty">
                {t("No matches for {query}", { query: query.trim() })}
              </div>
            )
          ) : (
            <div className="chat-empty">{t("Search messages")}</div>
          )
        ) : agentOpen && open ? (
          <GroupAgentPanel name={open.name} onClose={() => setAgentOpen(false)} />
        ) : open ? (
          open.loading && open.nodes.length === 0 ? (
            <div className="chat-empty">{t("Loading…")}</div>
          ) : open.error && !open.loaded ? (
            <div className="chat-empty">
              <div>{t("Could not load the conversation")}</div>
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => void reload(open.accountId)}
              >
                {t("Retry")}
              </button>
            </div>
          ) : open.nodes.length === 0 ? (
            <div className="chat-empty">{t("No messages yet")}</div>
          ) : (
            <>
              {open.pagingMore && (
                <div className="chat-empty chat-older">
                  {t("Loading earlier messages…")}
                </div>
              )}
              {!open.pagingMore && showHistoryNote && (
                <div className="chat-empty chat-older">
                  {t("Start of the conversation")}
                </div>
              )}
              {open.nodes.map((m) => {
                const mine = m.from === me;
                const reply = m.replyTo ? byId.get(m.replyTo) : undefined;
                return (
                  <div
                    key={m.id}
                    data-mid={m.id}
                    className={`chat-row ${mine ? "mine" : ""}`}
                  >
                    <div className="chat-bubble">
                      {reply && (
                        <button
                          type="button"
                          className="chat-quote"
                          onClick={() => jumpTo(m.replyTo!)}
                          title={t("Go to the message being answered")}
                        >
                          <span className="chat-quote-name">
                            {reply.from === me ? t("You") : shortName(reply.from)}
                          </span>
                          <span className="chat-quote-text">
                            <MentionedText
                              text={reply.text}
                              mentions={reply.mentions}
                              me={me}
                            />
                          </span>
                        </button>
                      )}
                      <div className="chat-bubble-meta">
                        <span className="chat-sender">
                          {mine ? t("You") : shortName(m.from)}
                        </span>
                        <span className="chat-clock">{formatListDate(m.at)}</span>
                        <button
                          type="button"
                          className="icon-btn xs chat-reply"
                          aria-label={t("Reply")}
                          title={t("Reply")}
                          // A mouse reply must not lift the caret out of the
                          // composer (same pattern as the mention menu); when
                          // the editor had no focus, hand it back so typing
                          // starts at once.
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setReply(open.accountId, m.id);
                            chatInputRef.current?.focus();
                          }}
                        >
                          <CornerUpLeft size={13} />
                        </button>
                      </div>
                      <div className="chat-text">
                        <MentionedText text={m.text} mentions={m.mentions} me={me} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )
        ) : (
          <div className="chat-empty">{t("Pick a conversation")}</div>
        )}
      </div>
      {open && !searchOpen && !agentOpen && (
        <div className="chat-composer">
          {open.replyTo && (
            <div className="chat-replybar">
              <span className="chat-replybar-label">
                {(() => {
                  const target = byId.get(open.replyTo!);
                  return target
                    ? t("Replying to {who}", {
                        who: target.from === me ? t("You") : shortName(target.from),
                      })
                    : t("Reply");
                })()}
              </span>
              <button
                type="button"
                className="icon-btn xs"
                aria-label={t("Cancel reply")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setReply(open.accountId, null);
                  chatInputRef.current?.focus();
                }}
              >
                <X size={13} />
              </button>
            </div>
          )}
          {emojiOpen && (
            <div className="chat-emoji-grid" role="listbox" aria-label={t("Emoji")}>
              {COMMON_EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="chat-emoji-cell"
                  role="option"
                  title={e}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    chatInputRef.current?.insertEmoji(e);
                    setEmojiOpen(false);
                  }}
                >
                  <img src={emojiAsset(e)!} alt={e} loading="lazy" />
                </button>
              ))}
            </div>
          )}
          <div className="chat-input-row">
            <button
              type="button"
              className={`icon-btn chat-emoji-btn ${emojiOpen ? "active" : ""}`}
              aria-label={t("Emoji")}
              title={t("Emoji")}
              aria-expanded={emojiOpen}
              // Toggling the picker never takes the caret out of the
              // composer; closing it hands the focus back when it had
              // gone elsewhere.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const next = !emojiOpen;
                setEmojiOpen(next);
                if (!next) chatInputRef.current?.focus();
              }}
            >
              <Smile size={18} />
            </button>
            <ChatInput
              ref={chatInputRef}
              value={open.draft}
              maxLength={MAX_TEXT}
              mentionables={mentionables}
              placeholder={t("Message {group}", { group: shortName(open.name) })}
              onChange={(text) => setDraft(open.accountId, text)}
              onSend={submit}
            />
            <button
              type="button"
              className="btn btn-primary chat-send"
              aria-label={t("Send")}
              disabled={!open.draft.trim()}
              onClick={submit}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
