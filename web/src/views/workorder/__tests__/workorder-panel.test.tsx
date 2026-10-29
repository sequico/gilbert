import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkorderCreateInput, WorkorderListEntry } from "@/lib/workorder";
import { useWorkorders } from "@/store/workorder";
import { WorkorderPanel } from "../WorkorderPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The workorder panel, drawn from a state the test hands it — and the creation
 * form on top of it.
 *
 * The panel is a surface an administrator uses to start work, so what it is
 * pinned to is the **path through the form**: the templates offered are the
 * ones a workorder may bind (a checklist with a revision in force, and nothing
 * else), choosing one draws its rules, the button waits for every answer, and a
 * create that the door refused leaves the form open with the answers still in
 * it. Nothing here reaches a server: the store is set, and the two calls the
 * form makes are answered by the test.
 */

const createWorkorder = vi.fn<(input: WorkorderCreateInput) => Promise<unknown>>();
vi.mock("@/lib/workorder", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/workorder")>("@/lib/workorder");
  return {
    ...actual,
    createWorkorder: (input: WorkorderCreateInput) => createWorkorder(input),
    listWorkorders: async () => [],
    readWorkorder: async () => null,
    checkWorkorderStep: async () => null,
    closeWorkorder: async () => null,
    replaceWorkorder: async () => null,
  };
});

/** The rules a chosen template answers with: one variant, one section, one step. */
const rules = {
  variants: [
    {
      key: "company",
      label: "Company",
      values: [
        { value: "north", label: "North" },
        { value: "south", label: "South" },
      ],
    },
  ],
  sections: [
    { key: "deposit", label: "Deposit", steps: [{ key: "load", label: "Load" }] },
  ],
};

vi.mock("@/store/knowledge", () => ({
  useKnowledge: {
    getState: () => ({
      loaded: true,
      load: async () => {},
      tiers: [
        {
          scope: "company",
          accountId: "acct-1",
          group: null,
          canApprove: true,
          canEdit: true,
          articles: [
            {
              id: "art-1",
              nodeId: "node-1",
              folder: "deposit-process",
              title: "Deposit process",
              template: "checklist",
              inForce: { revision: "rev-1", rev: 1 },
              pending: null,
            },
            {
              id: "art-2",
              nodeId: "node-2",
              folder: "handbook",
              title: "Handbook",
              template: null,
              inForce: { revision: "rev-2", rev: 1 },
              pending: null,
            },
          ],
        },
      ],
    }),
  },
}));

vi.mock("@/lib/knowledge", () => ({
  revisionInForceAt: (article: { inForce: unknown }) => article.inForce,
  companyRevision: async () => ({ checklist: rules }),
  readArticleRevision: async () => ({ checklist: rules }),
}));

const entry: WorkorderListEntry = {
  uid: "wo-1",
  name: "BK-42 deposit",
  state: "running",
  parts: [
    {
      scope: "global",
      accountId: null,
      group: null,
      template: { accountId: "acct-1", id: "art-1", revision: "rev-1" },
      templateTitle: "Deposit process",
      templateRev: 1,
      complete: 1,
      total: 2,
    },
  ],
  updated: { by: "ada@example.org", at: "2026-11-03T09:00:00.000Z" },
  canAdminister: true,
};

