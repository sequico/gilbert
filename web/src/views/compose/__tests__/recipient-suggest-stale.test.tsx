import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useContacts } from "@/store/contacts";
import { RecipientInput } from "../RecipientInput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A suggestion that lands after the field was emptied (finding 7).
 *
 * The suggestion is asked for on a debounce and answers later. Emptying the
 * field must invalidate whatever is in flight, or the answer reopens the
 * dropdown over an input the reader has cleared.
 */

const type = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
    .set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("RecipientInput suggestions", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("does not reopen the dropdown when a stale suggestion lands on an empty field", async () => {
    let resolveSuggest!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolveSuggest = r;
    });
    useContacts.setState({ suggest: (() => pending) as never });

    await act(async () => {
      root.render(<RecipientInput value={[]} onChange={() => {}} placeholder="To" />);
    });
    const input = host.querySelector<HTMLInputElement>("input")!;

    await act(async () => {
      type(input, "ann");
    });
    // The debounce fires and the suggestion is asked for.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 160));
    });

    // The field is cleared while the answer is still in flight.
    await act(async () => {
      type(input, "");
    });
    await act(async () => {
      resolveSuggest([
        { name: "Ann", email: "ann@x", source: "recent", contactId: "c1" },
      ]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(document.querySelector(".suggest-list")).toBeNull();
  });
});
