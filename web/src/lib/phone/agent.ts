/**
 * The SIP.js user agent, wrapped thin (ADR 0023).
 *
 * The engine's own API is kept behind a small surface — a line state, the calls
 * on it and which one is active, and the handful of actions the call surface
 * needs — so the store holds state rather than the library's objects, and a
 * change of engine would be this file and nothing else.
 *
 * More than one call is carried, which is what call waiting is: a second
 * invitation is answered while the first is held, and the reader switches
 * between them. SIP.js has no re-INVITE on a received call, so the hold is the
 * media: the held call's outgoing audio is disabled and the active call's is
 * the one played — the remote hears silence, and the reader hears one call.
 *
 * Reliability is the point of the configuration here: the transport reconnects
 * with backoff and re-registers, a broken media path is restarted with a
 * re-INVITE, and the registration's life is short enough that a browser killed
 * outright stops being rung within the half-minute. The reader is asked for
 * nothing while any of it happens; the line's colour is the only report.
 */
import {
  Invitation,
  Inviter,
  Registerer,
  RegistererState,
  type Session,
  SessionState,
  UserAgent,
  type Web,
} from "sip.js";

/** The line's state: what the top-bar entry's colour says. */
export type PhoneLineState = "connecting" | "registered" | "unavailable";

export interface PhoneAgentOptions {
  /** The account's SIP address of record, `sip:user@domain` or a bare address. */
  address: string;
  /** The secret the registrar authenticates it with. */
  password: string;
  /** The SIP-over-WebSocket endpoint in use, `wss://…`. */
  server: string;
  /** STUN/TURN, from the installation's own settings. */
  iceServers: RTCIceServer[];
}

/** One call as the surface reads it. */
export interface PhoneCallView {
  remote: string;
  active: boolean;
}

export interface PhoneAgentHooks {
  onLine(state: PhoneLineState): void;
  /** An invitation arrived; a call may already be live (call waiting). */
  onIncoming(from: string): void;
  /** The calls on the line, and the audio of the active one. */
  onCalls(calls: PhoneCallView[], stream: MediaStream | null): void;
  /** Something failed, in a sentence worth showing. */
  onError(message: string): void;
}

/** The registration's life, in seconds (ADR 0023: a short one). */
const REGISTRATION_EXPIRES = 30;

/** The bare SIP user a registrar authenticates, from an address of record. */
function authUser(address: string): string {
  return address.replace(/^sips?:/i, "").replace(/;.*$/, "");
}

/** Whether a target the reader typed is a full SIP URI or a bare number/address. */
export function toSipUri(target: string): string {
  return /^sips?:/i.test(target) ? target : `sip:${target}`;
}

export class PhoneAgent {
  private ua: UserAgent | undefined;
  private registerer: Registerer | undefined;
  /** Every live or ringing call, by session, with the remote it is with. */
  private readonly calls = new Map<Session, string>();
  private active: Session | undefined;
  private ringing: Invitation | undefined;
  private ringingFrom = "";
  private muted = false;
  private ended = false;

  constructor(
    private readonly options: PhoneAgentOptions,
    private readonly hooks: PhoneAgentHooks,
  ) {}

  get activeSession(): Session | undefined {
    return this.active;
  }

  get hasCall(): boolean {
    return this.calls.size > 0;
  }

