import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminInstallation } from "../AdminInstallation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The installation's own document as an administrator reads and publishes it
 * (ADR 0011): what the Master's account holds, what a boot would refuse, that a
 * publish says when it applies rather than reporting a save as though the
 * running process had changed, and that a refusal — a deployment that names no
 * Master included — is what the screen shows.
 *
 * The two answers the server gives are stubbed here, in its own shape
 * (`InstallationView`, `InstallationPublished`): the route itself is exercised
 * against the mock server in `server/src/installation-admin.test.ts`, so this
 * file is about what the screen does with what it is told.
 */

const LOCATION = "gilbert/installation.json in account a1";
const MASTER = "gilbert@example.com";
const DOCUMENT = JSON.stringify({ branding: { appName: "Gilbert" } }, null, 2);
/** The model the installation runs on (ADR 0031), as a document names it. */
const MODEL = {
  provider: "openai",
  model: "gpt-5",
  baseUrl: "https://api.openai.com/v1",
};
/**
 * A document that names a model, in the shape the server's read hands back: the
 * key is taken out (`installationAdmin.ts`), so it is absent here.
 */
const MODEL_DOCUMENT = JSON.stringify(
  {
    agent: { provider: MODEL },
    branding: { appName: "Gilbert" },
    secret: "a-secret-long-enough-to-seal-a-session-with",
  },
  null,
  2,
);

