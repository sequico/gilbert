import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { type ChatConversation, useChat } from "@/store/chat";
import { ChatPanel } from "../ChatPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout: a row jumped to is scrolled into view by the panel.
Element.prototype.scrollIntoView = () => {};

/**
 * The list of the agent's open questions, and the two things a person does with
 * one: answer it (the composer opens on a reply that quotes it) or disregard it
 * (the run closes cancelled). The run carries the question; the panel reads the
 * live runs, so the listing is the fixture and the reply is the store's.
 */
const admin = vi.hoisted(() => ({
  fetchGroupRuns: vi.fn(),
  fetchGroupAgent: vi.fn(),
  stopRun: vi.fn(),
}));
vi.mock("@/lib/agentAdmin", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agentAdmin")>();
  return {
    ...real,
    fetchGroupRuns: admin.fetchGroupRuns,
    fetchGroupAgent: admin.fetchGroupAgent,
    stopRun: admin.stopRun,
  };
});

const GROUP: MailAccountInfo = { accountId: "g1", name: "Team", kind: "group" };

const question = {
  id: "q1",
  v: 1 as const,
  from: "agent@example.com",
  at: "2026-10-22T10:00:00Z",
  text: "Which booking should I file?",
  created: "2026-10-22T10:00:00Z",
};

const conversation = (): ChatConversation => ({
  accountId: "g1",
  name: "Team",
  folders: null,
  nodes: [question] as ChatConversation["nodes"],
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

/** The one run the live listing carries: blocked on a chat question. */
const blocked = {
  id: "run-1",
  problem: null,
  state: "blocked",
  ended: null,
  rule: null,
  woke: null,
  about: null,
  by: null,
  steps: 1,
  failed: 0,
  waiting: {
    what: "Which booking should I file?",
    asked: { channel: "chat", id: "q1" },
    until: "2026-10-23T10:00:00Z",
  },
  spent: { steps: 1, calls: 1, ms: 10 },
};

describe("the agent's open questions", () => {
  let host: HTMLDivElement;
  let root: Root;

  /** The button whose words are exactly this, if it is drawn. */
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((one) => one.textContent === text) as
      | HTMLButtonElement
      | undefined;

  /** The "?" control in the panel's header, which draws no words. */
  const openQuestions = () =>
    host.querySelector(
      'button[aria-label^="Open questions"]',
    ) as HTMLButtonElement | null;

  beforeEach(async () => {
    admin.fetchGroupRuns.mockResolvedValue([blocked]);
    admin.fetchGroupAgent.mockResolvedValue({ enabled: true });
    admin.stopRun.mockResolvedValue(undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useChat.setState({
      conversations: { g1: conversation() },
      openAccountId: "g1",
    });
    await act(async () => {
      root.render(<ChatPanel accounts={[GROUP]} onClose={() => {}} />);
    });
    // The listing is a promise: let it land before the list is opened.
    await act(async () => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("offers an answer and a disregard for each question", async () => {
    await act(async () => {
      openQuestions()?.click();
    });

    expect(button("Answer")).toBeTruthy();
    expect(button("Disregard")).toBeTruthy();
    expect(host.textContent, "an agent that is on says nothing extra").not.toContain(
      "Gilbert AI off",
    );
  });

  it("answers by opening the composer on a reply that quotes the question", async () => {
    await act(async () => {
      openQuestions()?.click();
    });
    await act(async () => {
      button("Answer")?.click();
    });

    expect(useChat.getState().conversations.g1?.replyTo).toBe("q1");
    expect(
      button("Answer"),
      "the list is closed, the conversation is back",
    ).toBeUndefined();
  });

  it("disregards by closing the run as cancelled", async () => {
    await act(async () => {
      openQuestions()?.click();
    });
    await act(async () => {
      button("Disregard")?.click();
    });

    expect(admin.stopRun).toHaveBeenCalledWith("Team", "run-1");
  });

  it("names a switched-off agent in the header", async () => {
    admin.fetchGroupAgent.mockResolvedValue({ enabled: false });
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(<ChatPanel accounts={[GROUP]} onClose={() => {}} />);
    });
    await act(async () => {});

    expect(host.textContent).toContain("Gilbert AI off");
  });
});
