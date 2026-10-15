import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushTwice as flush, identity } from "@/test/testkit";
import { GroupLabels } from "../GroupLabels";
import { UserIdentities } from "../UserIdentities";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A directory read that lands after the picker moved on (finding 5).
 *
 * Selecting another group, or another account, starts a second read while the
 * first is still in flight. The first one's answer belongs to a target nobody
 * is looking at any more: writing it down shows one group's catalogue under
 * another's name, or one person's identities under another's address, and the
 * next write addresses the wrong one. The answer is dropped instead.
 */

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as Response;
}

function deferred(): { promise: Promise<Response>; resolve: (r: Response) => void } {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("a directory read that lost its target", () => {
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

  const choose = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  it("keeps the group the picker is on, not the one whose read was slower", async () => {
    const labels = new Map<string, ReturnType<typeof deferred>>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url === "/api/admin/groups")
          return Promise.resolve(
            json({
              groups: [
                { id: "1", name: "a@x" },
                { id: "2", name: "b@x" },
              ],
              enumeration: true,
              enumerationMessage: null,
            }),
          );
        if (url.includes("/labels")) {
          const name = url.includes("a%40x") ? "a@x" : "b@x";
          let d = labels.get(name);
          if (!d) {
            d = deferred();
            labels.set(name, d);
          }
          return d.promise;
        }
        return Promise.resolve(json({}));
      }),
    );

    await act(async () => {
      root.render(<GroupLabels />);
    });
    await act(async () => {
      await flush();
    });

    const select = host.querySelector<HTMLSelectElement>("select");
    expect(select, "the group picker is rendered").toBeTruthy();

    await choose(select!, "a@x");
    await choose(select!, "b@x");

    await act(async () => {
      labels.get("b@x")!.resolve(json({ labels: [{ keyword: "$b", name: "Bee" }] }));
      await flush();
    });
    expect(host.textContent).toContain("Bee");

    // The first read lands last: it belongs to `a@x` and is dropped.
    await act(async () => {
      labels.get("a@x")!.resolve(json({ labels: [{ keyword: "$a", name: "Aye" }] }));
      await flush();
    });
    expect(host.textContent).toContain("Bee");
    expect(host.textContent).not.toContain("Aye");
  });

  it("puts the catalogue back when a save fails, rather than leaving a lie on screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/admin/groups")
          return Promise.resolve(
            json({
              groups: [{ id: "1", name: "a@x" }],
              enumeration: true,
              enumerationMessage: null,
            }),
          );
        if (url.includes("/labels") && init?.method === "POST")
          return Promise.resolve(json({ message: "catalogue refused" }, 500));
        if (url.includes("/labels"))
          return Promise.resolve(json({ labels: [{ keyword: "$a", name: "Aye" }] }));
        return Promise.resolve(json({}));
      }),
    );

    await act(async () => {
      root.render(<GroupLabels />);
    });
    await act(async () => {
      await flush();
    });

    const select = host.querySelector<HTMLSelectElement>("select")!;
    await choose(select, "a@x");
    await act(async () => {
      await flush();
    });
    expect(host.textContent).toContain("Aye");

    // Rename it: the optimistic catalogue goes up, and the server refuses it.
    const title = [...host.querySelectorAll("h3")].find((el) =>
      (el.textContent ?? "").includes("Aye"),
    );
    expect(title).toBeTruthy();
    await act(async () => {
      title!.click();
    });
    const input = host.querySelector<HTMLInputElement>("input.sm");
    expect(input).toBeTruthy();
    await act(async () => {
      input!.value = "Renamed";
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      await flush();
    });

    expect(host.textContent).toContain("Aye");
    expect(host.textContent).not.toContain("Renamed");
    expect(host.textContent).toContain("catalogue refused");
  });

  it("keeps the account the administrator is on, not the one whose read was slower", async () => {
    const people = new Map<string, ReturnType<typeof deferred>>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url === "/api/admin/users")
          return Promise.resolve(
            json({
              users: [],
              enumeration: false,
              enumerationMessage: null,
              impersonation: "ok",
            }),
          );
        if (url.includes("/api/admin/identities/user")) {
          const who = url.includes("a%40x") ? "a@x" : "b@x";
          let d = people.get(who);
          if (!d) {
            d = deferred();
            people.set(who, d);
          }
          return d.promise;
        }
        return Promise.resolve(json({}));
      }),
    );

    await act(async () => {
      root.render(<UserIdentities />);
    });
    await act(async () => {
      await flush();
    });

    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Account address"]',
    );
    expect(input, "the account field is rendered").toBeTruthy();

    const enter = async (value: string) => {
      await act(async () => {
        input!.value = value;
        input!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
    };

    await enter("a@x");
    await enter("b@x");

    await act(async () => {
      people.get("b@x")!.resolve(
        json({
          address: "b@x",
          locked: false,
          lockUnknownReason: null,
          impersonation: "ok",
          identities: [identity("ib", "bee@x", "bee@x")],
          defaultIdentityId: null,
        }),
      );
      await flush();
    });
    expect(host.textContent).toContain("bee@x");

    await act(async () => {
      people.get("a@x")!.resolve(
        json({
          address: "a@x",
          locked: false,
          lockUnknownReason: null,
          impersonation: "ok",
          identities: [identity("ia", "ay@x", "ay@x")],
          defaultIdentityId: null,
        }),
      );
      await flush();
    });
    expect(host.textContent).toContain("bee@x");
    expect(host.textContent).not.toContain("ay@x");
  });
});
