import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPolicy } from "../AdminPolicy";

/*
 * The policy reader is asked for the account's policy on boot; what this file
 * is about is the notice a publish earns, so the reader answers with nothing
 * and the store's own change queue is empty.
 */
vi.mock("@/lib/settingsPolicy", () => ({
  refreshSettingsPolicy: vi.fn(async () => {}),
  policyEnforced: () => ({}),
  policyChanges: () => [],
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const POLICY = JSON.stringify({ defaults: { weekStart: 1 } }, null, 2);

/** What a publish answers with, in the shape `PublishJob` describes. */
function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: "p1",
    startedAt: "2026-09-18T09:00:00.000Z",
    by: "admin@example.com",
    population: { read: 3, complete: true, total: 3 },
    reached: ["admin@example.com", "a@example.com", "b@example.com"],
    unreached: [],
    complete: true,
    ...over,
  };
}

describe("the policy publish notice", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => root.unmount());
    host.remove();
  });

  /** The read answers an empty document; the publish answers `published`. */
  function answerWith(published: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          ({
            ok: true,
            status: 200,
            statusText: "",
            json: async () =>
              init?.method === "POST"
                ? { job: published }
                : { policy: POLICY, job: null },
          }) as Response,
      ),
    );
  }

  function button(label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(label),
    );
    if (!found) throw new Error(`no button: ${label}`);
    return found;
  }

  /** Render the surface and let its read settle. */
  async function render() {
    await act(async () => {
      root.render(<AdminPolicy />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /**
   * An edit, as React sees one: the native setter, then the input event — so
   * the document differs from what the account holds and the button is live.
   */
  async function type(text: string) {
    await act(async () => {
      const field = host.querySelector("textarea");
      if (!field) throw new Error("the editor is not rendered");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /** One publish, and the round trip its handler makes. */
  async function publish() {
    await act(async () => {
      button("Publish policy").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("says when the account could not keep the report of a publish", async () => {
    // The publish reached every account; only its own record could not be
    // written. The reader has to be told, because the next visit to this page
    // shows nothing about a publish that happened.
    answerWith(
      job({ record: "failed", recordMessage: "Files account refused the write" }),
    );
    await render();
    await type(`${POLICY}\n`);
    await publish();

    const text = host.textContent ?? "";
    expect(text).toContain("Published. The directory listed");
    expect(text).toContain(
      "This publish could not be recorded in your account, so reopening this page will not show it.",
    );
  });

  it("says nothing about the record when the account kept it", async () => {
    answerWith(job());
    await render();
    await type(`${POLICY}\n`);
    await publish();

    const text = host.textContent ?? "";
    expect(text).toContain("Published. The directory listed");
    expect(text).not.toContain("could not be recorded in your account");
  });

  it("names what a publish did not reach, with the reason for each", async () => {
    answerWith(
      job({
        complete: false,
        population: { read: 3, complete: true, total: 3 },
        unreached: [{ address: "c@example.com", code: "write-failed", message: "nope" }],
      }),
    );
    await render();
    await type(`${POLICY}\n`);
    await publish();

    const text = host.textContent ?? "";
    expect(text).toContain("The policy was not published everywhere.");
    expect(text).toContain("c@example.com — the write was refused");
    expect(text).not.toContain("could not be recorded in your account");
  });
});
