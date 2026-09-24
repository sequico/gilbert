import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { type SharedBook, useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { usePhone } from "@/store/phone";
import { PhoneContactsPanel } from "../PhoneContactsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The dialer's contacts pane offers a contact only when it can be called: one
 * that carries at least one number. A member with no number is not a row, so a
 * search that does not match a callable contact finds nothing — which is the
 * dialer's contract, not Contacts'.
 */

const GROUP = "team";
const OWN = "own";

const book: SharedBook = {
  accountId: GROUP,
  accountName: "Team",
  book: {
    id: "gab",
    name: "Team directory",
    isDefault: true,
    myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
  } as AddressBook,
};

/** A group card, with a number and a company only when passed. */
function card(id: string, name: string, number?: string, company?: string): ContactCard {
  const phones: ContactCard["phones"] = number ? { p1: { number } } : {};
  return {
    id,
    uid: id,
    addressBookIds: { gab: true },
    name: { full: name },
    emails: { e1: { address: `${id}@example.org` } },
    organizations: company ? { o1: { name: company } } : undefined,
    phones,
  } as ContactCard;
}

/** Set a controlled input the way a keystroke does. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the dialer's contacts pane", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useContacts.setState({
      accountId: OWN,
      cards: {},
      sharedBooks: [book],
      sharedCards: {
        [`${GROUP}:callable`]: card(
          "callable",
          "Grace Hopper",
          "+1 555 0101",
          "Example Corp",
        ),
        [`${GROUP}:member`]: card("member", "Marie Curie"),
      },
    });
    useMail.setState({
      mailAccounts: [{ accountId: GROUP, name: "Team", kind: "group" }],
    });
    usePhone.setState({ ready: true, bridge: true, state: "registered" });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useContacts.setState({
      accountId: null,
      cards: {},
      sharedBooks: [],
      sharedCards: {},
    });
    useMail.setState({ mailAccounts: [] });
    usePhone.setState({ ready: false, bridge: false, state: "off" });
  });

  it("lists only a contact that carries a number", () => {
    act(() => root.render(<PhoneContactsPanel />));
    expect(host.querySelectorAll(".phone-contact")).toHaveLength(1);
    expect(host.textContent).toContain("Grace Hopper");
    expect(host.querySelectorAll(".phone-contact-number")).toHaveLength(1);
    expect(host.textContent).not.toContain("Marie Curie");
  });

  it("finds a callable contact by name, and a numberless one not at all", () => {
    act(() => root.render(<PhoneContactsPanel />));
    const input = host.querySelector<HTMLInputElement>(".phone-search input");
    expect(input).not.toBeNull();
    act(() => type(input!, "grace"));
    expect(host.textContent).toContain("Grace Hopper");
    act(() => type(input!, "marie"));
    expect(host.querySelectorAll(".phone-contact")).toHaveLength(0);
  });

  it("shows the company under the name, in small", () => {
    act(() => root.render(<PhoneContactsPanel />));
    expect(host.querySelector(".phone-contact-company")?.textContent).toBe(
      "Example Corp",
    );
  });

  it("names the two line states as the phone's own connections", () => {
    act(() => root.render(<PhoneContactsPanel />));
    expect(host.textContent).toContain("Gilbert phone connection");
    expect(host.textContent).toContain("SIP server connection");
  });

  it("keeps both dots true in real time, red and green", () => {
    usePhone.setState({ ready: true, bridge: false, state: "connecting" });
    act(() => root.render(<PhoneContactsPanel />));
    const dot = (i: number) => host.querySelectorAll(".phone-dot")[i]?.className;
    // The bridge is down and the line is not registered: both are red.
    expect(dot(0)).toContain("bad");
    expect(dot(1)).toContain("bad");
    // The socket returns and the line registers: both turn green.
    act(() => usePhone.setState({ bridge: true, state: "registered" }));
    expect(dot(0)).toContain("ok");
    expect(dot(1)).toContain("ok");
    // The line drops again: its dot is red while the bridge stays up.
    act(() => usePhone.setState({ state: "connecting" }));
    expect(dot(0)).toContain("ok");
    expect(dot(1)).toContain("bad");
  });
});
