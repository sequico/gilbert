/**
 * The chat panel (ADR 0006): a glance-and-reply conversation surface.
 *
 * Shown as a popover under the top-bar launcher on desktop and a full-screen
 * sheet on mobile. It holds the conversation switcher (one entry per group
 * mailbox), the thread as bubbles with quote replies, and the composer.
 * Everything here is a view over the chat store; the durable data lives in
 * the group accounts' own Files.
 */
import { CornerUpLeft, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { Id } from "@/jmap/types";
import { type ChatMessage, MAX_TEXT } from "@/lib/chat";
import { formatClock } from "@/lib/datetime";
import { t } from "@/lib/i18n";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { unreadOf, useChat } from "@/store/chat";
import { useSession } from "@/store/session";

interface ChatPanelProps {
  accounts: MailAccountInfo[];
  onClose: () => void;
}

/** The part of an address a chat reader recognises, like a display name. */
function shortName(address: string): string {
  const at = address.indexOf("@");
  return at > 0 ? address.slice(0, at) : address;
}

export function ChatPanel({ accounts, onClose }: ChatPanelProps) {
  const me = useSession((s) => s.session?.username ?? "");
  const conversations = useChat((s) => s.conversations);
  const openAccountId = useChat((s) => s.openAccountId);
  const open = openAccountId ? (conversations[openAccountId] ?? null) : null;
  const threadRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);

  const setDraft = useChat((s) => s.setDraft);
  const setReply = useChat((s) => s.setReply);
  const send = useChat((s) => s.send);
  const reload = useChat((s) => s.reload);
  const openConv = useChat((s) => s.open);

  // Stick to the newest message unless the reader has scrolled up.
  const onScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const nodeCount = open?.nodes.length ?? 0;
  useEffect(() => {
    const el = threadRef.current;
    if (el && (atBottom.current || open?.replyTo)) {
      el.scrollTop = el.scrollHeight;
      atBottom.current = true;
    }
  }, [nodeCount, openAccountId, open?.replyTo]);

  // Focus the composer when a conversation opens.
  useEffect(() => {
    if (openAccountId) inputRef.current?.focus();
  }, [openAccountId]);

  const byId = useMemo(() => {
    const m = new Map<Id, ChatMessage>();
    for (const n of open?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [open?.nodes]);

  if (!accounts.length) return null;

  const pickAccount = (id: Id) => {
    atBottom.current = true;
    openConv(id);
  };

  const jumpTo = (id: Id) => {
    listRef.current
      ?.querySelector(`[data-mid="${id}"]`)
      ?.scrollIntoView({ block: "center" });
  };

  const submit = () => {
    if (!openAccountId) return;
    void send(openAccountId);
    inputRef.current?.focus();
  };

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span className="chat-title">{t("Chat")}</span>
        <button className="icon-btn chat-close" aria-label={t("Close")} onClick={onClose}>
          <X size={16} />
        </button>
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
      <div className="chat-thread" ref={threadRef} onScroll={onScroll}>
        {open ? (
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
            open.nodes.map((m) => {
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
                        <span className="chat-quote-text">{reply.text}</span>
                      </button>
                    )}
                    <div className="chat-bubble-meta">
                      <span className="chat-sender">
                        {mine ? t("You") : shortName(m.from)}
                      </span>
                      <span className="chat-clock">{formatClock(new Date(m.at))}</span>
                      <button
                        type="button"
                        className="icon-btn xs chat-reply"
                        aria-label={t("Reply")}
                        title={t("Reply")}
                        onClick={() => setReply(open.accountId, m.id)}
                      >
                        <CornerUpLeft size={13} />
                      </button>
                    </div>
                    <div className="chat-text">{m.text}</div>
                  </div>
                </div>
              );
            })
          )
        ) : (
          <div className="chat-empty">{t("Pick a conversation")}</div>
        )}
      </div>
      {open && (
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
                onClick={() => setReply(open.accountId, null)}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <div className="chat-input-row">
            <textarea
              ref={inputRef}
              className="chat-input"
              rows={1}
              maxLength={MAX_TEXT}
              placeholder={t("Message {group}", { group: shortName(open.name) })}
              value={open.draft}
              onChange={(e) => {
                // Grow with the content up to a few lines, like a chat input
                // should; height is reset first so a shorter line shrinks.
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                setDraft(open.accountId, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
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