describe("the installation document surface", () => {
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

  /** One JSON answer, in the shape the given status would carry. */
  function answer(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      statusText: "",
    } as Response;
  }

  /** Render the surface and let its read settle. */
  async function render() {
    await act(async () => {
      root.render(<AdminInstallation />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function editor(): HTMLTextAreaElement {
    // The surface holds two textareas now: the installation's own line, and the
    // document. This one is the document, by the label the editor gives it.
    const field = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Installation document"]',
    );
    if (!field) throw new Error("the editor is not rendered");
    return field;
  }

  /**
   * An edit, as React sees one: the native setter, then the input event —
   * assigning `.value` alone leaves React's own value tracker believing
   * nothing changed, so `onChange` never runs and the button stays disabled.
   */
  async function type(text: string) {
    await act(async () => {
      const field = editor();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /** One click, and the round trip its handler makes. */
  async function click(label: string) {
    await act(async () => {
      button(label).click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function button(label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(label),
    );
    if (!found) throw new Error(`no button: ${label}`);
    return found;
  }

  /** One of the model's fields, by the id the surface gives it. */
  function input(id: string): HTMLInputElement {
    const field = host.querySelector<HTMLInputElement>(`#${id}`);
    if (!field) throw new Error(`no input: ${id}`);
    return field;
  }

  /** An edit to one input, as React sees one (the same tracker problem as `type`). */
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

  /** The switch an administrator turns on to say the provider needs no key. */
  async function needsNoKey() {
    await act(async () => {
      const sw = host.querySelector<HTMLButtonElement>(".switch");
      if (!sw) throw new Error("the provider-needs-no-key switch is not rendered");
      sw.click();
    });
  }

  /**
   * The document a read hands back, standing in for the server: the model's key
   * is taken out of every answer that carries document text
   * (`installationAdmin.ts`), so the text a surface holds states nothing about
   * the key — which is what leaves the stored one alone when it is published
   * back.
   */
  function withoutKey(text: string): string {
    const whole = JSON.parse(text) as {
      agent?: { provider?: Record<string, unknown> };
    };
    if (whole.agent?.provider) delete whole.agent.provider.apiKey;
    return JSON.stringify(whole, null, 2);
  }

  /**
   * A stub that reads one document and echoes whatever a publish sent, in the
   * shape the route answers with (`InstallationView`, `InstallationPublished`).
   */
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

  /** The model's provider, as the last publish stated it. */
  function sentProvider(fetchMock: ReturnType<typeof vi.fn>) {
    const posted = fetchMock.mock.calls.find(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    if (!posted) throw new Error("the surface made no publish");
    const body = JSON.parse(String((posted[1] as RequestInit).body)) as {
      agent: { provider: Record<string, unknown> };
    };
    return body.agent.provider;
  }

  it("shows the document the account holds, where it lives, and what a boot would refuse", async () => {
    const problem =
      'The document carries no app secret in "secret", so a boot would refuse it.';
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({
          installation: {
            present: true,
            document: DOCUMENT,
            problem,
            account: "a1",
            master: MASTER,
            location: LOCATION,
          },
        }),
      ),
    );

    await render();

    expect(editor().value).toBe(DOCUMENT);
    const text = host.textContent ?? "";
    expect(text).toContain(LOCATION);
    expect(text).toContain(problem);
    // Two contradicting states are never shown at once: there is a document,
    // so the "no document yet" hint is not on screen.
    expect(text).not.toContain("holds no document yet");
  });

  it("starts from the defaults and a fresh secret when the account holds nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({
          installation: {
            present: false,
            document: null,
            problem: null,
            account: "a1",
            master: MASTER,
            location: LOCATION,
          },
        }),
      ),
    );

    await render();

    const seeded = JSON.parse(editor().value) as {
      server: { port: number };
      secret: string;
    };
    expect(seeded.server.port).toBeGreaterThan(0);
    expect(seeded.secret.length).toBeGreaterThan(20);
    expect(host.textContent ?? "").toContain("holds no document yet");
  });

  it("publishes the text it holds and reports what applies when", async () => {
    const published = {
      account: "a1",
      master: MASTER,
      location: LOCATION,
      document: DOCUMENT,
      epoch: 2,
      applies: "next-boot",
      message:
        `Written to ${LOCATION}. This process keeps the configuration it booted with — the document is ` +
        "read at boot — so what you just published applies from the next boot of this installation, and " +
        "nothing in the running one has changed.",
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? answer({ outcome: published })
        : answer({
            installation: {
              present: true,
              document: DOCUMENT,
              problem: null,
              account: "a1",
              location: LOCATION,
            },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await render();
    // An unchanged document is not something the button offers to publish, so
    // the publish under test is one an administrator actually made.
    expect(button("Publish document").disabled).toBe(true);
    const edited = DOCUMENT.replace("Gilbert", "Gilbert Test");
    await type(edited);
    await click("Publish document");

    const posted = fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
    expect(String(posted?.[0])).toBe("/api/admin/installation");
    expect(posted?.[1]?.body).toBe(edited);
    const text = host.textContent ?? "";
    expect(text).toContain("Takes effect at the next boot.");
    expect(text).toContain("next boot");
    // What the server stored is what the editor now shows and holds as its
    // baseline, so the button has nothing left to publish.
    expect(editor().value).toBe(DOCUMENT);
    expect(button("Publish document").disabled).toBe(true);
  });

  it("shows the server's refusal when this deployment names no Master", async () => {
    /*
     * The read itself is refused there: a deployment with no Master has no
     * account whose own document a boot reads, so there is nothing for this
     * surface to read or publish and the screen says so rather than offering
     * an editor over somebody else's Files.
     */
    const refusal =
      "This deployment names no Master (GILBERT_AGENT_ADDRESS), so there is no account whose own app " +
      "folder a boot reads the installation's document from, and nothing for this surface to read or " +
      "publish.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ error: "no_master", message: refusal }, 409)),
    );

    await render();

    const text = host.textContent ?? "";
    expect(text).toContain(refusal);
    expect(host.querySelector('textarea[aria-label="Installation document"]')).toBeNull();
  });

  it("shows a refusal as the server stated it and keeps the text", async () => {
    const refusal = '"server.port" must be between 1 and 65535 (it is 0).';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? answer({ error: "invalid_installation", message: refusal }, 400)
        : answer({
            installation: {
              present: true,
              document: DOCUMENT,
              problem: null,
              account: "a1",
              location: LOCATION,
            },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await render();
    await type('{"server": {"port": 0}}');
    await click("Publish document");

    expect(host.textContent ?? "").toContain(refusal);
    expect(editor().value).toBe('{"server": {"port": 0}}');
  });

  /*
   * The installation's model (ADR 0031): the one part of the document an
   * administrator chooses rather than looks up, so it has fields of its own. The
   * fields write `agent.provider` in the text the editor holds — one home for
   * the model, and the document is it — and the key is the one thing they never
   * hold: a write-only field, whose three states the document itself tells
   * apart.
   */
  it("shows the model the document names, and never fills the key field", async () => {
    stubServer(MODEL_DOCUMENT);

    await render();

    expect(input("model-provider").value).toBe(MODEL.provider);
    expect(input("model-name").value).toBe(MODEL.model);
    expect(input("model-base-url").value).toBe(MODEL.baseUrl);
    // No read hands the key back, so the field it would be stated in is empty.
    expect(input("model-key").value).toBe("");
    // The document is where the model lives: the fields read it and write it,
    // rather than the surface keeping a second copy of its own.
    expect(editor().value).toBe(MODEL_DOCUMENT);
  });

  it("writes an edited field into the document, stating nothing about the key", async () => {
    const fetchMock = stubServer(MODEL_DOCUMENT);

    await render();
    await fill("model-name", "gpt-5-mini");
    expect(editor().value).toContain("gpt-5-mini");

    await click("Publish document");

    const provider = sentProvider(fetchMock);
    expect(provider.provider).toBe(MODEL.provider);
    expect(provider.model).toBe("gpt-5-mini");
    // The key field was never touched, so the save states nothing about the key
    // and the stored one stands.
    expect("apiKey" in provider).toBe(false);
  });

  it("keeps the stored key when the key field is typed into and emptied again", async () => {
    const fetchMock = stubServer(MODEL_DOCUMENT);

    await render();
    await fill("model-key", "sk-a-key-that-was-then-taken-back");
    // Emptying the field is the same save as never typing into it: it states
    // nothing about the key, so the stored one stands. Only the switch clears it.
    await fill("model-key", "");
    // Something else has to move for there to be anything to publish.
    await fill("model-name", "gpt-5-mini");
    await click("Publish document");

    const provider = sentProvider(fetchMock);
    expect(provider.model).toBe("gpt-5-mini");
    expect("apiKey" in provider).toBe(false);
  });

  it("states the key an administrator types, and never in the document", async () => {
    const fetchMock = stubServer(MODEL_DOCUMENT);
    const key = "sk-a-key-the-document-never-holds";

    await render();
    await fill("model-key", key);

    // The key is never part of the text this surface holds: what it shows is the
    // document, and the key is stated only as the publish is sent.
    expect(editor().value).not.toContain(key);

    await click("Publish document");

    expect(sentProvider(fetchMock).apiKey).toBe(key);
    // And what the surface holds afterwards is what the server stored, which
    // carries no key at all.
    expect(editor().value).not.toContain(key);
  });

  it("clears the stored key when an administrator says the provider needs none", async () => {
    const fetchMock = stubServer(MODEL_DOCUMENT);

    await render();
    await needsNoKey();
    await click("Publish document");

    // The switch is the one thing a save can state that clears the key: it sends
    // `apiKey: null`, which the door reads as "the provider needs none" and
    // stores as an empty key. An empty string would keep the stored one.
    expect(sentProvider(fetchMock).apiKey).toBe(null);
  });

  it("says the installation has no agent when the document names no model", async () => {
    stubServer(DOCUMENT);

    await render();

    expect(input("model-provider").value).toBe("");
    expect(host.textContent ?? "").toContain("the agent stays idle");
  });
});
