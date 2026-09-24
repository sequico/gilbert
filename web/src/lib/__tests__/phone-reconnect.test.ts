import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Phone, type PhoneHooks } from "@/lib/phone/sip";

/**
 * The phone's socket lifecycle (ADR 0023).
 *
 * jsdom has no WebSocket, RTCPeerConnection or microphone, so both are faked:
 * the Janus socket answers the frames the client sends, and the media probe's
 * peer connection comes up so the phone is offered. What is pinned: the network
 * returning retries at once instead of waiting out the accumulated backoff, and
 * a socket that goes away ends the call rather than leaving the microphone
 * open behind a dead line.
 */

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(_url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(frame: string): void {
    const parsed = JSON.parse(frame) as Record<string, unknown>;
    let reply: unknown = null;
    if (parsed.janus === "create")
      reply = { janus: "success", transaction: parsed.transaction, data: { id: 111 } };
    else if (parsed.janus === "attach")
      reply = { janus: "success", transaction: parsed.transaction, data: { id: 222 } };
    if (reply) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
  }

  close(): void {}
}

/** A peer connection that comes up as soon as the offer is set, so the probe passes. */
class FakePeer {
  connectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((event: { candidate: null }) => void) | null = null;

  addTransceiver() {
    return { setCodecPreferences() {} };
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {
    this.connectionState = "connected";
    queueMicrotask(() => this.onconnectionstatechange?.());
  }
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
}

const lines: string[] = [];
const calls: Array<string | null> = [];
const hooks: PhoneHooks = {
  onLine: (state) => lines.push(state),
  onProven: () => {},
  onIncoming: () => {},
  onCall: (call) => calls.push(call?.remote ?? null),
  onError: (message) => lines.push(`error:${message}`),
};

const credential = { server: "pbx.example.com", username: "1001", password: "p" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  FakeSocket.instances = [];
  lines.length = 0;
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the phone's socket lifecycle", () => {
  it("retries at once when the network returns, and ends the call when the socket goes", async () => {
    const phone = new Phone(credential, hooks);
    await phone.start();
    // The probe's socket, then the one the registered line lives on.
    expect(FakeSocket.instances).toHaveLength(2);

    // The socket goes: the line is reconnecting and the call's media is torn
    // down, so the microphone is not left open behind a line that cannot hang up.
    const sip = FakeSocket.instances[1]!;
    sip.onclose?.();
    expect(lines).toContain("connecting");
    expect(calls).toContain(null);

    // The network returns: a fresh attempt starts now, without waiting out the
    // reconnect timer the drop scheduled.
    window.dispatchEvent(new Event("online"));
    expect(FakeSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);
    // The scheduled retry was dropped, so the timer added no second attempt.
    expect(FakeSocket.instances).toHaveLength(3);

    await phone.stop();
  });
});
