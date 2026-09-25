import { BRIDGE_STUN_PORT } from "@gilbert/shared/phone";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Phone, type PhoneHooks } from "@/lib/phone/sip";

/**
 * Answering an incoming call (ADR 0023).
 *
 * An incoming INVITE is offered while the tab has no peer connection yet: the
 * phone stores the offer and answers only when the reader presses Answer.
 * Janus trickles its ICE candidates as the offer goes out, so they arrive
 * before there is any description to attach them to and must be held, not
 * dropped. Dropping them is what leaves the answered call with no remote
 * candidates and no media path.
 *
 * The test fails if the held candidates are discarded instead of applied once
 * the description lands.
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

/**
 * A peer connection that refuses a candidate added before its remote
 * description, exactly as the browser does, and records the ones it took.
 */
class FakePeer {
  static instances: FakePeer[] = [];
  connectionState = "new";
  remoteSet = false;
  added: unknown[] = [];
  config: RTCConfiguration | undefined;
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((event: { candidate: null }) => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;

  constructor(config?: RTCConfiguration) {
    this.config = config;
    FakePeer.instances.push(this);
  }

  addTransceiver() {
    return {
      setCodecPreferences() {},
      sender: { track: { enabled: true }, dtmf: { insertDTMF() {} } },
    };
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "v=0" };
  }
  async setLocalDescription() {
    this.connectionState = "connected";
    queueMicrotask(() => this.onconnectionstatechange?.());
  }
  async setRemoteDescription() {
    this.remoteSet = true;
  }
  async addIceCandidate(candidate: unknown) {
    if (!this.remoteSet)
      throw new Error("addIceCandidate called before setRemoteDescription");
    this.added.push(candidate);
  }
  close() {}
}

const hooks: PhoneHooks = {
  onLine: () => {},
  onBridge: () => {},
  onProven: () => {},
  onIncoming: () => {},
  onCall: () => {},
  onCallEnded: () => {},
  onLineFailure: () => {},
  onError: () => {},
};

const credential = { server: "pbx.example.com", username: "1001", password: "p" };

const candidate = (n: number) => ({
  candidate: `candidate:${n} 1 udp 1 10.0.0.${n} 5000 typ host`,
  sdpMid: "0",
  sdpMLineIndex: 0,
});

function event(data: unknown, jsep?: unknown): { data: string } {
  return {
    data: JSON.stringify({
      janus: "event",
      plugindata: { plugin: "janus.plugin.sip", data },
      ...(jsep ? { jsep } : {}),
    }),
  };
}

function trickle(n: number): { data: string } {
  return { data: JSON.stringify({ janus: "trickle", candidate: candidate(n) }) };
}

/** Register the line, then hand back the SIP socket Janus speaks on. */
async function readyPhone(): Promise<{ phone: Phone; sip: FakeSocket }> {
  const phone = new Phone(credential, hooks);
  await phone.start();
  const sip = FakeSocket.instances.at(-1);
  if (!sip) throw new Error("no SIP socket");
  return { phone, sip };
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: [] }) });
  vi.stubGlobal("isSecureContext", true);
  const track = { enabled: true, stop() {} };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      }),
    },
  });
  FakeSocket.instances = [];
  FakePeer.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("answering an incoming call", () => {
  it("applies the candidates Janus sent while the call was ringing", async () => {
    const { phone, sip } = await readyPhone();
    sip.onmessage?.(
      event(
        { sip: "event", result: { event: "incomingcall", username: "1234" } },
        {
          type: "offer",
          sdp: "v=0",
        },
      ),
    );
    // Janus trickles its media addresses while the call is still ringing, so no
    // peer connection exists yet.
    sip.onmessage?.(trickle(1));
    sip.onmessage?.(trickle(2));

    await phone.answer();

    const call = FakePeer.instances.at(-1);
    expect(call?.remoteSet).toBe(true);
    expect(call?.added).toEqual([candidate(1), candidate(2)]);
    await phone.stop();
  });

  it("holds the candidates of an offerless INVITE until the answer lands", async () => {
    const { phone, sip } = await readyPhone();
    // A delayed-offer INVITE carries no SDP: Janus wants our offer in the
    // `accept`, and its own answer arrives later in `accepted`.
    sip.onmessage?.(
      event({ sip: "event", result: { event: "incomingcall", username: "1234" } }),
    );
    sip.onmessage?.(trickle(7));

    await phone.answer();
    const call = FakePeer.instances.at(-1);
    expect(call?.added).toEqual([]);

    sip.onmessage?.(
      event(
        { sip: "event", result: { event: "accepted" } },
        { type: "answer", sdp: "v=0" },
      ),
    );
    // The plugin event is taken synchronously and the description applied on
    // the next microtask, so let the held candidates drain before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(call?.added).toEqual([candidate(7)]);
    await phone.stop();
  });

  it("asks the bridge's STUN responder for the browser's own address", async () => {
    const { phone, sip } = await readyPhone();
    sip.onmessage?.(
      event(
        { sip: "event", result: { event: "incomingcall", username: "1234" } },
        {
          type: "offer",
          sdp: "v=0",
        },
      ),
    );

    await phone.answer();

    const call = FakePeer.instances.at(-1);
    expect(call?.config?.iceServers).toEqual([
      { urls: `stun:${window.location.hostname}:${BRIDGE_STUN_PORT}` },
    ]);
    await phone.stop();
  });
});
