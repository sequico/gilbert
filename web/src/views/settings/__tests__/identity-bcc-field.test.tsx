import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Identity } from "@/jmap/types";
import { IdentityDialog } from "../IdentityDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Bcc field of the identity form, and the one thing it must not do.
 *
 * The form is the same object for a person's own identities and for the
 * administration's two tabs (ADR 0007), so a field missing here is a field
 * missing everywhere — and this one is worse than missing. A save that built
 * its patch without `bcc` would write `null` over an address somebody had set:
 * the identity would come back carrying nothing, and nothing would say so.
 *
 * The test fails when the field goes away or the patch stops carrying it, which
 * is exactly the shape of that bug.
 */

const ARCHIVE = { name: null, email: "archive@example.org" };

const identity = (over: Partial<Identity> = {}): Identity =>
  ({
    id: "i1",
    name: "John",
    email: "john@example.org",
    replyTo: null,
    bcc: [ARCHIVE],
    textSignature: "",
    htmlSignature: "",
    mayDelete: true,
    ...over,
  }) as Identity;

/** The input under the label with this text, as the form draws the pair. */
function field(label: string): HTMLInputElement {
  const blocks = Array.from(document.body.querySelectorAll(".field"));
  for (const block of blocks) {
    if (block.querySelector("label")?.textContent === label) {
      const input = block.querySelector("input");
      if (input) return input;
    }
  }
  throw new Error(`no field labelled ${label}`);
}

const saveButton = (): HTMLButtonElement => {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const save = buttons.find((b) => b.textContent?.trim() === "Save");
  if (!save) throw new Error("no Save button");
  return save as HTMLButtonElement;
};

/** What React's `onChange` sees when a character is typed. */
const type = (el: HTMLInputElement, value: string) => {
  act(() => {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
      .set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("the identity form's Bcc field", () => {
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
    document.body.innerHTML = "";
  });

  const render = async (
    value: Partial<Identity>,
    save: (patch: Partial<Identity>) => Promise<void>,
  ) => {
    await act(async () => {
      root.render(
        <IdentityDialog identity={value} onClose={() => undefined} save={save} />,
      );
    });
  };

  it("opens at the identity's own address", async () => {
    await render(identity(), async () => undefined);
    expect(field("Bcc (optional)").value).toBe(ARCHIVE.email);
  });

  it("is empty when the identity carries none", async () => {
    await render(identity({ bcc: null }), async () => undefined);
    expect(field("Bcc (optional)").value).toBe("");
  });

  /*
   * Saving writes the address back. Without it in the patch, an edit to any
   * other field would clear the Bcc — and the only sign would be a copy that
   * stopped arriving.
   */
  it("keeps the address through a save that did not touch it", async () => {
    let written: Partial<Identity> | null = null;
    await render(identity(), async (patch) => {
      written = patch;
    });
    type(field("Display name"), "Johnny");
    await act(async () => {
      saveButton().click();
    });
    expect(written!.bcc).toEqual([ARCHIVE]);
  });

  it("saves a list typed into it", async () => {
    let written: Partial<Identity> | null = null;
    await render(identity({ bcc: null }), async (patch) => {
      written = patch;
    });
    type(field("Bcc (optional)"), "a@example.org, B <b@example.org>");
    await act(async () => {
      saveButton().click();
    });
    expect(written!.bcc).toEqual([
      { name: null, email: "a@example.org" },
      { name: "B", email: "b@example.org" },
    ]);
  });

  it("saves no address when it is cleared", async () => {
    let written: Partial<Identity> | null = null;
    await render(identity(), async (patch) => {
      written = patch;
    });
    type(field("Bcc (optional)"), "");
    await act(async () => {
      saveButton().click();
    });
    expect(written!.bcc).toBeNull();
  });

  /*
   * A form nobody has touched has nothing to save, and the button says so. The
   * field counts as part of that: typing in Bcc alone is a change.
   */
  it("counts a typed address as a change worth saving", async () => {
    await render(identity({ bcc: null }), async () => undefined);
    expect(saveButton().disabled).toBe(true);
    type(field("Bcc (optional)"), "archive@example.org");
    expect(saveButton().disabled).toBe(false);
  });
});
