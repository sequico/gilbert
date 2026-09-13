import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupInstruction } from "../GroupInstruction";
import { type AgentRuleDraft, RuleForm } from "../RuleForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The line beside a reading the month's authoring document did not take (ADR
 * 0010).
 *
 * The words are the model's and the tokens are already spent when the count is
 * written, so a failed count costs the installation's tally and never the
 * answer: the surface shows what came back and adds one sentence saying the
 * month recorded nothing. Both surfaces that show a reading say the same
 * sentence — the automation editor and the group's instruction — so both are
 * driven here, each with a count that landed and one that did not.
 */

const GROUP = "team@example.org";
const DRAFT = "Answer in Italian, and always cite the invoice number.";
const ANSWER = "It names the language, and never who reads the reply.";
const NOTE = "This reading was not counted toward this month's authoring.";

/** The draft the rule form edits, as the panel hands it one. */
function draft(overrides: Partial<AgentRuleDraft> = {}): AgentRuleDraft {
  return {
    v: 1,
    id: "r1",
    version: 1,
    name: "Label processed mail",
    enabled: true,
    trigger: { on: "email" },
    capabilities: ["keyword.add"],
    instruction: DRAFT,
    review: { mode: "always" },
    ...overrides,
  };
}

describe("the line a reading gets when the month did not count it", () => {
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

  /**
   * The two routes these surfaces reach: the group's instruction, which the
   * panel reads when it opens, and the reading, whose answer this file is about.
   * The count travels with the answer, which is the whole difference between the
   * cases below.
   */
  function stubApi(counted: boolean): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const answer =
          init?.method === "POST"
            ? { text: ANSWER, counted }
            : {
                text: DRAFT,
                notes: "",
                updatedAt: "2026-09-10T09:00:00.000Z",
                updatedBy: "demo@example.com",
                max: 4000,
                notesMax: 2000,
              };
        return { ok: true, status: 200, json: async () => answer } as Response;
      }),
    );
  }

  async function render(element: ReactElement): Promise<void> {
    await act(async () => {
      root.render(element);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** Ask for the reading, and let the answer land. */
  async function ask(): Promise<void> {
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Ask the model to read it",
    );
    expect(button, "the reading is offered").toBeTruthy();
    await act(async () => {
      button?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("says so under the answer the automation editor shows", async () => {
    stubApi(false);
    await render(
      <RuleForm rule={draft()} group={GROUP} catalogue={null} onChange={() => {}} />,
    );
    await ask();

    const text = host.textContent ?? "";
    expect(text).toContain(ANSWER);
    expect(text).toContain(NOTE);
  });

  it("says nothing beside an answer the month did record", async () => {
    stubApi(true);
    await render(
      <RuleForm rule={draft()} group={GROUP} catalogue={null} onChange={() => {}} />,
    );
    await ask();

    const text = host.textContent ?? "";
    expect(text).toContain(ANSWER);
    expect(text).not.toContain(NOTE);
  });

  it("says so under the answer the group's instruction shows", async () => {
    stubApi(false);
    await render(<GroupInstruction group={GROUP} />);
    await ask();

    const text = host.textContent ?? "";
    expect(text).toContain(ANSWER);
    expect(text).toContain(NOTE);
  });

  it("says nothing beside an answer the month did record there", async () => {
    stubApi(true);
    await render(<GroupInstruction group={GROUP} />);
    await ask();

    const text = host.textContent ?? "";
    expect(text).toContain(ANSWER);
    expect(text).not.toContain(NOTE);
  });
});
