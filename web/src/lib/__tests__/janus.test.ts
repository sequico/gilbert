import { afterEach, describe, expect, it, vi } from "vitest";
import { Janus } from "@/lib/phone/janus";

/**
 * The Janus API client's frames (ADR 0023).
 *
 * The protocol is positional: `attach` and every later request must name the
 * `session_id`, and a handle request must name the `handle_id`. Omitting one is
 * not a type error — Janus answers an error code and the phone quietly has no
 * plugin — so the shape is pinned here, against the frames actually sent.
 */

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  static reply: ((frame: Record<string, unknown>) => unknown) | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(_url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(frame: string): void {
    const parsed = JSON.parse(frame) as Record<string, unknown>;
    this.sent.push(parsed);
    const reply = FakeSocket.reply?.(parsed);
    if (reply) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
  }

  close(): void {}
}

const hooks = {
  onEvent() {},
  onRemoteCandidate() {},
  onMediaGone() {},
  onClosed() {},
};

afterEach(() => {
  vi.unstubAllGlobals();
  FakeSocket.instances = [];
  FakeSocket.reply = null;
});

describe("the Janus API client", () => {
  it("scopes the attach and the handle requests to the session", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.reply = (frame) => {
      if (frame.janus === "create")
        return { janus: "success", transaction: frame.transaction, data: { id: 111 } };
      if (frame.janus === "attach")
        return { janus: "success", transaction: frame.transaction, data: { id: 222 } };
      return null;
    };

    const janus = new Janus("ws://bridge", hooks);
    await janus.open("janus.plugin.echotest");
    janus.message({ request: "register" });
    janus.trickle({ candidate: "x" } as RTCIceCandidateInit);

    const sent = FakeSocket.instances[0]?.sent ?? [];
    const attach = sent.find((f) => f.janus === "attach");
    expect(attach).toBeTruthy();
    expect(attach?.session_id).toBe(111);

    const message = sent.find((f) => f.janus === "message");
    expect(message?.session_id).toBe(111);
    expect(message?.handle_id).toBe(222);

    const trickle = sent.find((f) => f.janus === "trickle");
    expect(trickle?.session_id).toBe(111);
    expect(trickle?.handle_id).toBe(222);
  });
});
