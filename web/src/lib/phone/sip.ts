/**
 * The phone on the Janus SIP plugin (ADR 0023).
 *
 * The browser is the SIP user agent this makes possible: it registers one
 * account, places and answers one call, and negotiates the WebRTC media Janus
 * relays to the provider. Everything here is per the tab that holds the line;
 * where the seat itself is held is the store's, not this module's.
 *
 * Nothing is spoken to the page but JSEP and the plugin's own events. The
 * credential is the account's own, read by the account's own client.
 */
import type { SipCredential } from "@gilbert/shared/phone";
import { withBase } from "@/lib/basePath";
import { Janus, type Jsep } from "./janus";

/** The line as the top-bar entry reads it. */
export type LineState = "connecting" | "registered" | "unavailable";

/** A call as the surface reads it. */
export interface ActiveCall {
  remote: string;
}

export interface PhoneHooks {
  onLine(state: LineState): void;
  /** A call is ringing; the empty string clears it. */
  onIncoming(from: string): void;
  /** The call, and the audio to play, or nulls when there is none. */
  onCall(call: ActiveCall | null, stream: MediaStream | null): void;
  onError(message: string): void;
}

/** The address of record a credential registers. */
export function sipAddress(credential: SipCredential): string {
  return `sip:${credential.username}@${credential.server}`;
}

