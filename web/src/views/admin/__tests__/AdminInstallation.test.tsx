import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminInstallation } from "../AdminInstallation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The installation's own document as an administrator reads and publishes it
 * (ADR 0003): what the account holds, what a boot would refuse, and — the part
 * that is the whole point of the surface — that a publish says when it applies
 * rather than reporting a save as though the running process had changed.
 *
 * The two answers the server gives are stubbed here, in its own shape
 * (`InstallationView`, `InstallationPublished`): the route itself is exercised
 * against the mock server in `server/src/installation-admin.test.ts`, so this
 * file is about what the screen does with what it is told.
 */

const LOCATION = "gilbert/installation.json in account a1";
const DOCUMENT = JSON.stringify({ branding: { appName: "Gilbert" } }, null, 2);

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
    const field = host.querySelector("textarea");
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
            master: null,
            bootsFrom: "unknown",
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
            master: null,
            bootsFrom: "unknown",
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
      master: null,
      bootsFrom: "unknown",
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

  it("says so when the installation's boot reads another account's document", async () => {
    /*
     * The case the answer exists not to leave silent: the document is real and
     * stored, and the installation's next boot signs in as the Master and
     * reads that account's own copy instead.
     */
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({
          installation: {
            present: true,
            document: DOCUMENT,
            problem: null,
            account: "a1",
            master: "gilbert@example.com",
            bootsFrom: "no",
            location: LOCATION,
          },
        }),
      ),
    );

    await render();

    const text = host.textContent ?? "";
    expect(text).toContain("gilbert@example.com");
    expect(text).toContain("does not change what the installation boots from");
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
});