describe("the workorder panel", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    /*
     * The panel asks how wide the screen is (`useIsNarrow`), and jsdom has no
     * `matchMedia`: one stub answers "wide", which is the layout the list and
     * the dialog are drawn in.
     */
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    createWorkorder.mockReset();
    useWorkorders.setState({
      workorders: [entry],
      loaded: true,
      loading: false,
      error: null,
      openUid: null,
      detail: null,
      detailLoading: false,
      panelOpen: true,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.querySelectorAll(".toast").forEach((node) => node.remove());
  });

  const render = async () => {
    await act(async () => {
      root.render(<WorkorderPanel />);
    });
  };
  const click = async (el: Element) => {
    await act(async () => {
      // `click()` runs jsdom's activation behaviour, which is what submits a
      // form: a dispatched MouseEvent would draw the press and do nothing.
      (el as HTMLElement).click();
    });
  };
  const type = async (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    await act(async () => {
      const proto =
        el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
      el.dispatchEvent(
        new Event(el instanceof HTMLSelectElement ? "change" : "input", {
          bubbles: true,
        }),
      );
    });
  };
  const dialog = () =>
    document.querySelector('[role="dialog"][aria-label="New workorder"]');
  const button = (name: string) =>
    [...document.querySelectorAll("button")].find(
      (one) =>
        one.getAttribute("aria-label") === name || one.textContent?.trim() === name,
    );
  /** The form's submit, which the panel disables until every answer is given. */
  const create = () => button("Create") as HTMLButtonElement | undefined;

  it("draws the list it was given, with each part's progress", async () => {
    await render();
    const body = document.body.textContent ?? "";
    expect(body).toContain("BK-42 deposit");
    expect(body).toContain("1/2");
  });

  it("offers only the templates a workorder may bind", async () => {
    await render();
    await click(button("New workorder")!);
    expect(dialog()).not.toBeNull();
    const options = [
      ...document.querySelectorAll<HTMLOptionElement>("#workorder-template option"),
    ];
    expect(options.map((one) => one.textContent)).toEqual([
      "Select a template",
      "Deposit process",
    ]);
  });

  it("draws the chosen template's rules and waits for every answer", async () => {
    await render();
    await click(button("New workorder")!);
    expect(create()?.disabled, "nothing to create yet").toBe(true);

    await type(document.querySelector<HTMLInputElement>("#workorder-name")!, "Deposit 1");
    await type(
      document.querySelector<HTMLSelectElement>("#workorder-template")!,
      "acct-1:art-1",
    );

    const variant = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Company"]',
    );
    expect(variant, "the template's variant is drawn once its rules land").not.toBeNull();
    expect(create()?.disabled, "a variant still has no value").toBe(true);

    await type(variant!, "north");
    expect(create()?.disabled).toBe(false);
  });

  it("creates with the template it showed and the answers it took", async () => {
    await render();
    await click(button("New workorder")!);
    await type(document.querySelector<HTMLInputElement>("#workorder-name")!, "Deposit 1");
    await type(
      document.querySelector<HTMLSelectElement>("#workorder-template")!,
      "acct-1:art-1",
    );
    await type(
      document.querySelector<HTMLSelectElement>('select[aria-label="Company"]')!,
      "north",
    );

    createWorkorder.mockResolvedValueOnce({
      uid: "wo-2",
      name: "Deposit 1",
      state: "running",
      parts: [
        {
          scope: "global",
          accountId: null,
          group: null,
          checklist: {
            template: { accountId: "acct-1", id: "art-1", revision: "rev-1" },
            variants: { company: "north" },
            items: {},
            steps: [],
          },
          groups: [],
          templateTitle: "Deposit process",
          templateRev: 1,
          canCheck: true,
        },
      ],
      refs: [],
      created: { by: "ada@example.org", at: "2026-11-03T09:00:00.000Z" },
      updated: { by: "ada@example.org", at: "2026-11-03T09:00:00.000Z" },
      replacedBy: null,
      canAdminister: true,
    });
    await click(button("Create")!);

    expect(createWorkorder).toHaveBeenCalledWith({
      name: "Deposit 1",
      template: { accountId: "acct-1", id: "art-1", revision: "rev-1" },
      variants: { company: "north" },
      items: {},
    });
    expect(dialog(), "a create that landed puts the form away").toBeNull();
  });

  it("keeps the form and its answers when the door refuses", async () => {
    await render();
    await click(button("New workorder")!);
    await type(document.querySelector<HTMLInputElement>("#workorder-name")!, "Deposit 1");
    await type(
      document.querySelector<HTMLSelectElement>("#workorder-template")!,
      "acct-1:art-1",
    );
    await type(
      document.querySelector<HTMLSelectElement>('select[aria-label="Company"]')!,
      "north",
    );

    createWorkorder.mockRejectedValueOnce(new Error("the template was retired"));
    await click(button("Create")!);

    expect(dialog()).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>("#workorder-name")?.value).toBe(
      "Deposit 1",
    );
    expect(useWorkorders.getState().error).toBe("the template was retired");
  });
});
