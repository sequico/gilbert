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
import { BRIDGE_STUN_PORT, type SipCredential } from "@gilbert/shared/phone";
import { withBase } from "@/lib/basePath";
import { t } from "@/lib/i18n";
import type { CallLogEntry } from "./callLog";
import { Janus, type JanusHooks, type Jsep } from "./janus";
import { microphoneMessage, openMicrophone } from "./microphone";
import { PHONE_MOCK } from "./mock";

/** The line as the top-bar entry reads it. */
export type LineState = "connecting" | "registered" | "unavailable";

/**
 * Where a call has got to, as the call surface reads it: the phase its status
 * line names. `calling` from the INVITE going out until the provider answers,
 * `ringing` for a 180/183, `connected` once the media is up, and one terminal
 * phase per way a call can fail — a busy line, a number with no route, an
 * unavailable one, a decline, or anything else. A terminal phase is held for a
 * moment so the reader can read it, then the call ends.
 */
export type CallPhase =
  | "calling"
  | "ringing"
  | "connected"
  | "busy"
  | "no-route"
  | "unavailable"
  | "declined"
  | "failed";

/** The phase a SIP status code ends a call with. */
export function phaseForSipCode(code: number | undefined): CallPhase {
  switch (code) {
    case 486:
    case 600:
      return "busy";
    case 404:
      return "no-route";
    case 408:
    case 480:
    case 487:
      return "unavailable";
    default:
      return "failed";
  }
}

/** The sentence a phase shows, translated where the status line renders. */
const CALL_PHASE_LABELS: Record<CallPhase, string> = {
  calling: "Calling…",
  ringing: "Ringing…",
  connected: "Connected",
  busy: "The line is busy",
  "no-route": "No route to this number",
  unavailable: "This number is not available",
  declined: "The call was declined",
  failed: "The call could not be completed",
};

/** The status line's sentence for a phase. */
export function callPhaseLabel(phase: CallPhase): string {
  return t(CALL_PHASE_LABELS[phase]);
}

/** A call as the surface reads it: who, and where it has got to. */
export interface ActiveCall {
  remote: string;
  phase: CallPhase;
}

export interface PhoneHooks {
  onLine(state: LineState): void;
  /**
   * The bridge socket is up (`true`) or gone (`false`). It is the browser's own
   * path to Gilbert, kept apart from the media proof and the SIP registration so
   * the surface's first status dot can be true in real time rather than once.
   */
  onBridge(up: boolean): void;
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
  /** A call ended: the one place an entry is born, so the log's shape is the phone's. */
  onCallEnded(entry: CallLogEntry): void;
  /**
   * A leg the line needs is down, with the cause: the browser's path to Gilbert
   * ("media"), or the registration with the SIP provider ("sip"). The two are
   * kept apart so each can be explained where it is shown.
   */
  onLineFailure(leg: "media" | "sip", reason: string): void;
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
 * The bridge's STUN responder, for the browser's own address.
 *
 * The responder is a sibling of the bridge on the same host the page is served
 * from, so the host name is the page's own and the port comes from its one
 * definition. Without it ICE still learns the browser's address
 * peer-reflexively, but only once a check has already crossed; the
 * server-reflexive candidate makes the media path deterministic.
 */
function stunServers(): RTCIceServer[] {
  return [{ urls: `stun:${window.location.hostname}:${BRIDGE_STUN_PORT}` }];
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
    const connection = new RTCPeerConnection({ iceServers: stunServers() });
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
    /** The SIP status code a terminal event carries (486, 404, …). */
    code?: number;
    /** Its reason phrase, for the log and the reader. */
    reason?: string;
  };
}

function isSipData(data: unknown): data is SipData {
  return typeof data === "object" && data !== null && "sip" in data;
}

/** How long a call, or a reconnection, is given before it is called failed. */
const PROBE_TIMEOUT_MS = 6000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/**
 * How long a terminal phase stays on screen before the call clears. A busy line
 * or a number with no route is the whole answer the reader was waiting for, and
 * clearing the surface the instant it arrives is what makes a call look like it
 * silently did nothing.
 */
const FAILED_HOLD_MS = 4000;

