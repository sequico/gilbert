/**
 * The chat launcher (ADR 0005): the top-bar entry to group chat.
 *
 * First item of the top-bar action cluster, immediately left of the phone
 * entry -- the composer dock owns the bottom-right corner and the account
 * avatar is the corner anchor, so the launcher lives in the top bar and its
 * panel opens under it. Offered only when the session holds group mailboxes;
 * the product-admin group is not a chat account (ADR 0001). The panel is a
 * popover on desktop and a sheet in the content area on mobile -- portaled to
 * the body so the top bar's stacking context cannot trap it -- and it closes
 * itself when a composer covers the screen (the composer is the persistent
 * work area).
 */
import { MessageCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { unreadOf, useChat } from "@/store/chat";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { useIsMobile } from "@/ui/misc";
import { anchorFromEl, Popover } from "@/ui/popover";
import { ChatPanel } from "./ChatPanel";

export function ChatLauncher() {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const btnRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const mailAccounts = useMail((s) => s.mailAccounts);
  const groups = groupMailboxAccounts(mailAccounts);
  const conversations = useChat((s) => s.conversations);
  /*
   * A composer covers the panel: on the desktop that is the maximised draft,
   * on a phone every open composer is full-screen. Both selectors return a
   * boolean, so a keystroke in a draft does not re-render the launcher unless
   * the value it answers actually flips.
   */
  const hasDraft = useCompose((s) => s.drafts.some((d) => !d.minimized));
  const maximized = useCompose((s) => {
    const active = s.activeKey ? s.drafts.find((d) => d.key === s.activeKey) : undefined;
    return active?.maximized ?? false;
  });
  const coveredByComposer = isMobile ? hasDraft : maximized;
  const openConversation = useChat((s) => s.open);
  /*
   * Closing the panel gives the conversation up. While nothing is on screen an
   * arrival must stay unread — the launcher badge and the notification are the
   * signal then — so the store's open conversation is cleared with the panel,
   * not left pointing at what was last looked at.
   */
  const shut = useCallback(() => {
    setOpen(false);
    useChat.getState().close();
  }, []);

  const unread = groups.reduce(
    (n, a) =>
      n + (conversations[a.accountId] ? unreadOf(conversations[a.accountId]!) : 0),
    0,
  );

  // A composer is the persistent work area; the chat panel is transient by
  // design and yields to it (ADR 0005).
  useEffect(() => {
    if (coveredByComposer) shut();
  }, [coveredByComposer, shut]);

  // A notification's click asks the panel to open on the conversation it named.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      // A click for a conversation the session no longer holds -- the reader
      // left the group while the notification sat on the lock screen -- opens
      // nothing rather than leaving a dangling open id.
      if (!id || !(id in useChat.getState().conversations)) return;
      setOpen(true);
      openConversation(id);
    };
    window.addEventListener("gilbert:open-chat", onOpen);
    return () => window.removeEventListener("gilbert:open-chat", onOpen);
  }, [openConversation]);

  // The popover closes itself on any outside mousedown -- including this
  // launcher's own. That would close the panel on the press and leave the
  // click to reopen it (the state has already flipped by then), so while
  // the panel is open a press that starts on the launcher is swallowed at
  // the window (capture fires before the popover's document listener) and
  // the click's toggle is the one that closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) e.stopPropagation();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [open]);

  // On a phone the panel is a sheet in the content area, not a popover, so it
  // brings no outside-press handling of its own: a press on the top bar, a
  // tab-bar tab or the content behind it dismisses the sheet, exactly as it
  // would the popover on a desktop. A press on the launcher is left to the
  // toggle.
  useEffect(() => {
    if (!open || !isMobile) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (sheetRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      shut();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
    };
  }, [open, isMobile, shut]);

  if (!groups.length) return null;

  const toggle = () => {
    const next = !open;
    if (!next) {
      shut();
      return;
    }
    setOpen(true);
    // First use: open the first conversation so the panel is not an empty
    // shell; `open` warms the transcript if the warm-up has not reached it.
    if (!useChat.getState().openAccountId) {
      openConversation(groups[0]!.accountId);
    }
  };

  const button = (
    <button
      ref={btnRef}
      type="button"
      className="icon-btn chat-launcher"
      aria-label={t("Chat")}
      title={t("Chat")}
      aria-expanded={open}
      onClick={toggle}
    >
      <MessageCircle size={21} />
      {unread > 0 && <span className="chat-badge">{unread}</span>}
    </button>
  );

  if (!open || coveredByComposer) return button;

  const panel = <ChatPanel accounts={groups} onClose={shut} />;

  if (isMobile) {
    return (
      <>
        {button}
        {createPortal(
          <div ref={sheetRef} className="chat-sheet" role="dialog" aria-label={t("Chat")}>
            {panel}
          </div>,
          document.body,
        )}
      </>
    );
  }

  return (
    <>
      {button}
      <Popover
        anchor={anchorFromEl(btnRef.current)}
        onClose={shut}
        align="end"
        width={384}
        role="dialog"
        ariaLabel={t("Chat")}
        style={{ zIndex: 700, maxHeight: "min(70vh, 560px)", overflow: "hidden" }}
      >
        {panel}
      </Popover>
    </>
  );
}
