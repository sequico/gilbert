import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@/jmap/types";
import { GroupIdentities } from "../GroupIdentities";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Which of a group's identities the administration shows as a member's own.
 *
 * The group's account holds one identity per member (ADR 0007), each carrying
 * the group's own address and that member's own display name. The name is read
 * from the member's own account — one impersonation, when their row is opened —
 * and the identity carrying it is theirs; everything else stays in Unassigned.
 *
 * Two rules decide a binding, and each test fails when its own is taken away:
 *
 *   - the two names are folded together (`displayNameKey`, the same folding the
 *     composer's picker uses), so a member whose own account spells their name
 *     differently from the identity written here is still bound to it
 *   - the identity has to carry the **group's own address**: one written with
 *     some other address is not what this member sends from in this group, and
 *     binding it would put an address into "Sends as" that the group cannot send
 *     from at all
 *
 * A third rule is about ordering rather than matching: two groups asked for in
 * one order can answer in the other, and the panel reads the name of the group
 * and the group's identities as one thing — a write made from it takes both.
 */

const GROUP = "team@example.org";
const OTHER = "alias@example.net";
const ALICE = "alice@example.org";
const BOB = "bob@example.org";

const identity = (id: string, name: string, email: string): Identity =>
  ({
    id,
    name,
    email,
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: true,
  }) as Identity;

const flush = async () => {
  await new Promise<void>((res) => setTimeout(res, 0));
  await new Promise<void>((res) => setTimeout(res, 0));
};

/** The shape `apiFetch` reads: JSON with a status. */
function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as Response;
}

/** A person's own account, as the group tab reads it when their row is opened. */
function person(address: string, name: string) {
  return {
    address,
    locked: false,
    lockUnknownReason: null,
    impersonation: "ok",
    identities: [identity("o1", name, address)],
    defaultIdentityId: null,
    groups: [],
  };
}

/** A group's answer, in the shape the route gives it. */
function group(name: string, identities: Identity[], members: string[] | null) {
  return { name, granted: true, identities, members };
}

describe("the group identities tab", () => {
  let host: HTMLDivElement;
  let root: Root;

  /** The group reads the stub is holding, by group name. */
  let held: Map<string, (value: unknown) => void>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    held = new Map();
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("/api/admin/groups")) {
        // No server-administrator privilege: the tab takes a typed address, so
        // the test drives the same field an administrator would.
        return json({ groups: [], enumeration: false });
      }
      if (url.startsWith("/api/admin/identities/user")) {
        const address =
          new URL(url, "http://localhost").searchParams.get("address") ?? "";
        // The member's own account says their name in lowercase.
        return json(person(address, address.startsWith("alice") ? "alice smith" : "Bob"));
      }
      const name = new URL(url, "http://localhost").searchParams.get("name") ?? "";
      return json(await new Promise((resolve) => held.set(name, resolve)));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => root.unmount());
    host.remove();
  });

  /** Render the tab and let its directory read settle. */
  async function render() {
    await act(async () => {
      root.render(<GroupIdentities />);
    });
    await act(async () => {
      await flush();
    });
  }

  function groupField(): HTMLInputElement {
    const field = host.querySelector<HTMLInputElement>("#identity-group");
    if (!field) throw new Error("the group field is not rendered");
    return field;
  }

  /** Ask for a group, the way typing an address and pressing Enter does. */
  async function openGroup(name: string) {
    await act(async () => {
      const field = groupField();
      field.value = name;
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      await flush();
    });
  }

  /** The card of one roster member, by the address it is headed with. */
  function row(address: string): HTMLElement {
    const card = [...host.querySelectorAll<HTMLElement>(".card")].find(
      (el) => el.querySelector("h3")?.textContent === address,
    );
    if (!card) throw new Error(`no row for ${address}`);
    return card;
  }

  /** Open a row, which is what reads the member's own account. */
  async function openRow(address: string) {
    await act(async () => {
      row(address).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await flush();
    });
  }

  it("binds a name the two accounts spell differently, and only on the group's address", async () => {
    await render();
    await openGroup(GROUP);
    held.get(GROUP)?.(
      group(
        GROUP,
        [
          identity("i1", "Alice Smith", GROUP),
          // Carries a name a member's own account has, on an address that is
          // not this group's: nothing here sends from it.
          identity("i2", "Bob", OTHER),
        ],
        [ALICE, BOB],
      ),
    );
    await act(async () => {
      await flush();
    });

    await openRow(ALICE);
    await openRow(BOB);

    // "Alice Smith" against "alice smith": bound, so the row says what she
    // sends as rather than offering a second identity of that name.
    expect(row(ALICE).textContent).toContain(`Sends as Alice Smith <${GROUP}>`);
    expect(row(ALICE).textContent).not.toContain("Set identity");
    // Bob's own account says "Bob", and the identity carrying that name is not
    // on this group's address, so it is nobody's: his row offers to set one and
    // the identity stays listed under Unassigned, where an address that is not
    // the group's can be seen and fixed.
    expect(row(BOB).textContent).not.toContain("Sends as");
    expect(row(BOB).textContent).toContain("Set identity");
    expect(host.textContent).toContain(`Bob <${OTHER}>`);
  });

  it("keeps an answer for a group the administrator has left", async () => {
    await render();
    await openGroup(GROUP);
    await openGroup(BOB);

    // The group asked for first answers last -- a slower read, not a later one.
    held.get(BOB)?.(group(BOB, [identity("b1", "Bob", BOB)], [BOB]));
    await act(async () => {
      await flush();
    });
    held.get(GROUP)?.(group(GROUP, [identity("i1", "Alice Smith", GROUP)], [ALICE]));
    await act(async () => {
      await flush();
    });

    // The panel is the group in the field: its identities, and its roster.
    expect(groupField().value).toBe(BOB);
    expect(host.textContent).toContain("Bob");
    expect(host.textContent).not.toContain("Alice Smith");
  });
});
