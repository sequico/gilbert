/**
 * The SIP.js user agent, wrapped thin (ADR 0023).
 *
 * The engine's own API is kept behind a small surface — a line state, one
 * active session, and the handful of actions the call surface needs — so the
 * store holds state rather than the library's objects, and a change of engine
 * would be this file and nothing else.
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

export interface PhoneAgentHooks {
  onLine(state: PhoneLineState): void;
  /** An invitation arrived and no call is live: the surface rings. */
  onIncoming(from: string): void;
  /** A call is established; the stream is what is played. */
  onEstablished(remote: string, stream: MediaStream | null): void;
  /** The active call is over, for any reason. */
  onEnded(): void;
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
  private session: Session | undefined;
  private invitation: Invitation | undefined;
  private incomingFrom = "";
  private ended = false;

  constructor(
    private readonly options: PhoneAgentOptions,
    private readonly hooks: PhoneAgentHooks,
  ) {}

  get active(): Session | undefined {
    return this.session;
  }

  get hasCall(): boolean {
    return Boolean(this.session);
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
    this.session = undefined;
    this.invitation = undefined;
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

  /** Answer the ringing invitation. */
  async answer(): Promise<void> {
    const invitation = this.invitation;
    if (!invitation) return;
    this.invitation = undefined;
    this.bind(invitation, this.incomingFrom);
    await invitation.accept({
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false },
      },
    });
  }

  /** Decline a ringing invitation. */
  async decline(): Promise<void> {
    const invitation = this.invitation;
    if (!invitation) return;
    this.invitation = undefined;
    this.incomingFrom = "";
    try {
      await invitation.reject();
    } catch {
      /* Gone already. */
    }
    this.hooks.onEnded();
  }

  /** End the active call, however it is still standing. */
  async hangup(): Promise<void> {
    const session = this.session;
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

  /** Mute or unmute the microphone. */
  setMuted(muted: boolean): void {
    const handler = this.session?.sessionDescriptionHandler as
      | Web.SessionDescriptionHandler
      | undefined;
    for (const track of handler?.localMediaStream?.getAudioTracks() ?? [])
      track.enabled = !muted;
  }

  /** Send DTMF tones over the established call. */
  sendDtmf(tones: string): void {
    const handler = this.session?.sessionDescriptionHandler as
      | Web.SessionDescriptionHandler
      | undefined;
    handler?.sendDtmf(tones);
  }

  private receive(invitation: Invitation): void {
    /*
     * A second invitation while one is live is answered as busy: the client
     * holds one line (ADR 0023), and the server's own routing takes what an
     * unanswered fork means.
     */
    if (this.session) {
      void invitation.reject({ statusCode: 486 }).catch(() => undefined);
      return;
    }
    this.invitation = invitation;
    this.incomingFrom = invitation.remoteIdentity?.uri?.toString() ?? "";
    this.hooks.onIncoming(this.incomingFrom);
  }

  private bind(session: Session, remote: string): void {
    this.session = session;
    session.stateChange.addListener((state) => {
      if (state === SessionState.Established) {
        const handler = session.sessionDescriptionHandler as
          | Web.SessionDescriptionHandler
          | undefined;
        this.watchMedia(handler, session);
        this.hooks.onEstablished(remote, handler?.remoteMediaStream ?? null);
      } else if (state === SessionState.Terminated) {
        if (this.session === session) this.session = undefined;
        this.hooks.onEnded();
      }
    });
  }

  /**
   * Keep the media path alive.
   *
   * A path that has failed is restarted in place with a re-INVITE asking ICE
   * to start over, which is the one thing a client can do when the network
   * moved under it; the reader touches nothing.
   */
  private watchMedia(
    handler: Web.SessionDescriptionHandler | undefined,
    session: Session,
  ): void {
    const pc = handler?.peerConnection;
    if (!pc) return;
    pc.oniceconnectionstatechange = () => {
      if (this.ended || this.session !== session) return;
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