export class Phone {
  private janus: Janus | null = null;
  private pc: RTCPeerConnection | null = null;
  private sender: RTCRtpSender | null = null;
  private local: MediaStream | null = null;
  private stream: MediaStream | null = null;
  private remote = "";
  private ringing: { offer?: Jsep } | null = null;
  /** Remote candidates that arrived before the description they belong to. */
  private pendingCandidates: RTCIceCandidateInit[] = [];
  /** Whether the peer connection has a remote description to add to. */
  private remoteReady = false;
  private muted = false;
  private ended = false;
  /** Whether the media path has already been proven for this line. */
  private mediaProven = false;
  private reconnect: number | null = null;
  private failures = 0;
  /** Whether a connection attempt is on its way, so two cannot race. */
  private connecting = false;
  /** Where the current call has got to, for the status line. */
  private phase: CallPhase = "calling";
  /** The timer that clears a terminal phase once its hold is over. */
  private finishTimer: number | null = null;
  /** Bumped per mock call, so a stale mock timer cannot touch a later one. */
  private mockRun = 0;
  /** Whether this end asked for the call to end, so a 487 is not called failed. */
  private cancelling = false;
  /** The call in progress, for the one entry the log gets when it ends. */
  private callMeta: {
    direction: "in" | "out";
    remote: string;
    at: number;
    connectedAt: number | null;
    outcome: CallLogEntry["outcome"];
  } | null = null;

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
      this.hooks.onLineFailure("media", reason(err));
      this.hooks.onLine("unavailable");
      this.scheduleReconnect();
    }
  }

  /** Give the line up: hang up, unregister and stop retrying. */
  async stop(): Promise<void> {
    this.ended = true;
    this.hooks.onBridge(false);
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
    this.clearFinish();
    this.cancelling = false;
    this.pendingCandidates = [];
    this.remoteReady = false;
    if (PHONE_MOCK) {
      // No bridge to carry it: walk the phases, then let it end on its own so
      // the surface and the history move the way they do for a real one.
      this.remote = target;
      this.callMeta = {
        direction: "out",
        remote: target,
        at: Date.now(),
        connectedAt: null,
        outcome: "failed",
      };
      this.phase = "calling";
      this.emitCall(null);
      const run = ++this.mockRun;
      const later = (ms: number, fn: () => void) =>
        window.setTimeout(() => {
          if (this.mockRun === run && !this.ended) fn();
        }, ms);
      later(800, () => {
        this.phase = "ringing";
        this.emitCall(null);
      });
      later(1700, () => {
        this.markConnected();
        this.phase = "connected";
        this.emitCall(null);
      });
      later(4500, () => this.endCall());
      return;
    }
    const janus = this.janus;
    if (!janus) throw new Error(t("The phone is not connected."));
    if (this.pc || this.ringing) throw new Error(t("The line is busy."));
    const pc = await this.newPeer();
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.remote = target;
      this.callMeta = {
        direction: "out",
        remote: target,
        at: Date.now(),
        connectedAt: null,
        outcome: "failed",
      };
      janus.message(
        { request: "call", uri: callUri(this.credential, target) },
        { type: "offer", sdp: offer.sdp ?? "" },
      );
      this.phase = "calling";
      this.emitCall();
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
        await this.setRemote(ringing.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sdp = { type: "answer", sdp: answer.sdp ?? "" };
      } else {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sdp = { type: "offer", sdp: offer.sdp ?? "" };
      }
      janus.message({ request: "accept" }, sdp);
      this.phase = "connected";
      this.emitCall();
    } catch (err) {
      this.endCall();
      throw err;
    }
  }

  /** Decline the ringing call. */
  async decline(): Promise<void> {
    if (this.callMeta) this.callMeta.outcome = "declined";
    this.cancelling = true;
    this.janus?.message({ request: "decline" });
    this.endCall();
  }

  /** End the call, wherever it is. */
  async hangup(): Promise<void> {
    if (this.ringing) {
      await this.decline();
      return;
    }
    this.cancelling = true;
    if (PHONE_MOCK) {
      this.endCall();
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
      if (PHONE_MOCK) {
        // No bridge in the mock: pretend the media path and the registration, so
        // the surface can be seen and driven without a Janus.
        this.mediaProven = true;
        this.hooks.onBridge(true);
        this.hooks.onProven();
        this.hooks.onLine("registered");
        return;
      }
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
        this.hooks.onBridge(false);
        throw err;
      }
      if (this.ended) {
        if (this.janus === janus) this.janus = null;
        janus.close();
        return;
      }
      // The socket is up: the browser's own path to Gilbert exists, whatever
      // the registration does next.
      this.hooks.onBridge(true);
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
    const pc = new RTCPeerConnection({ iceServers: stunServers() });
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
    this.remoteReady = false;
    track.enabled = !this.muted;
    pc.onicecandidate = (event) => {
      this.janus?.trickle(
        event.candidate ? event.candidate.toJSON() : { completed: true },
      );
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.stream = stream;
      this.markConnected();
      this.phase = "connected";
      this.emitCall(stream);
    };
    return pc;
  }

  /**
   * Apply a remote description, then the candidates that arrived before it.
   *
   * An incoming call is offered while no peer connection exists yet, and Janus
   * trickles its candidates as the offer goes out. `addIceCandidate` before a
   * remote description is an error, so candidates are held and applied here
   * the moment there is a description to attach them to. Without this the
   * answered call would have no remote candidates and the media path would
   * never come up.
   */
  private async setRemote(sdp: Jsep): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    await pc.setRemoteDescription(sdp);
    this.remoteReady = true;
    const held = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of held) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* a candidate the description no longer accepts */
      }
    }
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
        const pc = this.pc;
        // No peer connection yet, or no remote description to attach a
        // candidate to: hold it. An incoming call offers this way — Janus
        // trickles its candidates while the call is still ringing, and
        // `addIceCandidate` before the description is an error.
        if (!pc || !this.remoteReady) {
          this.pendingCandidates.push(candidate);
          return;
        }
        void pc.addIceCandidate(candidate).catch(() => undefined);
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
        this.hooks.onBridge(false);
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
        this.hooks.onLineFailure(
          "sip",
          t(
            "The line did not register with the SIP server. The problem is between Gilbert and the SIP provider, not between this browser and Gilbert.",
          ),
        );
        return;
      case "incomingcall":
        // A fresh window for this invitation's candidates: the offer is
        // stored, and the candidates Janus sends while it rings are held
        // until `answer` has a description to apply them to.
        this.pendingCandidates = [];
        this.remoteReady = false;
        this.remote = result.username ?? result.caller ?? "";
        this.ringing = { offer: jsep };
        this.callMeta = {
          direction: "in",
          remote: this.remote,
          at: Date.now(),
          connectedAt: null,
          outcome: "missed",
        };
        this.hooks.onIncoming(this.remote);
        return;
      case "calling":
        this.phase = "calling";
        this.emitCall();
        return;
      case "ringing":
        this.phase = "ringing";
        this.emitCall();
        return;
      case "progress":
        // Early media: the answer arrived in a 183, so `accepted` will carry
        // none. Take it now, so the audio can start before the call is up.
        if (jsep) void this.setRemote(jsep).catch(() => undefined);
        this.phase = "ringing";
        this.emitCall();
        return;
      case "accepted":
        if (jsep) void this.setRemote(jsep).catch(() => undefined);
        this.markConnected();
        this.phase = "connected";
        this.emitCall();
        return;
      case "declined":
        // The remote refused our call: a phase the reader can read, held a
        // moment, rather than a surface that clears as if nothing happened.
        if (this.callMeta?.direction === "out") this.fail("declined");
        else this.endCall();
        return;
      case "hangup":
      case "failed": {
        const code = result.code;
        if (this.cancelling) this.endCall();
        else if (this.callMeta?.direction === "out" && code !== undefined && code >= 300)
          this.fail(phaseForSipCode(code));
        else this.endCall();
        return;
      }
      default:
        return;
    }
  }

  /** Tell the surface where the call is now, and the audio it should play. */
  private emitCall(stream: MediaStream | null = this.stream): void {
    this.hooks.onCall(
      this.callMeta && this.remote ? { remote: this.remote, phase: this.phase } : null,
      stream,
    );
  }

  /**
   * End the call with a phase the reader can read, and hold it briefly.
   *
   * The media and the microphone go at once — there is nothing left to carry —
   * but the call stays on screen for `FAILED_HOLD_MS` so "busy" or "no route"
   * is actually seen, then clears and writes its one log entry.
   */
  private fail(phase: CallPhase): void {
    if (this.callMeta)
      this.callMeta.outcome = phase === "declined" ? "declined" : "failed";
    this.teardownMedia();
    this.phase = phase;
    this.emitCall(null);
    this.clearFinish();
    this.finishTimer = window.setTimeout(() => {
      this.finishTimer = null;
      this.finishCall();
    }, FAILED_HOLD_MS);
  }

  private clearFinish(): void {
    if (this.finishTimer === null) return;
    window.clearTimeout(this.finishTimer);
    this.finishTimer = null;
  }

  /** The call is up: from here it is measured, and it counts as answered. */
  private markConnected(): void {
    if (this.callMeta && this.callMeta.connectedAt === null) {
      this.callMeta.connectedAt = Date.now();
      this.callMeta.outcome = "answered";
    }
  }

  /** Stop the media: the peer, the microphone and the audio all go. */
  private teardownMedia(): void {
    this.ringing = null;
    this.stream = null;
    this.sender = null;
    this.pendingCandidates = [];
    this.remoteReady = false;
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
  }

  /** Clear the surface and write the one log entry this call gets. */
  private finishCall(): void {
    this.clearFinish();
    // The entry is born before anything is cleared: it reads what the call was.
    const meta = this.callMeta;
    this.callMeta = null;
    if (meta)
      this.hooks.onCallEnded({
        at: meta.at,
        direction: meta.direction,
        remote: meta.remote,
        seconds: meta.connectedAt
          ? Math.max(0, Math.round((Date.now() - meta.connectedAt) / 1000))
          : 0,
        outcome: meta.connectedAt ? "answered" : meta.outcome,
      });
    this.remote = "";
    this.phase = "calling";
    // A later dial must not be ended by a timer left over from this one.
    this.mockRun += 1;
    this.cancelling = false;
    this.hooks.onIncoming("");
    this.hooks.onCall(null, null);
  }

  /** Drop the call, its media and the microphone with it. */
  private endCall(): void {
    this.teardownMedia();
    this.finishCall();
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
        this.hooks.onLineFailure("media", reason(err));
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
      this.hooks.onLineFailure("media", reason(err));
      this.hooks.onLine("unavailable");
      this.scheduleReconnect();
    });
  };
}
