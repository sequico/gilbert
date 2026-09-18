import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@/jmap/types";
import { flushTwice as flush, identity } from "@/test/testkit";
import { GroupIdentities } from "../GroupIdentities";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Who the administration says sends as what in a group (ADR 0007).
 *
 * A group's account holds one identity per member, all carrying the group's own
 * address, and the fact that binds a member to one is an **assignment this
 * surface writes**: a member address mapped to an id of that group, in the
 * group's own app folder, written in the same action as the identity. It is not
 * a display name compared on both sides — a name is what a recipient reads, and
 * a binding kept in one fails on a rename, on a spelling and on a name nobody
 * ever set.
 *
 * Three rules follow, and each test fails when its own is taken away:
 *
 *   - assigned is a **fact the row reads**: an assignment says `Sends as …`, and
 *     a member with none says so and is offered one;
 *   - the identity's **address is not the key**: a member's identity is one of
 *     this group's own, whatever it is called;
 *   - the **group's own** identity is a state and not a leftover: it is what a
 *     member with no assignment sends as, and the surface says so.
 *
 * A fourth is about ordering: two groups asked for in one order can answer in
 * the other, and the panel reads the group's name and its answers as one thing.
 */

const GROUP = "team@example.org";
const ALICE = "alice@example.org";
const BOB = "bob@example.org";
const NOBODY = "nobody@example.org";

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
function person(address: string, name: string | null) {
  return {
    address,
    locked: false,
    lockUnknownReason: null,
    impersonation: "ok",
    identities: [identity("o1", name ?? "", address)],
    defaultIdentityId: null,
    groups: [],
  };
}

/** A group's answer, in the shape the route gives it. */
function group(
  name: string,
  identities: Identity[],
  members: string[] | null,
  assignments: Record<string, string> = {},
  groupSenderId: string | null = null,
) {
  return { name, granted: true, identities, members, assignments, groupSenderId };
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
        /*
         * The member's own account says their name in lowercase — and for
         * `nobody@` it sets none at all, which is a state of its own.
         */
        const name = address.startsWith("nobody")
          ? null
          : address.startsWith("alice")
            ? "alice smith"
            : "Bob";
        return json(person(address, name));
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

  it("reads an assignment rather than a name, and offers one where there is none", async () => {
    await render();
    await openGroup(GROUP);
    held.get(GROUP)?.(
      group(
        GROUP,
        [identity("i1", "Team", GROUP), identity("i2", "Alice Smith", GROUP)],
        [ALICE, BOB],
        // Alice is assigned, Bob is not — and there is an identity carrying
        // Bob's own name, which is exactly what a binding by name would have
        // seized on.
        { [ALICE]: "i2" },
        "i1",
      ),
    );
    await act(async () => {
      await flush();
    });

    await openRow(ALICE);
    await openRow(BOB);

    // Assigned: the row says what she sends as, and offers no assignment.
    expect(row(ALICE).textContent).toContain(`Sends as Alice Smith <${GROUP}>`);
    expect(row(ALICE).textContent).not.toContain("Assign identity");
    // Not assigned: the row says so — even though an identity of this group
    // carries "Bob" — and offers one.
    expect(row(BOB).textContent).toContain("No identity is assigned to this member");
    expect(row(BOB).textContent).toContain("Assign identity");
    expect(row(BOB).textContent).not.toContain("Sends as");
  });

  it("offers no identity to create for a member whose own account has no display name", async () => {
    /*
     * The display name is what a recipient reads, so the form prefills with it —
     * but it is not the binding, and a member whose own account sets none can
     * still be assigned an identity here. The row offers it and the form opens
     * with an empty name rather than refusing.
     */
    await render();
    await openGroup(GROUP);
    held.get(GROUP)?.(group(GROUP, [identity("i1", "Team", GROUP)], [NOBODY], {}, "i1"));
    await act(async () => {
      await flush();
    });

    await openRow(NOBODY);

    expect(row(NOBODY).textContent).toContain("No identity is assigned to this member");
    expect(row(NOBODY).textContent).toContain("Assign identity");
  });

  it("marks the group's own identity as what an unassigned member sends as", async () => {
    /*
     * The middle step of the composer's cascade (ADR 0007), said where an
     * administrator can see it: an identity nobody is assigned is the group's own
     * voice, so a member with no identity of their own still writes as the group.
     */
    await render();
    await openGroup(GROUP);
    held.get(GROUP)?.(
      group(
        GROUP,
        [identity("i1", "Team", GROUP), identity("i2", "Alice Smith", GROUP)],
        [ALICE, BOB],
        { [ALICE]: "i2" },
        "i1",
      ),
    );
    await act(async () => {
      await flush();
    });

    const text = host.textContent ?? "";
    expect(text).toContain("Not assigned to a member");
    expect(text).toContain("what a member with no identity of their own sends as");
    // The group's own is listed there, and the assigned identity is not.
    expect(text).toContain(`Team <${GROUP}>`);
  });

  it("says what an assigned group identity means", async () => {
    await render();
    await openGroup(GROUP);
    held.get(GROUP)?.(
      group(GROUP, [identity("i1", "Team", GROUP)], [ALICE], { [ALICE]: "i1" }, "i1"),
    );
    await act(async () => {
      await flush();
    });

    // Alice is assigned the group's own identity: her mail is the group's, and
    // the row says so rather than pretending it is a personal sender.
    expect(row(ALICE).textContent).toContain(`Sends as Team <${GROUP}>`);
    expect(row(ALICE).textContent).toContain("the group's own identity");
  });

  it("keeps an answer for a group the administrator has left", async () => {
    await render();
    await openGroup(GROUP);
    await openGroup(BOB);

    // The group asked for first answers last -- a slower read, not a later one.
    held.get(BOB)?.(group(BOB, [identity("b1", "Bob", BOB)], [BOB], {}, "b1"));
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
