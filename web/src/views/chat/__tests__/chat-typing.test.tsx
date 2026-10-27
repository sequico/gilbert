import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { type ChatConversation, useChat } from "@/store/chat";
import { useSession } from "@/store/session";
import { ChatPanel } from "../ChatPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The agent at work is said where a person is writing: a line at the tail of the
 * conversation — "Gilbert is writing…" — that opens the run it belongs to, and that
 * goes when the run does.
 *
 * The run is a file in the group's account, so the panel's stream is the clock: the
 * same listing that carries the open questions carries the runs in flight, and the
 * test drives the stream by hand.
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

const stream = vi.hoisted(() => ({
  listeners: [] as Array<(changed: string, type: string) => void>,
  reconnects: [] as Array<() => void>,
}));
vi.mock("@/jmap/push", () => ({
  push: {
    subscribe: (fn: (changed: string, type: string) => void) => {
      stream.listeners.push(fn);
      return () => {
        stream.listeners = stream.listeners.filter((one) => one !== fn);
      };
    },
    onConnection: () => () => {},
    onReconnect: (fn: () => void) => {
      stream.reconnects.push(fn);
      return () => {
        stream.reconnects = stream.reconnects.filter((one) => one !== fn);
      };
    },
    onReachability: () => () => {},
    start: () => {},
    stop: () => {},
  },
}));

const GROUP: MailAccountInfo = { accountId: "g1", name: "Team", kind: "group" };

const conversation = (): ChatConversation => ({
  accountId: "g1",
  name: "Team",
  folders: null,
  nodes: [],
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

/** One run in flight, working: what the tail line is drawn for. */
const running = {
  id: "run-2",
  problem: null,
  state: "running",
  ended: null,
  woke: "mail created: m-1",
  about: "BK-901 arrives on the 4th",
  by: null,
  steps: 2,
  failed: 0,
  waiting: null,
  spent: { steps: 1, calls: 2, ms: 900 },
};

describe("the agent at work, in the conversation", () => {
  let host: HTMLDivElement;
  let root: Root;

  const typing = () => host.querySelector(".chat-typing") as HTMLButtonElement | null;

  beforeEach(async () => {
    admin.fetchGroupRuns.mockResolvedValue([running]);
    admin.fetchGroupAgent.mockResolvedValue({ enabled: true });
    admin.stopRun.mockResolvedValue(undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useSession.setState({
      session: { gilbert: { installationAccount: "inst" } } as never,
    });
    useChat.setState({
      conversations: { g1: conversation() },
      openAccountId: "g1",
    });
    await act(async () => {
      root.render(<ChatPanel accounts={[GROUP]} onClose={() => {}} />);
    });
    await act(async () => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("says the agent is writing while a run is working", () => {
    expect(typing()?.textContent).toContain("Gilbert is writing…");
  });

  it("opens the runs from that line", async () => {
    await act(async () => {
      typing()?.click();
    });
    expect(
      host.querySelector(".chat-thread")?.textContent,
      "the conversation gives way to the runs it opened",
    ).not.toContain("Gilbert is writing…");
    expect(admin.fetchGroupRuns).toHaveBeenCalled();
  });

  it("says nothing while the agent is turned off, even with a run in flight", async () => {
    admin.fetchGroupAgent.mockResolvedValue({ enabled: false });
    await act(async () => {
      // The switch is a FileNode in the installation's account: the stream
      // names it, and the panel reads the document again a second later.
      for (const listener of stream.listeners) listener("inst", "FileNode");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    expect(host.textContent).toContain("Gilbert AI off");
    expect(typing()).toBeNull();
  });

  it("goes away when the run does", async () => {
    admin.fetchGroupRuns.mockResolvedValue([]);
    await act(async () => {
      // The run's own document is written in the group's account: the stream says
      // what changed, and the listing is read again a second later.
      for (const listener of stream.listeners) listener("g1", "FileNode");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    expect(typing()).toBeNull();
  });
});
