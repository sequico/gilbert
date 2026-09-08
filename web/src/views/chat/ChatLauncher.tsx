/**
 * The chat launcher (ADR 0006): the top-bar entry to group chat.
 *
 * First item of the top-bar action cluster, immediately left of the push
 * status -- the composer dock owns the bottom-right corner and the account
 * avatar is the corner anchor, so the launcher lives in the top bar and its
 * panel opens under it. Offered only when the session holds group mailboxes;
 * the product-admin group is not a chat account (ADR 0001). The panel is a
 * popover on desktop and a full-screen sheet on mobile, and it closes itself
 * when a composer is maximised (the composer is the persistent work area).
 */
import { MessageCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const mailAccounts = useMail((s) => s.mailAccounts);
  const groups = groupMailboxAccounts(mailAccounts);
  const conversations = useChat((s) => s.conversations);
  // A composer is "maximised" when the active draft is: the draft list
  // changes on every edit, but the selector returns a boolean, so this only
  // re-renders when the value actually flips.
  const maximized = useCompose((s) => {
    const active = s.activeKey ? s.drafts.find((d) => d.key === s.activeKey) : undefined;
    return active?.maximized ?? false;
  });
  const openConversation = useChat((s) => s.open);

  const unread = groups.reduce(
    (n, a) =>
      n + (conversations[a.accountId] ? unreadOf(conversations[a.accountId]!) : 0),
    0,
  );

  // A maximised composer covers nearly the whole viewport; the chat panel is
  // transient by design and yields to it (ADR 0006).
  useEffect(() => {
    if (maximized) setOpen(false);
  }, [maximized]);

  if (!groups.length) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // First use: open the first conversation so the panel is not an empty
    // shell; `open` warms the transcript if the warm-up has not reached it.
    if (next && !useChat.getState().openAccountId) {
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

  if (!open) return button;

  const panel = <ChatPanel accounts={groups} onClose={() => setOpen(false)} />;

  if (isMobile) {
    return (
      <>
        {button}
        <div className="chat-sheet" role="dialog" aria-label={t("Chat")}>
          {panel}
        </div>
      </>
    );
  }

  return (
    <>
      {button}
      <Popover
        anchor={anchorFromEl(btnRef.current)}
        onClose={() => setOpen(false)}
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
