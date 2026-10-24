/**
 * The chat panel (ADR 0004): a glance-and-reply conversation surface.
 *
 * Shown as a popover under the top-bar launcher on desktop and a sheet in the
 * content area on mobile. It holds the conversation switcher (one entry per group
 * mailbox), the thread as bubbles with quote replies and scroll-up paging
 * into older messages, a search over the selected group's messages, and the
 * composer. Everything here is a view over the chat store; the durable data
 * lives in the group accounts' own Files.
 */

import { type OpenQuestion, openQuestionsOf } from "@gilbert/shared/run";
import {
  CircleHelp,
  Clock,
  CornerUpLeft,
  Link2,
  ListChecks,
  Search,
  Send,
  Smile,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { push } from "@/jmap/push";
import type { Id } from "@/jmap/types";
import type { FactView } from "@/lib/agentAdmin";
import { fetchGroupAgent, fetchGroupRuns, onAgentSwitch } from "@/lib/agentAdmin";
import { REF_LABEL, refHref } from "@/lib/agentRefs";
import {
  CHAT_MAX_TEXT,
  CHAT_TAIL,
  type ChatMention,
  type ChatMessage,
  type ChatRef,
  localPart,
  mentionablesOf,
  mentionFormRegex,
  participantsOf,
} from "@/lib/chat";
import { COMMON_EMOJI, emojiAsset, graphemes } from "@/lib/emoji";
import { formatListDate } from "@/lib/format";
import { plural, t } from "@/lib/i18n";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { unreadOf, useChat } from "@/store/chat";
import { useSession } from "@/store/session";
import { GroupRuns, StopRun } from "@/views/admin/agents/GroupRuns";
import { ChatInput, type ChatInputHandle } from "./ChatInput";

interface ChatPanelProps {
  accounts: MailAccountInfo[];
  onClose: () => void;
}

/** The facts a run recalled, for a surface that does not list the memory. */
const NO_FACTS: readonly FactView[] = [];

/** One line of a message, for the search results list. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/**
 * Render a message's text with its known emoticons as bundled Twemoji
 * images (yellow, WhatsApp style) instead of the OS's glyphs; anything not
 * in the fixed set stays text, exactly as typed. Emoticon → image is display
 * only -- the message itself is plain text (ADR 0004).
 */
function EmojiText({ text }: { text: string }) {
  const parts = useMemo(() => graphemes(text), [text]);
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

/**
 * Message text with `@address` mentions highlighted; emoticons still render.
 *
 * A mention of somebody the roster no longer lists is greyed rather than
 * dropped: the words are what was written and stay readable, and the style
 * says that the person it names is no longer here. With no roster — a group
 * whose members nobody could read — every mention renders as it always has,
 * because a grey here would be a claim about the group that nobody checked.
 */
function MentionedText({
  text,
  mentions,
  me,
  members,
}: {
  text: string;
  mentions?: ChatMention[];
  me: string;
  /** The group's members, or null when no roster could be read. */
  members: string[] | null;
}) {
  const addrs = mentions?.map((m) => m.id) ?? [];
  if (!addrs.length) return <EmojiText text={text} />;
  const re = mentionFormRegex(addrs);
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 !== 1) return <EmojiText key={i} text={p} />;
        /*
         * The match is the full address (the client's form) or the local part
         * (the agent's): both name the person, and the chip is drawn from the
         * address either way.
         */
        const full =
          addrs.find(
            (one) =>
              one.toLowerCase() === p.toLowerCase() ||
              localPart(one).toLowerCase() === p.toLowerCase(),
          ) ?? p;
        const gone = members !== null && !members.includes(full);
        const mine = full.toLowerCase() === me.toLowerCase();
        return (
          <span
            key={i}
            className={`chat-mention${mine ? " me" : ""}${gone ? " gone" : ""}`}
            title={gone ? t("No longer in this group") : full}
          >
            @{localPart(full)}
          </span>
        );
      })}
    </>
  );
}

/**
 * One message of the transcript.
 *
 * Memoised on the message it draws. The store hands a new `nodes` array on
 * every change -- one message arriving, a draft being typed -- and a
 * conversation holds a few hundred rows, so re-drawing all of them for a change
 * that touched one is work nobody asked for. The callbacks are stable, so a row
 * is redrawn when its own message, its quote or its reader changes, and not
 * otherwise.
 */
