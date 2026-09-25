import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushTwice as flush } from "@/test/testkit";
import { AdminUsers } from "../AdminUsers";
import { GroupLabels } from "../GroupLabels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The order the administration lists accounts and group mailboxes in.
 *
 * The address is the key a person reads a list by, so a server answer that
 * arrives in another order is not the order the surface shows: the directory is
 * sorted once, where it is read, and every surface lists the sorted one. Each
 * test below hands the stub an answer out of order, so a surface that stopped
 * sorting would show it.
 */

/** The shape `apiFetch` reads: JSON with a status. */
function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as Response;
}

describe("the order the administration lists its directory in", () => {
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

  async function render(node: ReactNode) {
    await act(async () => {
      root.render(node);
    });
    await act(async () => {
      await flush();
    });
  }

  it("lists the force-password accounts by address, whatever order the server answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        expect(String(input)).toBe("/api/admin/users");
        return json({
          users: [
            { id: "3", name: "carol@example.org", forced: false },
            { id: "1", name: "Alice@example.org", forced: true },
            { id: "2", name: "bob@example.org", forced: false },
          ],
          enumeration: true,
          enumerationMessage: null,
          impersonation: "ok",
        });
      }),
    );

    await render(<AdminUsers />);

    const listed = [
      ...host.querySelectorAll<HTMLElement>("tbody tr td:first-child code"),
    ].map((el) => el.textContent);
    expect(listed).toEqual(["Alice@example.org", "bob@example.org", "carol@example.org"]);
  });

  it("lists the group picker by address, whatever order the server answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        expect(String(input)).toBe("/api/admin/groups");
        return json({
          groups: [
            { id: "3", name: "zebra@example.org" },
            { id: "1", name: "Alpha@example.org" },
            { id: "2", name: "middle@example.org" },
          ],
          enumeration: true,
          enumerationMessage: null,
        });
      }),
    );

    await render(<GroupLabels />);

    const select = host.querySelector<HTMLSelectElement>("select");
    expect(select, "the group picker is rendered").toBeTruthy();
    // The first entry is the empty "Choose a group…"; the rest are the groups.
    const options = [...(select?.options ?? [])].map((o) => o.value).slice(1);
    expect(options).toEqual([
      "Alpha@example.org",
      "middle@example.org",
      "zebra@example.org",
    ]);
  });
});
