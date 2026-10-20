import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { useMail } from "@/store/mail";
import { AgentsView } from "../agents/AgentsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The agent's administration surface (ADR 0027, 0030, 0032, 0033): what a run
 * looks like when the agent's own record is the thing on the screen, what a fact
 * of the installation's memory looks like, and what a correction and a removal do.
 *
 * The server's routes are exercised against the mock in
 * `server/src/admin-agent.test.ts`; this file is about what the screen does with
 * what it is told — in particular that it draws the **plan's dependency and the
 * branch it took** rather than a bare list of steps, that it draws **what the run
 * recalled** resolved to the facts behind it, that it says a run it cannot
 * read instead of drawing an empty one, that a proposal the agent recorded
 * against a person's fact is shown beside it and answered through the server,
 * and that the writes leave the browser for the server route rather than
 * reaching the Master's app folder.
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

/** The run as the listing carries it: the header, never the whole document. */
const SUMMARY = {
  id: "surface-run",
  problem: null,
  state: "blocked",
  ended: { at: "2026-10-17T09:00:00.000Z", why: "waiting for the shipper's answer" },
  rule: "intake",
  woke: "mail created: m-1",
  steps: 2,
  refused: 0,
  spent: { steps: 1, calls: 2, ms: 800 },
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
  function stubServer(runs: unknown[] = [SUMMARY], facts: unknown[] = [FACT]) {
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
      if (url.startsWith("/api/groups/") && url.split("?")[0]?.endsWith("/runs"))
        return answer({ group: GROUP, runs });
      if (
        url.startsWith("/api/groups/") &&
        /\/runs\/[^/?]+$/.test(url.split("?")[0] ?? "")
      )
        return answer({ group: GROUP, run: RUN });
      if (url.startsWith("/api/admin/groups/") && url.endsWith("/prose"))
        return answer({ instruction: "", rules: [], state: "state-1" });
      if (url === "/api/admin/groups")
        return answer({ groups: [{ id: "t1", name: GROUP }], enumeration: true });
      if (url === "/api/admin/memory") return answer({ facts, problems: [] });
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
    // The groups the page tabs are the session's group mailboxes, as the
    // composer and the rules editor read them.
    useMail.setState({
      mailAccounts: [{ accountId: "m1", name: GROUP, kind: "group" }],
    });
    await act(async () => {
      root.render(
        <Router>
          <AgentsView />
        </Router>,
      );
    });
    // Two rounds: the claim and the model on mount, then the group directory the
    // picker offers — the surface reads all three before it can show a run.
    await flush();
    await flush();
  }

  /** Open one of the page's tabs, by the label it shows. */
  async function openTab(label: string) {
    await act(async () => {
      const found = [
        ...host.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
      ].find((button) => (button.textContent ?? "") === label);
      if (!found) throw new Error(`no tab: ${label}`);
      found.click();
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
    await openTab("Overview");

    expect(text()).toContain("host-a#41");
    expect(text()).toContain("A pass every 10 s.");
    // Nothing here starts or stops the agent: there is no such control to press.
    expect(
      [...host.querySelectorAll("button")].map((b) => b.textContent ?? ""),
    ).not.toContain("Start");
  });

  it("draws a run as the record carries it: the change, the rule, the dependency and the branch", async () => {
    stubServer();
    await render();
    await openTab(GROUP);
    // The list carries the header; the document is read when its row opens.
    await act(async () => {
      host.querySelector<HTMLElement>("summary")?.click();
    });
    await flush();
    await flush();

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
    // What the run recalled, each id resolved to the fact that carried it:
    // traceability is on the screen, not only in the record.
    expect(shown).toContain("Recalled: Maersk — the usual shipper.");
  });

  it("says a run it cannot read instead of drawing an empty one", async () => {
    stubServer([
      {
        id: "future-run",
        problem: 'The run at runs/future-run.json is not readable: "v" is 9.',
        state: null,
        ended: null,
        rule: null,
        woke: null,
        steps: 0,
        refused: 0,
        spent: { steps: 0, calls: 0, ms: 0 },
      },
    ]);
    await render();
    await openTab(GROUP);

    expect(text()).toContain("future-run");
    expect(text()).toContain('"v" is 9');
  });

  it("lists a fact and sends a correction to the server, not to the account", async () => {
    const fetchMock = stubServer();
    await render();
    await openTab("Memory");

    expect(text()).toContain("Maersk");
    await act(async () => {
      button("Edit").click();
    });

    const field = host.querySelector<HTMLTextAreaElement>('textarea[id^="fact-"]');
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
      const save = [...(field.closest(".card")?.querySelectorAll("button") ?? [])].find(
        (one) => (one.textContent ?? "").includes("Save"),
      );
      if (!save) throw new Error("the correction has no Save");
      save.click();
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

  it("shows the agent's proposal beside the person's fact, and accepting it is a correction", async () => {
    const proposed = {
      ...FACT,
      proposal: {
        fact: "the shipper for containers, and only them",
        run: "surface-run",
        at: "2026-10-17T09:00:00.000Z",
      },
    };
    const fetchMock = stubServer(undefined, [proposed]);
    await render();
    await openTab("Memory");

    expect(text()).toContain("the usual shipper");
    expect(text()).toContain(
      "The agent proposes: the shipper for containers, and only them",
    );

    await act(async () => {
      button("Accept").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Accepting writes no new route: the proposal's words become the person's
    // own correction, which is what puts them in force (ADR 0033).
    const written = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit)?.method === "PUT",
    );
    if (!written) throw new Error("accepting made no correction");
    expect(String(written[0])).toBe(`/api/admin/memory/${FACT.id}`);
    expect(String((written[1] as RequestInit).body)).toContain(
      "the shipper for containers",
    );
  });

  it("follows the groups the Master is in: a removed group loses its tab", async () => {
    /*
     * The tabs are the session's group mailboxes, read live. A group the Master
     * is taken out of stops being a tab; a page still pointing at it would show
     * no panel at all, so the selection falls back to General and the group's
     * panel is unmounted.
     */
    stubServer();
    await render();
    await openTab(GROUP);
    expect(document.getElementById(`agents-group:${GROUP}-panel`)).not.toBeNull();

    await act(async () => {
      useMail.setState({ mailAccounts: [] });
    });
    await flush();

    const selected = host.querySelector('button[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toBe("Overview");
    expect(document.getElementById(`agents-group:${GROUP}-panel`)).toBeNull();

    await act(async () => {
      useMail.setState({
        mailAccounts: [{ accountId: "m1", name: GROUP, kind: "group" }],
      });
    });
    await flush();
    const labels = [...host.querySelectorAll('button[role="tab"]')].map(
      (one) => one.textContent,
    );
    expect(labels).toContain(GROUP);
  });

  it("dismisses the agent's proposal through its own route and writes nothing", async () => {
    const proposed = {
      ...FACT,
      proposal: {
        fact: "the shipper for containers, and only them",
        run: "surface-run",
        at: "2026-10-17T09:00:00.000Z",
      },
    };
    const fetchMock = stubServer(undefined, [proposed]);
    await render();
    await openTab("Memory");

    await act(async () => {
      button("Dismiss").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const dismissed = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith("/proposal"),
    );
    if (!dismissed) throw new Error("dismissing made no request");
    expect(String(dismissed[0])).toBe(`/api/admin/memory/${FACT.id}/proposal`);
    expect((dismissed[1] as RequestInit).method).toBe("DELETE");
    expect(
      fetchMock.mock.calls.some((call) => (call[1] as RequestInit)?.method === "PUT"),
      "a dismissal writes no sentence",
    ).toBe(false);
  });
});