/** What to invite for a target typed or read from a contact. */
export function callUri(credential: SipCredential, target: string): string {
  const value = target.trim();
  if (/^sips?:/i.test(value)) return value;
  if (value.includes("@")) return `sip:${value}`;
  return `sip:${value}@${credential.server}`;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The codecs the ADR pins: G.711 both ways, and the telephone-event the DTMF
 * sender needs. Offered first, so the bridge negotiates them and relays without
 * transcoding.
 */
function preferG711(transceiver: RTCRtpTransceiver): void {
  const codecs = RTCRtpSender.getCapabilities("audio")?.codecs ?? [];
  const wanted = codecs.filter((codec) => {
    const name = (codec.mimeType.split("/")[1] ?? "").toLowerCase();
    return name === "pcmu" || name === "pcma" || name === "telephone-event";
  });
  if (wanted.length) transceiver.setCodecPreferences(wanted);
}

/** The bridge's socket, on this page's own origin. */
function bridgeUrl(): string {
  const url = new URL(withBase("/api/phone"), window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

interface SipData {
  sip?: string;
  error?: string;
  result?: {
    event: string;
    username?: string;
    displayname?: string;
    caller?: string;
  };
}

function isSipData(data: unknown): data is SipData {
  return typeof data === "object" && data !== null && "sip" in data;
}

/** How long a call, or a reconnection, is given before it is called failed. */
const PROBE_TIMEOUT_MS = 6000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class Phone {
  private janus: Janus | null = null;
  private pc: RTCPeerConnection | null = null;
  private sender: RTCRtpSender | null = null;
  private stream: MediaStream | null = null;
  private remote = "";
  private ringing: { offer?: Jsep } | null = null;
  private muted = false;
  private ended = false;
  private reconnect: number | null = null;
  private failures = 0;

  constructor(
    private readonly credential: SipCredential,
    private readonly hooks: PhoneHooks,
  ) {}

  /** Register the line, and keep trying while the tab holds the seat. */
  async start(): Promise<void> {
    this.ended = false;
    try {
      await this.connect();
    } catch (err) {
      this.hooks.onError(reason(err));
      this.hooks.onLine("unavailable");
      this.scheduleReconnect();
    }
  }

  /** Give the line up: hang up, unregister and stop retrying. */
  async stop(): Promise<void> {
    this.ended = true;
    if (this.reconnect !== null) {
      window.clearTimeout(this.reconnect);
      this.reconnect = null;
    }
    this.endCall();
    const janus = this.janus;
    this.janus = null;
    janus?.message({ request: "unregister" });
    janus?.close();
  }

  /** Place a call to a contact's number or an address typed by hand. */
  async call(target: string): Promise<void> {
    const janus = this.janus;
    if (!janus) throw new Error("The phone is not connected.");
    if (this.pc || this.ringing) throw new Error("The line is busy.");
    const pc = this.newPeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.remote = target;
    janus.message(
      { request: "call", uri: callUri(this.credential, target) },
      { type: "offer", sdp: offer.sdp ?? "" },
    );
    this.hooks.onCall({ remote: target }, null);
  }

  /** Answer the ringing call. */
  async answer(): Promise<void> {
    const janus = this.janus;
    const ringing = this.ringing;
    if (!janus || !ringing) return;
    this.ringing = null;
    const pc = this.newPeer();
    if (ringing.offer) await pc.setRemoteDescription(ringing.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    janus.message({ request: "accept" }, { type: "answer", sdp: answer.sdp ?? "" });
    this.hooks.onCall({ remote: this.remote }, this.stream);
  }

  /** Decline the ringing call. */
  async decline(): Promise<void> {
    this.janus?.message({ request: "decline" });
    this.ringing = null;
    this.remote = "";
    this.hooks.onIncoming("");
    this.hooks.onCall(null, null);
  }

  /** End the call, wherever it is. */
  async hangup(): Promise<void> {
    if (this.ringing) {
      await this.decline();
      return;
    }
    this.janus?.message({ request: "hangup" });
  }

  /** Mute or unmute this end. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    const track = this.sender?.track;
    if (track) track.enabled = !muted;
  }

  /** Send DTMF tones as RFC 2833, in-band on this end. */
  sendDtmf(tones: string): void {
    this.sender?.dtmf?.insertDTMF(tones);
  }

  private async connect(): Promise<void> {
    this.hooks.onLine("connecting");
    await this.mediaReachable();
    const janus = new Janus(bridgeUrl(), this.janusHooks());
    this.janus = janus;
    await janus.open("janus.plugin.sip");
    janus.message({
      request: "register",
      username: sipAddress(this.credential),
      secret: this.credential.password,
      proxy: `sip:${this.credential.server}`,
      display_name: this.credential.username,
    });
  }

  /**
   * Whether this browser can reach the bridge's media at all.
   *
   * Registration crosses Janus's own leg to the provider and says nothing about
   * the page's: a deployment whose media ports are closed would register and
   * then fail every call. The probe negotiates a throwaway WebRTC path with the
   * bridge's echo test, and only a path that actually comes up is the proof the
   * phone is offered.
   */
  private async mediaReachable(): Promise<void> {
    let pc: RTCPeerConnection | null = null;
    const janus = new Janus(bridgeUrl(), {
      onEvent: (plugin, _data, jsep) => {
        if (plugin === "janus.plugin.echotest" && jsep && pc)
          void pc.setRemoteDescription(jsep).catch(() => undefined);
      },
      onRemoteCandidate: (candidate) => {
        void pc?.addIceCandidate(candidate).catch(() => undefined);
      },
      onMediaGone: () => undefined,
      onClosed: () => undefined,
    });
    await janus.open("janus.plugin.echotest");
    const connection = new RTCPeerConnection();
    pc = connection;
    const reached = new Promise<boolean>((resolve) => {
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "connected") resolve(true);
        else if (connection.connectionState === "failed") resolve(false);
      };
      window.setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
    });
    connection.onicecandidate = (event) => {
      janus.trickle(event.candidate ? event.candidate.toJSON() : { completed: true });
    };
    connection.addTransceiver("audio", { direction: "sendrecv" });
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    janus.message({ audio: true, video: false }, { type: "offer", sdp: offer.sdp ?? "" });
    const ok = await reached;
    try {
      connection.close();
    } catch {
      /* nothing to close */
    }
    janus.close();
    if (!ok)
      throw new Error(
        "The phone bridge could not carry media: its media ports are not reachable.",
      );
  }

  private newPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection();
    this.pc = pc;
    const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    preferG711(transceiver);
    this.sender = transceiver.sender;
    const track = transceiver.sender.track;
    if (track) track.enabled = !this.muted;
    pc.onicecandidate = (event) => {
      this.janus?.trickle(
        event.candidate ? event.candidate.toJSON() : { completed: true },
      );
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.stream = stream;
      this.hooks.onCall({ remote: this.remote }, stream);
    };
    return pc;
  }

  private janusHooks() {
    return {
      onEvent: (plugin: string, data: unknown, jsep?: Jsep) => {
        if (plugin !== "janus.plugin.sip" || !isSipData(data)) return;
        if (typeof data.error === "string" && data.error) {
          this.hooks.onError(data.error);
          return;
        }
        if (data.result) this.sipEvent(data.result, jsep);
      },
      onRemoteCandidate: (candidate: RTCIceCandidateInit) => {
        void this.pc?.addIceCandidate(candidate).catch(() => undefined);
      },
      onMediaGone: () => this.endCall(),
      onClosed: () => {
        if (this.ended) return;
        this.hooks.onLine("connecting");
        this.scheduleReconnect();
      },
    };
  }

  private sipEvent(result: NonNullable<SipData["result"]>, jsep: Jsep | undefined): void {
    switch (result.event) {
      case "registered":
        this.failures = 0;
        this.hooks.onLine("registered");
        return;
      case "registration_failed":
        this.hooks.onLine("unavailable");
        this.hooks.onError("The line could not register with the SIP server.");
        return;
      case "incomingcall":
        this.remote = result.username ?? result.caller ?? "";
        this.ringing = { offer: jsep };
        this.hooks.onIncoming(this.remote);
        return;
      case "accepted":
        if (jsep) void this.pc?.setRemoteDescription(jsep).catch(() => undefined);
        this.hooks.onCall({ remote: this.remote }, this.stream);
        return;
      case "hangup":
      case "declined":
      case "failed":
        this.endCall();
        return;
      default:
        return;
    }
  }

  /** Drop the call and its media. */
  private endCall(): void {
    this.ringing = null;
    this.remote = "";
    this.stream = null;
    this.sender = null;
    const pc = this.pc;
    this.pc = null;
    try {
      pc?.close();
    } catch {
      /* already closed */
    }
    this.hooks.onIncoming("");
    this.hooks.onCall(null, null);
  }

  private scheduleReconnect(): void {
    if (this.ended || this.reconnect !== null) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.failures);
    this.failures += 1;
    this.reconnect = window.setTimeout(() => {
      this.reconnect = null;
      if (this.ended) return;
      void this.connect().catch((err) => {
        this.hooks.onError(reason(err));
        this.hooks.onLine("unavailable");
        this.scheduleReconnect();
      });
    }, delay);
  }
}
