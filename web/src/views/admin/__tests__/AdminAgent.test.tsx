import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { AdminAgent } from "../AdminAgent";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The agent's administration surface (ADR 0031, 0034, 0036, 0037): what a run
 * looks like when the agent's own record is the thing on the screen, what a fact
 * of the installation's memory looks like, and what a correction and a removal do.
 *
 * The server's routes are exercised against the mock in
 * `server/src/admin-agent.test.ts`; this file is about what the screen does with
 * what it is told — in particular that it draws the **plan's dependency and the
 * branch it took** rather than a bare list of steps, that it says a run it cannot
 * read instead of drawing an empty one, and that the two writes leave the browser
 * for the server route rather than reaching the Master's app folder.
 */

const GROUP = "team@example.org";

/** One run of the mock: a plan with an order and a branch, worked and ended. */
const RUN = {
  v: 5,
  id: "surface-run",
  startedBy: { rule: "intake", instruction: null, woke: "mail created: m-1" },
  plan: [
    { what: "read the mail", state: "done", outcome: "read one message", needs: null },
    {
      what: "file it, if the mail was read",
      state: "skipped",
      outcome: "left unrun: step 0 ended failed",
      needs: { step: 0, when: "done" },
    },
  ],
  touched: [],
  waiting: {
    what: "the shipper's answer",
    asked: { channel: "mail", id: "m-ask" },
    until: "2026-10-18T09:00:00.000Z",
  },
  recalled: ["fact-maersk"],
  authorisations: [],
  evidence: [],
  spent: { steps: 1, calls: 2, ms: 800 },
  state: "blocked",
  ended: { at: "2026-10-17T09:00:00.000Z", why: "waiting for the shipper's answer" },
};

const FACT = {
  v: 2,
  id: "fact-maersk",
  subject: "Maersk",
  fact: "the usual shipper",
  origin: { by: "run", run: "surface-run" },
  at: "2026-10-17T08:00:00.000Z",
  links: [],
  standing: false,
  group: "g1",
};

describe("the agent's administration surface", () => {
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

  function answer(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      statusText: "",
    } as Response;
  }

  /**
   * The server, in the shapes its routes answer with: the claim and the pass
   * interval, the installation's document (for the model), the memory, the group
   * directory, and the group's runs — each run as the listing carries it, the run
   * itself or the reason this build cannot read it.
   */
  function stubServer(
    runs: unknown[] = [{ id: "surface-run", run: RUN, problem: null }],
    facts: unknown[] = [FACT],
  ) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT")
        return answer({
          fact: {
            ...(facts[0] as Record<string, unknown>),
            subject: (JSON.parse(String(init.body)) as { subject: string }).subject,
            fact: (JSON.parse(String(init.body)) as { fact: string }).fact,
            origin: { by: "person", who: "admin@example.com" },
          },
        });
      if (init?.method === "DELETE") return answer({ ok: true });
      if (url.startsWith("/api/admin/groups/") && url.endsWith("/runs"))
        return answer({ group: GROUP, runs });
      if (url === "/api/admin/groups")
        return answer({ groups: [{ id: "t1", name: GROUP }], enumeration: true });
      if (url === "/api/admin/memory") return answer({ facts });
      if (url === "/api/admin/installation")
        return answer({
          installation: {
            present: true,
            document: JSON.stringify({
              agent: {
                provider: {
                  provider: "openai",
                  model: "gpt-5",
                  baseUrl: "https://api.openai.com/v1",
                },
              },
            }),
            problem: null,
            account: "m1",
            master: "gilbert@example.com",
            location: "gilbert/installation.json in account m1",
          },
        });
      return answer({
        agent: {
          claim: {
            v: 1,
            holder: "host-a#41",
            takenAt: "2026-10-17T08:00:00.000Z",
            expires: "2026-10-17T08:10:00.000Z",
          },
          passSeconds: 10,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** Let one round of reads and renders settle. */
  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function render() {
    await act(async () => {
      root.render(
        <Router>
          <AdminAgent />
        </Router>,
      );
    });
    // Two rounds: the claim and the model on mount, then the group directory the
    // picker offers — the surface reads all three before it can show a run.
    await flush();
    await flush();
  }

  /** Choose the group whose runs are on screen. */
  async function chooseGroup() {
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>("select");
      if (!select) throw new Error("no group picker");
      if (![...select.options].some((option) => option.value === GROUP))
        throw new Error("the group the directory lists is not on the picker");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )?.set;
      setter?.call(select, GROUP);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await flush();
  }

  function button(label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(label),
    );
    if (!found) throw new Error(`no button: ${label}`);
    return found;
  }

  function text(): string {
    return host.textContent ?? "";
  }

  it("says where the agent is: the claim it holds and how often a pass is asked for", async () => {
    stubServer();
    await render();

    expect(text()).toContain("host-a#41");
    expect(text()).toContain("every 10 seconds");
    // The model is the installation section's, so it is named and linked, never
    // edited here — and the key is nowhere on this screen.
    expect(text()).toContain("openai");
    expect(host.querySelector('a[href="/admin/installation"]')).not.toBeNull();
    // Nothing here starts or stops the agent: there is no such control to press.
    expect(
      [...host.querySelectorAll("button")].map((b) => b.textContent ?? ""),
    ).not.toContain("Start");
  });

  it("draws a run as the record carries it: the change, the rule, the dependency and the branch", async () => {
    stubServer();
    await render();
    await chooseGroup();

    const shown = text();
    expect(shown).toContain("mail created: m-1");
    expect(shown).toContain("intake");
    expect(shown).toContain("read the mail");
    // The dependency of the step that waited, and the branch it did not take.
    expect(shown).toContain("After step 1 if it ended Worked");
    expect(shown).toContain("left unrun: step 0 ended failed");
    // The tally, and where it parked and why.
    expect(shown).toContain("1 steps, 2 model calls");
    expect(shown).toContain("the shipper's answer");
    expect(shown).toContain("waiting for the shipper's answer");
  });

  it("says a run it cannot read instead of drawing an empty one", async () => {
    stubServer([
      {
        id: "future-run",
        run: null,
        problem: 'The run at runs/future-run.json is not readable: "v" is 9.',
      },
    ]);
    await render();
    await chooseGroup();

    expect(text()).toContain("future-run");
    expect(text()).toContain('"v" is 9');
  });

  it("lists a fact and sends a correction to the server, not to the account", async () => {
    const fetchMock = stubServer();
    await render();

    expect(text()).toContain("Maersk");
    await act(async () => {
      button("Edit").click();
    });

    const field = host.querySelector<HTMLTextAreaElement>("textarea");
    if (!field) throw new Error("the correction has no field");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(field, "the shipper for containers, and only them");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      button("Save").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const written = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit)?.method === "PUT",
    );
    if (!written) throw new Error("the surface made no correction");
    expect(String(written[0])).toBe(`/api/admin/memory/${FACT.id}`);
    expect(String((written[1] as RequestInit).body)).toContain("containers");
    // What the route stored is what the screen then shows, in force.
    expect(text()).toContain("in force");
  });
});
