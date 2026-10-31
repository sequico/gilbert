import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodayBoard } from "@/lib/outbound";
import { useMail } from "@/store/mail";
import { useOutbound } from "@/store/outbound";
import { TodayView } from "../TodayView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Taking a row, and what the panel says about the words the campaign pinned.
 *
 * The script is read in the same act as the take, and the two answers it can
 * give are different things: the server answering "this campaign pinned
 * nothing" (a page that is gone) and the read failing. A take that failed to
 * read the script must keep the row in hand and say so, rather than show the
 * caller a panel with no words on it and let them improvise.
 */

const { ROW, mocks } = vi.hoisted(() => {
  const row = {
    version: 1 as const,
    uid: "r1",
    campaignUid: "c1",
    e164: "+442079460101",
    extension: null,
    context: null,
    cardUid: null,
    state: "open" as const,
    claim: null,
    nextCallAt: null,
    calls: [],
    trimmed: 0,
    createdAt: "2026-10-01T09:00:00Z",
    card: null,
  };
  return {
    ROW: row,
    mocks: {
      fetchScript:
        vi.fn<(group: string, campaignUid: string) => Promise<string | null>>(),
      takeRow:
        vi.fn<
          (group: string, campaignUid: string, rowUid: string) => Promise<typeof row>
        >(),
    },
  };
});

vi.mock("@/lib/outbound", async () => {
  const actual = await vi.importActual<typeof import("@/lib/outbound")>("@/lib/outbound");
  return {
    ...actual,
    fetchToday: async (): Promise<TodayBoard> => ({
      queue: [ROW],
      due: 1,
      upcoming: 0,
      heldByOthers: 0,
      problems: [],
    }),
    fetchDoNotCall: async () => [],
    fetchScriptPages: async () => [],
    fetchScript: (group: string, campaignUid: string) =>
      mocks.fetchScript(group, campaignUid),
    takeRow: (group: string, campaignUid: string, rowUid: string) =>
      mocks.takeRow(group, campaignUid, rowUid),
    fetchRows: async () => [],
    releaseRow: async () => ROW,
    settleRow: async () => ROW,
    setDoNotCall: async () => [],
    closeCampaign: async () => ROW,
    createCampaign: async () => ({ uid: "c1" }),
    importRows: async () => ({
      added: 0,
      matched: 0,
      duplicate: 0,
      blocked: 0,
      refused: [],
    }),
  };
});

let root: Root | null = null;
let host: HTMLElement;

const button = (label: string) =>
  Array.from(host.querySelectorAll("button")).find((one) => one.textContent === label);

function render() {
  act(() => root!.render(<TodayView />));
}

/** Let the view's own reads land: they are promise chains, not timers. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  useMail.setState({
    mailAccounts: [{ accountId: "g1", name: "freight@example.com", kind: "group" }],
  });
  useOutbound.setState({
    group: "",
    campaign: "",
    campaigns: [
      {
        uid: "c1",
        purpose: "Renewals",
        outcomes: [{ id: "interested", label: "Interested" }],
        state: "running",
      } as never,
    ],
    findings: [],
    load: async () => undefined,
  });
  mocks.takeRow.mockResolvedValue(ROW);
  mocks.fetchScript.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe("taking a row of Today", () => {
  it("keeps the row in hand and says so when the script cannot be read", async () => {
    mocks.fetchScript.mockRejectedValue(new Error("network down"));
    render();
    await settle();

    act(() => button("Take")!.click());
    await settle();

    // The take is not undone by the failed read: the panel is open.
    expect(host.textContent).toContain(
      "Settle the row in hand or release it before taking another.",
    );
    // And the failure is not dressed as a campaign that pinned no script.
    expect(host.querySelector(".error-box")?.textContent).toContain("network down");
    expect(host.querySelector(".call-script")).toBeNull();
  });

  it("opens the panel without a complaint when the campaign pinned no script", async () => {
    mocks.fetchScript.mockResolvedValue(null);
    render();
    await settle();

    act(() => button("Take")!.click());
    await settle();

    expect(host.textContent).toContain(
      "Settle the row in hand or release it before taking another.",
    );
    expect(host.querySelector(".error-box")).toBeNull();
    expect(host.querySelector(".call-script")).toBeNull();
  });

  it("shows the words the campaign pinned", async () => {
    mocks.fetchScript.mockResolvedValue("Hello, this is about your renewal.");
    render();
    await settle();

    act(() => button("Take")!.click());
    await settle();

    expect(host.querySelector(".call-script")?.textContent).toBe(
      "Hello, this is about your renewal.",
    );
    expect(host.querySelector(".error-box")).toBeNull();
  });
});
