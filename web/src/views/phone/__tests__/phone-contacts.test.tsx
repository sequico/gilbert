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
 * The dialer's contacts pane lists **every** contact (ADR 0023): the ones with a
 * number offer a call, and one with none is still listed and searchable. That is
 * how a group's members — whose cards often carry no phone — stop being silently
 * dropped from the phone, which is the bug this pins.
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

/** A group card, with a number only when one is passed. */
function card(id: string, name: string, number?: string): ContactCard {
  const phones: ContactCard["phones"] = number ? { p1: { number } } : {};
  return {
    id,
    uid: id,
    addressBookIds: { gab: true },
    name: { full: name },
    emails: { e1: { address: `${id}@example.org` } },
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
        [`${GROUP}:callable`]: card("callable", "Grace Hopper", "+1 555 0101"),
        [`${GROUP}:member`]: card("member", "Marie Curie"),
      },
    });
    useMail.setState({
      mailAccounts: [{ accountId: GROUP, name: "Team", kind: "group" }],
    });
    usePhone.setState({ ready: true, state: "registered" });
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
    usePhone.setState({ ready: false, state: "off" });
  });

  it("lists a member with no number, and dials only where there is one", () => {
    act(() => root.render(<PhoneContactsPanel />));
    expect(host.querySelectorAll(".phone-contact")).toHaveLength(2);
    expect(host.textContent).toContain("Grace Hopper");
    expect(host.textContent).toContain("Marie Curie");
    // One call target only: Marie's row carries no number to press.
    expect(host.querySelectorAll(".phone-contact-number")).toHaveLength(1);
  });

  it("finds a numberless member by name", () => {
    act(() => root.render(<PhoneContactsPanel />));
    const input = host.querySelector<HTMLInputElement>(".phone-search input");
    expect(input).not.toBeNull();
    act(() => type(input!, "marie"));
    expect(host.querySelectorAll(".phone-contact")).toHaveLength(1);
    expect(host.textContent).toContain("Marie Curie");
  });

  it("names the two line states as the phone's own connections", () => {
    act(() => root.render(<PhoneContactsPanel />));
    expect(host.textContent).toContain("Gilbert phone connection");
    expect(host.textContent).toContain("SIP server connection");
  });
});