const ChatRow = memo(function ChatRow({
  message: m,
  mine,
  reply,
  me,
  members,
  question,
  onReply,
  onJump,
  onRef,
}: {
  message: ChatMessage;
  mine: boolean;
  /** What this message answers, when it is in the loaded window. */
  reply?: ChatMessage;
  me: string;
  /** The group's members, or null when no roster could be read. */
  members: string[] | null;
  /** Whether this message asks a question a person has not answered yet. */
  question: boolean;
  onReply: (id: Id) => void;
  onJump: (id: Id) => void;
  /** Follow a reference the message carries, without closing the panel. */
  onRef: (ref: ChatRef) => void;
}) {
  return (
    <div
      data-mid={m.id}
      className={`chat-row ${mine ? "mine" : ""}${question ? " question" : ""}`}
    >
      <div className="chat-bubble">
        {reply && (
          <button
            type="button"
            className="chat-quote"
            onClick={() => onJump(m.replyTo!)}
            title={t("Go to the message being answered")}
          >
            <span className="chat-quote-name">
              {reply.from === me ? t("You") : localPart(reply.from)}
            </span>
            <span className="chat-quote-text">
              <MentionedText
                text={reply.text}
                mentions={reply.mentions}
                me={me}
                members={members}
              />
            </span>
          </button>
        )}
        <div className="chat-bubble-meta">
          <span className="chat-sender">{mine ? t("You") : localPart(m.from)}</span>
          <span className="chat-clock">{formatListDate(m.at)}</span>
          <button
            type="button"
            className="icon-btn xs chat-reply"
            aria-label={t("Reply")}
            title={t("Reply")}
            // A mouse reply must not lift the caret out of the composer (same
            // pattern as the mention menu); when the editor had no focus, hand
            // it back so typing starts at once.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onReply(m.id)}
          >
            <CornerUpLeft size={13} />
          </button>
        </div>
        <div className="chat-text">
          <MentionedText text={m.text} mentions={m.mentions} me={me} members={members} />
        </div>
        {m.refs?.length ? (
          /*
           * What the message points at, as chips: the object opens **below** the
           * panel, which stays where it is — the conversation is the place a
           * person is reading, and a link in it is a look aside, not a departure.
           */
          <div className="chat-refs">
            {m.refs.map((ref) => (
              <button
                key={`${ref.kind}:${ref.id}`}
                type="button"
                className="chat-ref"
                title={t(REF_LABEL[ref.kind])}
                aria-label={t(REF_LABEL[ref.kind])}
                onClick={() => onRef(ref)}
              >
                <Link2 size={12} aria-hidden="true" />
                {t(REF_LABEL[ref.kind])}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function ChatPanel({ accounts, onClose }: ChatPanelProps) {
  const me = useSession((s) => s.session?.username ?? "");
  const setAccount = useSession((s) => s.setAccount);
  const [, setLocation] = useLocation();
  /*
   * The installation's own account, as the session names it: the agent switch
   * lives in the Master's files, and the server's event stream follows that
   * account for every member because a member's own subscription cannot.
   */
  const installationAccount = useSession(
    (s) => s.session?.gilbert?.installationAccount ?? null,
  );
  const conversations = useChat((s) => s.conversations);
  const openAccountId = useChat((s) => s.openAccountId);
  const open = openAccountId ? (conversations[openAccountId] ?? null) : null;
  /*
   * Who the transcript knows about: the participants it has seen. A group's
   * roster is not read here, so a member who has never written is not offered
   * and a mention of one is left to the text.
   */
  const members = null;
  const mentionables = useMemo(
    () => mentionablesOf(open ? participantsOf(open.nodes, me) : [], members, [me]),
    [open, me, members],
  );
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

  /**
   * Pin the viewport to the newest message, across the panel's first layout.
   *
   * The panel is `visibility: hidden` until the popover has been placed, and a
   * hidden thread reports a zero height — the first scroll lands nowhere. Pin
   * the bottom again on the next frames until the panel is laid out, and stop
   * the moment the reader scrolls away by hand.
   */
  const settleBottom = useCallback(() => {
    const el = threadRef.current;
    if (!el) return undefined;
    let raf = 0;
    let tries = 0;
    const settle = () => {
      if (!atBottom.current) return;
      el.scrollTop = el.scrollHeight;
      if (++tries < 20) raf = requestAnimationFrame(settle);
    };
    raf = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(raf);
  }, []);

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
    if (!atBottom.current && !open?.replyTo) return;
    atBottom.current = true;
    return settleBottom();
  }, [nodeCount, openAccountId, open?.replyTo, settleBottom]);

  /*
   * A conversation opens on its newest message, always. The scroll listener runs
   * while the tail is still arriving — an empty thread reports a position at the
   * top, and the previous window's height leaves the viewport at 0 — so the open,
   * and every reload, pins the bottom rather than trusting `atBottom`.
   */
  useEffect(() => {
    atBottom.current = true;
    return settleBottom();
  }, [openAccountId, open?.loaded, settleBottom]);

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
  };

  // ----- what the group's agent is doing, live (ADR 0030) -----
  const [runsOpen, setRunsOpen] = useState(false);

  // ----- the agent's open questions: counted, listed, jumped to -----
  const [questions, setQuestions] = useState<OpenQuestion[]>([]);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  /** Whether the installation's agent is on; null until the group answers. */
  const [agentOn, setAgentOn] = useState<boolean | null>(null);
  /** The place reserved for timed runs; nothing is built behind it yet. */
  const [timedOpen, setTimedOpen] = useState(false);
  /** The newest read of each, so a slower earlier answer cannot overwrite it. */
  const questionsSeq = useRef(0);
  const switchSeq = useRef(0);
  /** The generation of the last fresh switch read, and whether one is open. */
  const switchFresh = useRef(0);
  const switchFreshPending = useRef(false);

  // ----- search across the selected group's messages -----
  const [searchOpen, setSearchOpen] = useState(false);

  /*
   * A conversation opens on its newest message. The scroll listener runs while
   * the tail is still arriving — an empty thread reports a position at the top,
   * and the previous window's height leaves the viewport at 0 — so the open (and
   * every reload) pins the bottom explicitly rather than trusting `atBottom`.
   * The panels the head's buttons open replace the thread; closing one puts the
   * thread back, and it must come back where it left — at the last message, not
   * at the top of a conversation that was being read at the bottom.
   */
  useEffect(() => {
    atBottom.current = true;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [openAccountId, open?.loaded, runsOpen, questionsOpen, searchOpen]);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChatMessage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    setQuery("");
    setResults(null);
    setSearching(false);
    setEmojiOpen(false);
    setRunsOpen(false);
    setQuestionsOpen(false);
    setTimedOpen(false);
    // Another team's questions and switch are not this team's: clear them, and
    // the fetch below checks the account again when it lands.
    setQuestions([]);
    setAgentOn(null);
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

  const jumpTo = useCallback((id: Id) => {
    threadRef.current
      ?.querySelector(`[data-mid="${id}"]`)
      ?.scrollIntoView({ block: "center" });
  }, []);

  /*
   * Following a reference the agent wrote: the object opens **below**, and the
   * panel stays where it is. The account moves to the conversation's own first —
   * a file or a thread belongs to the group the chat is in, and a reader whose
   * session sits on another account would land on a folder it does not have.
   */
  const followRef = useCallback(
    (ref: ChatRef) => {
      if (openAccountId) setAccount(openAccountId);
      setLocation(refHref(ref, openAccountId));
    },
    [openAccountId, setAccount, setLocation],
  );

  /*
   * The questions the group's agent has open on a person (ADR 0029, 0038): the
   * live runs are the source, and the blocked ones whose wait is a chat message
   * are exactly the questions the thread draws highlighted. A run is a file in
   * the group's account, so the push stream is the clock; the interval below is
   * only the net under a stream that is down.
   */
  const questionsNow = useCallback(() => {
    const group = open?.name;
    if (!openAccountId || !group) {
      // Nothing is open: an answer still in flight must not name a question of
      // the previous team.
      questionsSeq.current += 1;
      setQuestions([]);
      return () => {};
    }
    let live = true;
    const ticket = ++questionsSeq.current;
    // A late answer belongs to the read that asked and to the conversation it
    // was asked from — not to an older read, nor to a team the reader switched
    // to since.
    const current = () =>
      live &&
      ticket === questionsSeq.current &&
      useChat.getState().openAccountId === openAccountId;
    fetchGroupRuns(group, "live", { plan: false })
      .then((runs) => {
        if (current()) setQuestions(openQuestionsOf(runs));
      })
      .catch(() => {
        // A listing that could not be read is not an empty one: what was read
        // stays on screen rather than a question quietly disappearing.
      });
    return () => {
      live = false;
    };
  }, [openAccountId, open?.name]);

  /*
   * Whether the installation's agent is on. The switch is the Master's file, and
   * the server's event stream follows the installation account for every member
   * (`/api/events`' fan-out), so a write there arrives like any other; this is
   * also read when the panel opens and on the net.
   */
  const agentOnNow = useCallback(
    (fresh = false) => {
      const group = open?.name;
      if (!openAccountId || !group) {
        switchSeq.current += 1;
        switchFresh.current += 1;
        switchFreshPending.current = false;
        setAgentOn(null);
        return () => {};
      }
      /*
       * A held value is not asked over a fresh read already in flight: it would
       * land after that answer and put the older pass's value back. The next
       * beat asks again once the document has answered.
       */
      if (!fresh && switchFreshPending.current) return () => {};
      let live = true;
      const ticket = ++switchSeq.current;
      const generation = fresh ? ++switchFresh.current : switchFresh.current;
      if (fresh) switchFreshPending.current = true;
      const current = () =>
        live &&
        useChat.getState().openAccountId === openAccountId &&
        generation === switchFresh.current &&
        // This client asked the fresh read last: a held read it launched while
        // the fresh one was open cannot land after it. The value a beat brings
        // is still that server process's last read, which a second replica may
        // have served a pass behind.
        (fresh || ticket === switchSeq.current);
      const settle = () => {
        if (fresh && generation === switchFresh.current)
          switchFreshPending.current = false;
      };
      fetchGroupAgent(group, fresh)
        .then((state) => {
          if (current()) setAgentOn(state.enabled);
        })
        .catch(() => {
          // Unknown is drawn as neither on nor off.
          if (current()) setAgentOn(null);
        })
        .finally(settle);
      return () => {
        live = false;
      };
    },
    [openAccountId, open?.name],
  );

  useEffect(() => {
    const stopQuestions = questionsNow();
    // Opening the panel, or switching team, is the moment to ask the document
    // itself: the pass's last read is for the beats, not for arriving.
    const stopSwitch = agentOnNow(true);
    /*
     * The stream is the clock: a run document is a `FileNode` in the group's
     * account, and the switch is one in the installation's account, which the
     * server's fan-out follows for a member. The agent writes a burst, so one
     * read follows it after a second. The event names the file, so the switch is
     * read fresh; the interval is the net under a stream that is down (and the
     * only channel on a deployment without fan-out) and asks the value the pass
     * already holds. The window coming back and a reconnect read the document
     * itself.
     */
    let scheduled: number | null = null;
    let pendingQuestions = false;
    let pendingSwitch = false;
    const fire = () => {
      scheduled = null;
      if (pendingQuestions) void questionsNow();
      if (pendingSwitch) void agentOnNow(true);
      pendingQuestions = false;
      pendingSwitch = false;
    };
    const stopPush = openAccountId
      ? push.subscribe((changed, type) => {
          if (type !== "FileNode") return;
          if (changed === openAccountId) pendingQuestions = true;
          else if (changed === installationAccount) pendingSwitch = true;
          else return;
          if (scheduled === null) scheduled = window.setTimeout(fire, 1_000);
        })
      : () => {};
    const fallback = window.setInterval(() => {
      void questionsNow();
      void agentOnNow();
    }, 15_000);
    const seen = () => {
      if (document.visibilityState === "visible") {
        void questionsNow();
        void agentOnNow(true);
      }
    };
    document.addEventListener("visibilitychange", seen);
    return () => {
      stopQuestions();
      stopSwitch();
      stopPush();
      window.clearInterval(fallback);
      if (scheduled !== null) window.clearTimeout(scheduled);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [questionsNow, agentOnNow, openAccountId, installationAccount]);

  // The admin surface and the chat are one client: a switch written there is
  // said here at once, not on the next beat.
  useEffect(() => onAgentSwitch((state) => setAgentOn(state.enabled)), []);

  // A stream that comes back may have missed the change that mattered: one
  // fresh read of each is the catch-up.
  useEffect(
    () =>
      push.onReconnect(() => {
        void questionsNow();
        void agentOnNow(true);
      }),
    [questionsNow, agentOnNow],
  );

  const questionIds = useMemo(
    () => new Set(questions.map((one) => one.messageId)),
    [questions],
  );

  /** Open the thread on the message a question was asked in, paging back to it. */
  const showQuestion = useCallback(
    async (id: Id) => {
      setQuestionsOpen(false);
      setRunsOpen(false);
      setSearchOpen(false);
      if (!openAccountId) return;
      let guard = 0;
      while (guard++ < 50) {
        const conv = useChat.getState().conversations[openAccountId];
        if (!conv || conv.reachedStart || conv.pagingMore) break;
        if (conv.nodes.some((node) => node.id === id)) break;
        await loadOlder(openAccountId);
      }
      window.setTimeout(() => jumpTo(id), 0);
    },
    [openAccountId, loadOlder, jumpTo],
  );

  /*
   * Stable for the rows' memo: the store's own `setReply`, and the
   * conversation on screen -- which is the one whose transcript is drawn, so
   * this changes when the conversation does and not on every store snapshot.
   */
  const replyToMessage = useCallback(
    (id: Id) => {
      // `openAccountId` and the open conversation's own `accountId` are the same
      // by construction -- conversations are keyed by their account -- and this
      // spelling is the stable one the rows' memo needs.
      if (openAccountId) setReply(openAccountId, id);
      chatInputRef.current?.focus();
    },
    [openAccountId, setReply],
  );

  // Focus the composer when a conversation opens. The editor lives in a
  // popover that starts `visibility: hidden` until it has been positioned,
  // and focusing a hidden element is a silent no-op, so retry on the next
  // animation frames until the composer actually holds the focus.
  useEffect(() => {
    if (!openAccountId || searchOpen || runsOpen || questionsOpen) return;
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
  }, [openAccountId, searchOpen, runsOpen, questionsOpen, open?.loading]);

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
    open.nodes.length >= CHAT_TAIL;

  return (
    <div className="chat-panel">
      <div className="chat-head">
        {/* The product is the channel's own name, whatever team is open; a
            switched-off agent is the one thing worth adding beside it. */}
        <span className="chat-title">
          {t("Gilbert AI interface")}
          {agentOn === false && (
            <span className="chat-title-off">{t("Gilbert AI off")}</span>
          )}
        </span>
        <span className="chat-head-actions">
          {open && (
            <span className="chat-head-q">
              <button
                type="button"
                className={`icon-btn xs ${questionsOpen ? "active" : ""}`}
                aria-label={
                  questions.length
                    ? t("Open questions ({n})", { n: questions.length })
                    : t("Open questions")
                }
                title={t("Questions waiting for an answer")}
                onClick={() => {
                  setQuestionsOpen((v) => !v);
                  setRunsOpen(false);
                  setSearchOpen(false);
                  setTimedOpen(false);
                }}
              >
                <CircleHelp size={15} />
              </button>
              {questions.length > 0 && (
                <span className="chat-badge" aria-hidden="true">
                  {questions.length}
                </span>
              )}
            </span>
          )}
          {open && (
            <button
              type="button"
              className={`icon-btn xs ${timedOpen ? "active" : ""}`}
              aria-label={t("Timed runs")}
              title={t("Timed runs")}
              onClick={() => {
                setTimedOpen((v) => !v);
                setQuestionsOpen(false);
                setRunsOpen(false);
                setSearchOpen(false);
              }}
            >
              <Clock size={15} />
            </button>
          )}
          {open && (
            <button
              type="button"
              className={`icon-btn xs ${runsOpen ? "active" : ""}`}
              aria-label={t("What the agent is doing")}
              title={t("What the agent is doing")}
              onClick={() => {
                setRunsOpen((v) => !v);
                setSearchOpen(false);
                setQuestionsOpen(false);
              }}
            >
              <ListChecks size={15} />
            </button>
          )}
          {open && (
            <button
              type="button"
              className={`icon-btn xs ${searchOpen ? "active" : ""}`}
              aria-label={t("Search messages")}
              title={t("Search messages")}
              onClick={() => {
                setSearchOpen((v) => !v);
                setRunsOpen(false);
                setQuestionsOpen(false);
                setTimedOpen(false);
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
                <span className="chat-switch-name" title={a.name}>
                  {/* The tab names the team, not the mailbox: the local part is
                      the space a reader needs, and the address is on hover. */}
                  {a.name.includes("@") ? `${localPart(a.name)}@` : a.name}
                </span>
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
        {timedOpen && open ? (
          <div className="chat-empty">{t("To be implemented")}</div>
        ) : questionsOpen && open ? (
          <div className="chat-questions">
            {questions.length > 0 && (
              <div className="chat-questions-head">
                {plural(questions.length, {
                  one: "{n} question waiting for an answer",
                  other: "{n} questions waiting for an answer",
                })}
              </div>
            )}
            {questions.length ? (
              questions.map((one) => (
                <div key={one.runId} className="chat-question-row">
                  {/* The words page back to where the question was asked; the
                      two actions are what a person came to this list for. */}
                  <button
                    type="button"
                    className="chat-question-text"
                    title={one.question}
                    onClick={() => void showQuestion(one.messageId)}
                  >
                    {snippet(one.question)}
                  </button>
                  <span className="chat-question-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        // Back to the conversation, with the reply already
                        // quoting the question the agent asked. The message is
                        // paged in first, so the quote bar can name it.
                        setQuestionsOpen(false);
                        void showQuestion(one.messageId).then(() =>
                          replyToMessage(one.messageId),
                        );
                      }}
                    >
                      {t("Answer")}
                    </button>
                    {/* Disregarding is stopping: the run closes cancelled, and
                        the question is no longer waiting on anybody. */}
                    <StopRun
                      group={open.name}
                      id={one.runId}
                      label={t("Disregard")}
                      onStopped={() => void questionsNow()}
                    />
                  </span>
                </div>
              ))
            ) : (
              <div className="chat-empty">
                {t("No question is waiting for an answer.")}
              </div>
            )}
          </div>
        ) : runsOpen && open ? (
          <div className="chat-runs" style={{ padding: 12 }}>
            <GroupRuns
              group={open.name}
              accountId={openAccountId ?? undefined}
              facts={NO_FACTS}
              live
              runningOnly
            />
          </div>
        ) : searchOpen ? (
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
                        {m.from === me ? t("You") : localPart(m.from)}
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
              {/*
               * Reading back is a click, not a scroll: a thread that fetched a
               * page every time the top came into view spent a reader's data on
               * messages they only scrolled past, and a hidden panel could load
               * the whole history without anyone asking.
               */}
              {!open.reachedStart && !open.pagingMore && (
                <div className="chat-older">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void older()}
                  >
                    {t("Load earlier messages")}
                  </button>
                </div>
              )}
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
              {open.nodes.map((m) => (
                <ChatRow
                  key={m.id}
                  message={m}
                  mine={m.from === me}
                  reply={m.replyTo ? byId.get(m.replyTo) : undefined}
                  me={me}
                  members={members}
                  question={questionIds.has(m.id)}
                  onReply={replyToMessage}
                  onJump={jumpTo}
                  onRef={followRef}
                />
              ))}
            </>
          )
        ) : (
          <div className="chat-empty">{t("Pick a conversation")}</div>
        )}
      </div>
      {open && !searchOpen && !runsOpen && (
        <div className="chat-composer">
          {open.replyTo && (
            <div className="chat-replybar">
              <span className="chat-replybar-label">
                {(() => {
                  const target = byId.get(open.replyTo!);
                  return target
                    ? t("Replying to {who}", {
                        who: target.from === me ? t("You") : localPart(target.from),
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
              maxLength={CHAT_MAX_TEXT}
              mentionables={mentionables}
              // The channel is Gilbert first, the team second: the placeholder
              // names both, and the group's local part is the one a person
              // reads in the tabs.
              placeholder={t("Message {group}", {
                group: `Gilbert @${localPart(open.name)}`,
              })}
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
