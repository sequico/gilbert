import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedContent } from "@/lib/shareTarget";
import { ConfirmHost } from "@/ui/dialog";
import { offerShare } from "../ShareOffer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A share becomes a message only when the reader says so.
 *
 * The share endpoint takes a plain form POST, which any page can make, so
 * arriving content is not evidence that the reader sent it. Nothing would be
 * sent without Send being pressed, but a composer that opens already full of
 * somebody else's text and files is the wrong thing to do without asking.
 */

const share: SharedContent = {
  title: "Quarterly figures",
  text: "Have a look at these before Friday",
  url: "https://example.com/q3",
  files: [new File(["x"], "q3.xlsx"), new File(["y"], "notes.txt")],
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<ConfirmHost />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

describe("offering a share", () => {
  it("shows what arrived before anything is opened", async () => {
    const open = vi.fn();
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = offerShare(share, open);
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Start a new message with what was shared?");
    expect(text).toContain("Quarterly figures");
    expect(text).toContain("Have a look at these before Friday https://example.com/q3");
    expect(text).toContain("q3.xlsx");
    expect(text).toContain("notes.txt");
    // Nothing is opened until the reader answers.
    expect(open).not.toHaveBeenCalled();

    await act(async () => button("Start a message")!.click());
    expect(await pending).toBe(true);
    expect(open).toHaveBeenCalledWith(share);
  });

  it("opens nothing when discarded", async () => {
    const open = vi.fn();
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = offerShare(share, open);
    });
    await act(async () => button("Discard")!.click());
    expect(await pending).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  /*
   * The borrowed text is the sender's, in the sender's language: a browser that
   * machine-translates the blockquote would show the reader something other
   * than what was shared.
   */
  it("marks the borrowed parts as not to be translated", async () => {
    await act(async () => {
      void offerShare(share, vi.fn());
    });
    const borrowed = document.querySelectorAll('[translate="no"]');
    expect(borrowed.length).toBeGreaterThan(0);
    for (const el of borrowed) expect(el.className).toContain("notranslate");
  });
});