  /** Start the transport and register the one line. */
  async start(): Promise<void> {
    const uri = UserAgent.makeURI(toSipUri(this.options.address));
    if (!uri) throw new Error(`Not a SIP address: ${this.options.address}`);
    this.hooks.onLine("connecting");
    const ua = new UserAgent({
      uri,
      authorizationUsername: authUser(this.options.address),
      authorizationPassword: this.options.password,
      transportOptions: { server: this.options.server },
      // Reliability, unattended: keep trying to reach the server, and say
      // nothing to the reader while it happens.
      reconnectionAttempts: 30,
      reconnectionDelay: 2,
      logLevel: "error",
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: { iceServers: this.options.iceServers },
      },
      delegate: {
        onConnect: () => {
          if (this.ended) return;
          // A reconnected socket is a registration that may have lapsed: renew.
          void this.registerer?.register().catch(() => undefined);
        },
        onDisconnect: () => {
          if (!this.ended) this.hooks.onLine("connecting");
        },
        onInvite: (invitation) => this.receive(invitation),
      },
    });
    this.ua = ua;
    ua.stateChange.addListener((state) => {
      // The transport gave up: a stopped user agent that nobody asked to stop
      // is a line that is no longer there.
      if (state === "Stopped" && !this.ended) this.hooks.onLine("unavailable");
    });
    await ua.start();
    this.registerer = new Registerer(ua, { expires: REGISTRATION_EXPIRES });
    this.registerer.stateChange.addListener((state) => {
      if (this.ended) return;
      if (state === RegistererState.Registered) this.hooks.onLine("registered");
      else if (
        state === RegistererState.Unregistered ||
        state === RegistererState.Terminated
      )
        this.hooks.onLine("connecting");
    });
    await this.registerer.register();
  }

  /** Deregister and stop the transport. Called only when the page goes away. */
  async stop(): Promise<void> {
    this.ended = true;
    try {
      await this.registerer?.unregister();
    } catch {
      /* A server that is already gone needs no goodbye. */
    }
    try {
      await this.ua?.stop();
    } catch {
      /* idem */
    }
    this.calls.clear();
    this.active = undefined;
    this.ringing = undefined;
  }

  /** Place a call to a contact's number or an address typed by hand. */
  async call(target: string): Promise<void> {
    const ua = this.ua;
    if (!ua) throw new Error("The phone is not connected");
    const uri = UserAgent.makeURI(toSipUri(target));
    if (!uri) throw new Error(`Not a number to call: ${target}`);
    const inviter = new Inviter(ua, uri, {
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false },
      },
    });
    this.bind(inviter, target);
    await inviter.invite();
  }

  /** Answer the ringing invitation, holding a call that is already live. */
  async answer(): Promise<void> {
    const invitation = this.ringing;
    if (!invitation) return;
    this.ringing = undefined;
    this.bind(invitation, this.ringingFrom);
    await invitation.accept({
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false },
      },
    });
  }

  /** Decline a ringing invitation. */
  async decline(): Promise<void> {
    const invitation = this.ringing;
    if (!invitation) return;
    this.ringing = undefined;
    this.ringingFrom = "";
    try {
      await invitation.reject();
    } catch {
      /* Gone already. */
    }
    this.reflow();
  }

  /** End the active call; a held one becomes active, or the line goes idle. */
  async hangup(): Promise<void> {
    const session = this.active ?? [...this.calls.keys()][0];
    if (!session) return;
    try {
      if (session.state === SessionState.Initial && session instanceof Inviter)
        await session.cancel();
      else if (session.state === SessionState.Established) await session.bye();
      else if (session instanceof Invitation) await session.reject();
    } catch {
      /* The peer may have ended it first. */
    }
  }

  /** Make another call the active one, holding the one that was. */
  activate(remote: string): void {
    const entry = [...this.calls.entries()].find(([, name]) => name === remote);
    if (entry) this.setActive(entry[0]);
  }

  /** Mute or unmute the active call's microphone. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMedia();
  }

  /** Send DTMF tones over the active call. */
  sendDtmf(tones: string): void {
    this.handler(this.active)?.sendDtmf(tones);
  }

  private receive(invitation: Invitation): void {
    this.ringing = invitation;
    this.ringingFrom = invitation.remoteIdentity?.uri?.toString() ?? "";
    this.hooks.onIncoming(this.ringingFrom);
  }

  private handler(
    session: Session | undefined,
  ): Web.SessionDescriptionHandler | undefined {
    return session?.sessionDescriptionHandler as
      | Web.SessionDescriptionHandler
      | undefined;
  }

  private bind(session: Session, remote: string): void {
    this.calls.set(session, remote);
    session.stateChange.addListener((state) => {
      if (state === SessionState.Established) {
        this.watchMedia(this.handler(session), session);
        this.setActive(session);
      } else if (state === SessionState.Terminated) {
        this.calls.delete(session);
        if (this.active === session) this.active = undefined;
        this.reflow();
      }
    });
  }

  /** Hold every call but one, make it active, and report the line. */
  private setActive(session: Session): void {
    this.active = session;
    this.applyMedia();
    this.reflow();
  }

  /** The media: one call's microphone on, the others' off; one call's audio played. */
  private applyMedia(): void {
    for (const [session] of this.calls) {
      const on = session === this.active && !this.muted;
      for (const track of this.handler(session)?.localMediaStream?.getAudioTracks() ?? [])
        track.enabled = on;
    }
  }

  private reflow(): void {
    if (!this.active && this.calls.size) this.active = this.calls.keys().next().value;
    const calls: PhoneCallView[] = [...this.calls.entries()].map(([session, remote]) => ({
      remote,
      active: session === this.active,
    }));
    this.hooks.onCalls(calls, this.handler(this.active)?.remoteMediaStream ?? null);
  }

  /**
   * Keep the media path alive.
   *
   * A path that has failed is restarted in place with a re-INVITE asking ICE
   * to start over, which is the one thing a client can do when the network
   * moved under it; the reader touches nothing. Only an outgoing call can send
   * the re-INVITE — the engine offers no re-INVITE on a received call — so a
   * received call's path recovers through the transport's own reconnection.
   */
  private watchMedia(
    handler: Web.SessionDescriptionHandler | undefined,
    session: Session,
  ): void {
    const pc = handler?.peerConnection;
    if (!pc) return;
    pc.oniceconnectionstatechange = () => {
      if (this.ended || !this.calls.has(session)) return;
      if (pc.iceConnectionState !== "failed") return;
      if (session instanceof Inviter) {
        // `offerOptions` is the browser handler's, not the base engine option
        // set: the re-INVITE asks ICE to start over on the same session.
        const restart: Web.SessionDescriptionHandlerOptions = {
          offerOptions: { iceRestart: true },
        };
        void session
          .invite({ sessionDescriptionHandlerOptions: restart })
          .catch(() => undefined);
      }
    };
  }
}
