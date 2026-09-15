import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRule } from "@/lib/sieve";
import { RuleDialog } from "../RuleDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Choosing "Other header…" must leave the comparator where it is: putting the
 * header-name box in the comparator's column makes the comparator vanish, and
 * whatever it happens to be (contains) is what you are stuck with. Both belong
 * in the row.
 */
describe("RuleDialog custom headers", () => {
  let host: HTMLDivElement;
  let root: Root;

  /** The condition row's own selects: [field, comparator]. */
  const selects = () =>
    Array.from(
      document.querySelectorAll<HTMLSelectElement>(".rule-row:not(.actions) select"),
    );
  const find = (sel: string) => document.querySelector(sel);
  const pick = (el: HTMLSelectElement, value: string) =>
    act(() => {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = () =>
    act(() => {
      root.render(
        <RuleDialog
          rule={newRule({ id: "r1" })}
          onClose={() => undefined}
          onSave={() => undefined}
        />,
      );
    });

  it("keeps the comparator when a header is typed by hand", () => {
    render();
    // [field, comparator] — the rule starts on "from contains".
    expect(selects()).toHaveLength(2);
    pick(selects()[0]!, "__custom__");

    const header = find('input[aria-label="Header name"]') as HTMLInputElement | null;
    expect(header).not.toBeNull();
    expect(header!.value).toBe("");
    const ops = selects()[1]!;
    expect(ops.value).toBe("contains");
    expect(Array.from(ops.options).map((o) => o.value)).toContain("matches");

    pick(ops, "matches");
    expect(selects()[1]!.value).toBe("matches");
    // The header box is still there, and still has a column of its own.
    expect(find('input[aria-label="Header name"]')).not.toBeNull();
    expect(find(".rule-row.named-header")).not.toBeNull();
  });

  it("leaves a listed header alone", () => {
    render();
    expect(find('input[aria-label="Header name"]')).toBeNull();
    expect(find(".rule-row.named-header")).toBeNull();
    pick(selects()[1]!, "is");
    expect(selects()[1]!.value).toBe("is");
  });
});

/**
 * Why a rule will not save.
 *
 * A forward address that is no address turns the field red, and Save goes off
 * with it -- and while only the colour said so the outcome was a dead button.
 * A control the reader cannot use has to say what would let them use it, so the
 * field carries the reason beside it and the address it wants is named.
 */
describe("RuleDialog's disabled Save states its reason", () => {
  let host: HTMLDivElement;
  let root: Root;

  const find = <T extends Element>(sel: string) => document.querySelector<T>(sel);
  /** The first select of the action row: the kind of action. */
  const action = () => find<HTMLSelectElement>(".rule-row.actions select")!;
  const address = () => find<HTMLInputElement>('.rule-row.actions input[type="email"]');
  const reason = () => find(".rule-row.actions .hint")?.textContent ?? "";
  /** The dialog's own primary button, which here means Save. */
  const save = () => find<HTMLButtonElement>("button.btn-primary")!;
  /** The rule's name box: the first `.input` the dialog draws. */
  const nameField = () => find<HTMLInputElement>("input.input")!;

  const pick = (el: HTMLSelectElement, value: string) =>
    act(() => {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const type = (el: HTMLInputElement, value: string) => {
    act(() => {
      el.focus();
      // What React's onChange sees when a character is typed.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <RuleDialog
          rule={newRule({ id: "r1" })}
          onClose={() => undefined}
          onSave={() => undefined}
        />,
      );
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("leaves a finished rule saveable, with nothing to explain", () => {
    expect(save().disabled).toBe(false);
    expect(reason()).toBe("");
  });

  it("names the address a forward has not been given yet", () => {
    pick(action(), "redirect");
    expect(address()).not.toBeNull();
    expect(address()!.value).toBe("");
    expect(save().disabled).toBe(true);
    expect(reason()).toContain("Give the address to forward to");
  });

  it("says what is wrong with an address that is not one", () => {
    pick(action(), "redirect");
    type(address()!, "not-an-address");
    expect(address()!.className).toContain("invalid");
    expect(save().disabled).toBe(true);
    expect(reason()).toContain("not an email address");
  });

  it("drops the reason and saves once the address is one", () => {
    pick(action(), "redirect");
    type(address()!, "someone@example.com");
    expect(save().disabled).toBe(false);
    expect(reason()).toBe("");
  });

  it("says why Save is off for a rule with no name", () => {
    type(nameField(), "");
    expect(save().disabled).toBe(true);
    const hints = [...document.querySelectorAll(".hint")]
      .map((n) => n.textContent ?? "")
      .join(" | ");
    expect(hints).toContain("Give the rule a name before it can be saved");
  });
});
