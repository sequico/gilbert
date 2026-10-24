import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { type ChatConversation, useChat } from "@/store/chat";
import { useSession } from "@/store/session";
import { ChatPanel } from "../ChatPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What the agent's message points at (ADR 0042).
 *
 * The chip opens the object **below**: the route moves, the panel stays where it
 * is, and the session moves to the conversation's account first — a reference
 * names an object of the group the chat is in, and a reader sitting on another
 * account would otherwise land on a folder that account does not have.
 */
const GROUP: MailAccountInfo = { accountId: "g1", name: "Team", kind: "group" };

const message = (
  id: string,
  text: string,
  refs?: ChatConversation["nodes"][0]["refs"],
) => ({
  id,
  v: 1 as const,
  from: "gilbert@example.com",
  at: "2026-11-03T09:00:00Z",
  text,
  created: "2026-11-03T09:00:00Z",
  ...(refs?.length ? { refs } : {}),
});

const conversation = (): ChatConversation => ({
  accountId: "g1",
  name: "Team",
  folders: null,
  nodes: [
    message("m1", "ecco i due riferimenti", [
      { kind: "file", id: "node-7" },
      { kind: "event", id: "ev-3", date: "2026-11-03" },
    ]),
  ],
  stateToken: null,
  loading: false,
  loaded: true,
  error: null,
  marker: null,
  draft: "",
  replyTo: null,
  sending: false,
  earliestPos: 0,
  pagingMore: false,
  reachedStart: false,
});

describe("a reference in the conversation", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    history.replaceState({}, "", "/mail/inbox");
    useSession.setState({ accountId: null });
    useChat.setState({
      conversations: { g1: conversation() },
      openAccountId: "g1",
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const renderPanel = async () => {
    await act(async () => {
      root.render(<ChatPanel accounts={[GROUP]} onClose={() => {}} />);
    });
  };

  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };

  it("opens the file the message names, with the panel still in front", async () => {
    await renderPanel();
    const chips = [...host.querySelectorAll<HTMLButtonElement>(".chat-ref")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["Files", "Calendar"]);

    await click(chips[0]!);

    expect(window.location.pathname).toBe("/files/node-7");
    expect(useSession.getState().accountId).toBe("g1");
    expect(host.querySelectorAll(".chat-ref")).toHaveLength(2);
  });

  it("opens the day an event is on", async () => {
    await renderPanel();
    await click(host.querySelectorAll<HTMLButtonElement>(".chat-ref")[1]!);

    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/calendar/day/2026-11-03?event=ev-3",
    );
    expect(host.querySelectorAll(".chat-ref")).toHaveLength(2);
  });
});
