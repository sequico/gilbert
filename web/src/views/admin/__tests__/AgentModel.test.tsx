import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentModel } from "../agents/AgentModel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The installation's model, as the AI Agents section edits it (ADR 0027): the
 * fields write `agent.provider` into the installation's document, and the key is
 * write-only — never filled from a read, stated only as the save is sent.
 */

const LOCATION = "gilbert/installation.json in account a1";
const MASTER = "gilbert@example.com";
const DOCUMENT = JSON.stringify({ branding: { appName: "Gilbert" } }, null, 2);
const MODEL = {
  provider: "openai",
  model: "gpt-5",
  baseUrl: "https://api.openai.com/v1",
};
const MODEL_DOCUMENT = JSON.stringify(
  {
    agent: { provider: MODEL },
    branding: { appName: "Gilbert" },
    secret: "a-secret-long-enough-to-seal-a-session-with",
  },
  null,
  2,
);

describe("the agent's model", () => {
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

  async function render() {
    await act(async () => {
      root.render(<AgentModel onSaved={() => {}} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function click(label: string) {
    await act(async () => {
      const found = [...host.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(label),
      );
      if (!found) throw new Error(`no button: ${label}`);
      found.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function input(id: string): HTMLInputElement {
    const field = host.querySelector<HTMLInputElement>(`#${id}`);
    if (!field) throw new Error(`no input: ${id}`);
    return field;
  }

  async function fill(id: string, value: string) {
    await act(async () => {
      const field = input(id);
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function needsNoKey() {
    await act(async () => {
      const sw = host.querySelector<HTMLButtonElement>(".switch");
      if (!sw) throw new Error("the provider-needs-no-key switch is not rendered");
      sw.click();
    });
  }

  function withoutKey(text: string): string {
    const whole = JSON.parse(text) as {
      agent?: { provider?: Record<string, unknown> };
    };
    if (whole.agent?.provider) delete whole.agent.provider.apiKey;
    return JSON.stringify(whole, null, 2);
  }

  function stubServer(document: string) {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? answer({
            outcome: {
              account: "a1",
              master: MASTER,
              location: LOCATION,
              document: withoutKey(String(init.body)),
              epoch: 2,
              applies: "next-boot",
              message: "Written.",
            },
          })
        : answer({
            installation: {
              present: true,
              document,
              problem: null,
              account: "a1",
              master: MASTER,
              location: LOCATION,
            },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function sentProvider(fetchMock: ReturnType<typeof vi.fn>) {
    const posted = fetchMock.mock.calls.find(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    if (!posted) throw new Error("the surface made no save");
    const body = JSON.parse(String((posted[1] as RequestInit).body)) as {
      agent: { provider: Record<string, unknown> };
    };
    return body.agent.provider;
  }

  it("shows the model the document names, and never fills the key field", async () => {
    stubServer(MODEL_DOCUMENT);
    await render();

    expect(input("model-provider").value).toBe(MODEL.provider);
    expect(input("model-name").value).toBe(MODEL.model);
    expect(input("model-base-url").value).toBe(MODEL.baseUrl);
    expect(input("model-key").value).toBe("");
  });

  it("writes an edited field into the document, stating nothing about the key", async () => {
    const fetchMock = stubServer(MODEL_DOCUMENT);
    await render();
    await fill("model-name", "gpt-5-mini");
    await click("Save");

    const provider = sentProvider(fetchMock);
    expect(provider.provider).toBe(MODEL.provider);
    expect(provider.model).toBe("gpt-5-mini");
    expect("apiKey" in provider).toBe(false);
  });

  it("keeps the stored key when the key field is typed into and emptied again", async () => {
    const fetchMock = stubServer(MODEL_DOCUMENT);
    await render();
    await fill("model-key", "sk-a-key-that-was-then-taken-back");
    await fill("model-key", "");
    await fill("model-name", "gpt-5-mini");
    await click("Save");

    const provider = sentProvider(fetchMock);
    expect(provider.model).toBe("gpt-5-mini");
    expect("apiKey" in provider).toBe(false);
  });

  it("states the key an administrator types, in the publish and nowhere else", async () => {
    const fetchMock = stubServer(MODEL_DOCUMENT);
    const key = "sk-a-key-the-document-never-holds";
    await render();
    await fill("model-key", key);
    await click("Save");

    expect(sentProvider(fetchMock).apiKey).toBe(key);
  });

  it("clears the stored key when an administrator says the provider needs none", async () => {
    const fetchMock = stubServer(MODEL_DOCUMENT);
    await render();
    await needsNoKey();
    await click("Save");

    expect(sentProvider(fetchMock).apiKey).toBe(null);
  });

  it("asks for a provider before a key, and says why the field is closed", async () => {
    stubServer(DOCUMENT);
    await render();

    expect(input("model-key").disabled).toBe(true);
    expect(host.textContent ?? "").toContain("Name a provider first");
  });

  it("says the installation has no agent when the document names no model", async () => {
    stubServer(DOCUMENT);
    await render();

    expect(input("model-provider").value).toBe("");
    expect(host.textContent ?? "").toContain("the agent stays idle");
  });
});
