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
import { t } from "@/lib/i18n";
import { Janus, type JanusHooks, type Jsep } from "./janus";
import { microphoneMessage, openMicrophone } from "./microphone";

/** The line as the top-bar entry reads it. */
export type LineState = "connecting" | "registered" | "unavailable";

/** A call as the surface reads it. */
export interface ActiveCall {
  remote: string;
}

export interface PhoneHooks {
  onLine(state: LineState): void;
  /**
   * The media path to the bridge is proven, so the phone may be offered. It is
   * what separates "no phone" (no media, per the record) from "a line that is
   * there but not registered" (the red glyph, with its reason readable).
   */
  onProven(): void;
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

/**
 * Whether this browser can reach the bridge's media at all.
 *
 * The one media probe: it negotiates a throwaway WebRTC path with the bridge's
 * echo test, and only a path that actually comes up is proof the media range is
 * open. The phone uses it before offering itself, and the administration's
 * bridge status uses it on demand. Everything it opened is closed on every
 * path, success or not.
 */
export async function probeBridgeMedia(): Promise<boolean> {
  let pc: RTCPeerConnection | null = null;
  let timer: number | null = null;
  // Resolves the wait when Janus refuses a request: it will not answer an offer
  // it rejected, so waiting the probe out would only lose the reason.
  let giveUp: (() => void) | null = null;
  const janus = new Janus(bridgeUrl(), {
    onEvent: (plugin, _data, jsep) => {
      if (plugin === "janus.plugin.echotest" && jsep && pc)
        void pc.setRemoteDescription(jsep).catch(() => undefined);
    },
    onRemoteCandidate: (candidate) => {
      void pc?.addIceCandidate(candidate).catch(() => undefined);
    },
    onMediaGone: () => undefined,
    onRefused: () => giveUp?.(),
    onClosed: () => undefined,
  });
  try {
    await janus.open("janus.plugin.echotest");
    const connection = new RTCPeerConnection();
    pc = connection;
    const reached = new Promise<boolean>((resolve) => {
      giveUp = () => resolve(false);
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "connected") resolve(true);
        else if (connection.connectionState === "failed") resolve(false);
      };
      timer = window.setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
    });
    connection.onicecandidate = (event) => {
      janus.trickle(event.candidate ? event.candidate.toJSON() : { completed: true });
    };
    connection.addTransceiver("audio", { direction: "sendrecv" });
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    janus.message({ audio: true, video: false }, { type: "offer", sdp: offer.sdp ?? "" });
    return await reached;
  } catch {
    return false;
  } finally {
    if (timer !== null) window.clearTimeout(timer);
    pc?.close();
    janus.close();
  }
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
  private local: MediaStream | null = null;
  private stream: MediaStream | null = null;
  private remote = "";
  private ringing: { offer?: Jsep } | null = null;
  private muted = false;
  private ended = false;
  /** Whether the media path has already been proven for this line. */
  private mediaProven = false;
  private reconnect: number | null = null;
  private failures = 0;
  /** Whether a connection attempt is on its way, so two cannot race. */
  private connecting = false;

  constructor(
    private readonly credential: SipCredential,
    private readonly hooks: PhoneHooks,
  ) {}

  /** Register the line, and keep trying while the tab holds the seat. */
  async start(): Promise<void> {
    this.ended = false;
    // The network coming back is the one signal the browser gives that a retry
    // is worth making now: waiting out an accumulated backoff would leave the
    // line dead long after the network under it is healthy again.
    window.addEventListener("online", this.onOnline);
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
    window.removeEventListener("online", this.onOnline);
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
    if (!janus) throw new Error(t("The phone is not connected."));
    if (this.pc || this.ringing) throw new Error(t("The line is busy."));
    const pc = await this.newPeer();
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.remote = target;
      janus.message(
        { request: "call", uri: callUri(this.credential, target) },
        { type: "offer", sdp: offer.sdp ?? "" },
      );
      this.hooks.onCall({ remote: target }, null);
    } catch (err) {
      this.endCall();
      throw err;
    }
  }

  /**
   * Answer the ringing call.
   *
   * A regular INVITE carries an offer, and the answer goes back as an answer.
   * A delayed-offer INVITE carries none, and then Janus wants the `accept` to
   * carry our **offer**, with the callee's answer arriving later in `accepted`.
   */
  async answer(): Promise<void> {
    const janus = this.janus;
    const ringing = this.ringing;
    if (!janus || !ringing) return;
    this.ringing = null;
    const pc = await this.newPeer();
    try {
      let sdp: Jsep;
      if (ringing.offer) {
        await pc.setRemoteDescription(ringing.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sdp = { type: "answer", sdp: answer.sdp ?? "" };
      } else {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sdp = { type: "offer", sdp: offer.sdp ?? "" };
      }
      janus.message({ request: "accept" }, sdp);
      this.hooks.onCall({ remote: this.remote }, this.stream);
    } catch (err) {
      this.endCall();
      throw err;
    }
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
    // One attempt at a time: a network return and a pending retry can both ask
    // within the same moment, and two sessions would race for the one line.
    if (this.connecting) return;
    this.connecting = true;
    try {
      this.hooks.onLine("connecting");
      // The media path is probed once: it is the browser's network that decides
      // it, and that does not change between a socket that dropped and its
      // replacement. Registration crosses Janus's leg to the provider and says
      // nothing about the page's, so a bridge whose ports are closed must show no
      // phone rather than a line that fails on the first call.
      if (!this.mediaProven) {
        await this.mediaReachable();
        if (this.ended) return;
        this.mediaProven = true;
      }
      // The media path is proven (or was): the phone is offered from here, and a
      // registration that fails is the red glyph, not an invisible absence.
      this.hooks.onProven();
      const janus = new Janus(bridgeUrl(), this.janusHooks());
      const previous = this.janus;
      this.janus = janus;
      previous?.close();
      try {
        await janus.open("janus.plugin.sip");
      } catch (err) {
        if (this.janus === janus) this.janus = null;
        janus.close();
        throw err;
      }
      if (this.ended) {
        if (this.janus === janus) this.janus = null;
        janus.close();
        return;
      }
      janus.message({
        request: "register",
        username: sipAddress(this.credential),
        secret: this.credential.password,
        proxy: `sip:${this.credential.server}`,
        display_name: this.credential.username,
      });
    } finally {
      this.connecting = false;
    }
  }

  /** Whether this browser can reach the bridge's media; throws when it cannot. */
  private async mediaReachable(): Promise<void> {
    if (!(await probeBridgeMedia()))
      throw new Error(
        t(
          "The browser cannot carry the phone's media to Gilbert: its media ports are not reachable. The problem is between this browser and Gilbert, not with the SIP provider.",
        ),
      );
  }

  /** A PeerConnection with a live microphone on it, or a clear failure. */
  private async newPeer(): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection();
    const opened = await openMicrophone();
    if (!opened.ok) {
      pc.close();
      throw new Error(microphoneMessage(opened.reason));
    }
    const media = opened.stream;
    const track = media.getAudioTracks()[0];
    if (!track) {
      for (const other of media.getTracks()) other.stop();
      pc.close();
      throw new Error(microphoneMessage("no-device"));
    }
    const transceiver = pc.addTransceiver(track, {
      direction: "sendrecv",
      streams: [media],
    });
    preferG711(transceiver);
    this.pc = pc;
    this.sender = transceiver.sender;
    this.local = media;
    track.enabled = !this.muted;
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

  private janusHooks(): JanusHooks {
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
      onRefused: (reason) => this.hooks.onError(reason),
      onClosed: () => {
        if (this.ended) return;
        /*
         * The handle, and the call on it, went with the socket: the reconnect
         * opens a new session, so a call that was live cannot be recovered.
         * Ending it here stops the microphone and clears the surface rather
         * than leaving a dead call on screen until the line registers again.
         */
        this.endCall();
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
        // The line reached Gilbert and Gilbert could not reach the SIP server:
        // the failure is on the server's leg to the provider, not the browser's
        // to Gilbert. Every registering tab fails the same way, so every handset
        // turns red with this cause rather than the reader looking at their own
        // network.
        this.hooks.onLine("unavailable");
        this.hooks.onError(
          t(
            "The line did not register with the SIP server. The problem is between Gilbert and the SIP provider, not between this browser and Gilbert.",
          ),
        );
        return;
      case "incomingcall":
        this.remote = result.username ?? result.caller ?? "";
        this.ringing = { offer: jsep };
        this.hooks.onIncoming(this.remote);
        return;
      case "progress":
        // Early media: the answer arrived in a 183, so `accepted` will carry
        // none. Take it now, so the audio can start before the call is up.
        if (jsep) void this.pc?.setRemoteDescription(jsep).catch(() => undefined);
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

  /** Drop the call, its media and the microphone with it. */
  private endCall(): void {
    this.ringing = null;
    this.remote = "";
    this.stream = null;
    this.sender = null;
    const local = this.local;
    this.local = null;
    if (local) for (const track of local.getTracks()) track.stop();
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
      // A connect already on its way owns the line: let it finish rather than
      // racing it, and try again if it has not settled by then.
      if (this.connecting) {
        this.scheduleReconnect();
        return;
      }
      void this.connect().catch((err) => {
        this.hooks.onError(reason(err));
        this.hooks.onLine("unavailable");
        this.scheduleReconnect();
      });
    }, delay);
  }

  /**
   * The network is back: drop the accumulated backoff and try now.
   *
   * The browser fires this on a wake, a network change and a regained link,
   * and it is the one moment a retry is more likely to succeed than the one the
   * backoff would have waited for. A connect already on its way is left to
   * finish: two attempts at once would race for the one line.
   */
  private onOnline = () => {
    if (this.ended || this.connecting) return;
    if (this.reconnect !== null) {
      window.clearTimeout(this.reconnect);
      this.reconnect = null;
    }
    this.failures = 0;
    void this.connect().catch((err) => {
      this.hooks.onError(reason(err));
      this.hooks.onLine("unavailable");
      this.scheduleReconnect();
    });
  };
}
