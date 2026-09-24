/**
 * The Janus API, as much of it as the phone speaks (ADR 0023).
 *
 * Janus is a server; this is the client half. It opens one session and one
 * plugin handle, sends the plugin its requests, and hands back the events and
 * the JSEP the media negotiation needs. It knows the protocol and nothing
 * about SIP, a contact or a call.
 *
 * The socket is gilbertserver's own (`/api/phone`), not Janus's: the server
 * proxies it, so the page opens one origin, one certificate and one session.
 */

/** JSEP, as Janus and the browser exchange it. */
export interface Jsep {
  type: "offer" | "answer";
  sdp: string;
}

export interface JanusHooks {
  /** One plugin event, named by its plugin, with the SDP it carried, if any. */
  onEvent(plugin: string, data: unknown, jsep?: Jsep): void;
  /** A remote ICE candidate. */
  onRemoteCandidate(candidate: RTCIceCandidateInit): void;
  /** Janus tore the media down. */
  onMediaGone(): void;
  /** The socket is gone and will not come back on its own. */
  onClosed(): void;
}

/** The keep-alive, comfortably inside a Janus session timeout. */
const KEEPALIVE_MS = 25_000;

interface Message {
  janus?: string;
  transaction?: string;
  data?: { id?: number };
  plugindata?: { plugin?: string; data?: unknown };
  jsep?: Jsep;
  candidate?: RTCIceCandidateInit | { completed?: boolean };
  error?: { code?: number; reason?: string };
}

/** One Janus connection: a session, one plugin handle, and the events of both. */
export class Janus {
  private ws: WebSocket | null = null;
  private session: number | null = null;
  private handle: number | null = null;
  private id = 0;
  private readonly pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();
  private keepalive: number | null = null;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly hooks: JanusHooks,
  ) {}

  /** Open the socket, create the session and attach one plugin. */
  async open(plugin: string): Promise<void> {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;
    /*
     * One close handler, from the first byte: before the socket opens it
     * rejects the wait (a bridge that never answered), and after it the line is
     * gone and the owner is told, so it can reconnect. Overwriting it for the
     * wait, as a naive version does, is what makes a dropped socket silent.
     */
    const first = new Promise<void>((resolve, reject) => {
      const failed = new Error("the phone bridge did not answer");
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onclose = () => {
        ws.onclose = null;
        this.stopKeepalive();
        this.rejectPending(new Error("the phone bridge is gone"));
        if (opened) {
          if (!this.closed) this.hooks.onClosed();
        } else reject(failed);
      };
      ws.onerror = () => {
        if (!opened) reject(failed);
      };
    });
    ws.onmessage = (event) => this.receive(String(event.data));
    await first;
    const created = (await this.request({ janus: "create" })) as { id?: number };
    if (!created.id) throw new Error("the phone bridge accepted no session");
    this.session = created.id;
    const attached = (await this.request({ janus: "attach", plugin })) as {
      id?: number;
    };
    if (!attached.id) throw new Error("the phone bridge attached no plugin");
    this.handle = attached.id;
    this.keepalive = window.setInterval(() => {
      this.send({ janus: "keepalive", session_id: this.session });
    }, KEEPALIVE_MS);
  }

  /** Send a plugin request; its answer arrives as an event, not a return value. */
  message(body: Record<string, unknown>, jsep?: Jsep): void {
    this.send({
      janus: "message",
      session_id: this.session,
      handle_id: this.handle,
      body,
      ...(jsep ? { jsep } : {}),
    });
  }

  /** Send one ICE candidate to the plugin. */
  trickle(candidate: RTCIceCandidateInit | { completed: true }): void {
    this.send({
      janus: "trickle",
      session_id: this.session,
      handle_id: this.handle,
      candidate,
    });
  }

  /** Drop the session and the socket. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepalive();
    if (this.ws && this.session !== null)
      this.send({ janus: "destroy", session_id: this.session });
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.rejectPending(new Error("the phone bridge is gone"));
  }

  private next(): string {
    this.id += 1;
    return `g${this.id}`;
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private stopKeepalive(): void {
    if (this.keepalive === null) return;
    window.clearInterval(this.keepalive);
    this.keepalive = null;
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  /** A request whose `success`/`error` response this waits for. */
  private request(message: Record<string, unknown>): Promise<unknown> {
    const transaction = this.next();
    return new Promise((resolve, reject) => {
      this.pending.set(transaction, { resolve, reject });
      this.send({ ...message, transaction });
    });
  }

  private settle(transaction: string | undefined, ok: boolean, message: Message): void {
    if (!transaction) return;
    const pending = this.pending.get(transaction);
    this.pending.delete(transaction);
    if (!pending) return;
    if (ok) pending.resolve(message.data ?? {});
    else
      pending.reject(
        new Error(message.error?.reason ?? "the phone bridge refused the request"),
      );
  }

  private receive(raw: string): void {
    let message: Message;
    try {
      message = JSON.parse(raw) as Message;
    } catch {
      return;
    }
    switch (message.janus) {
      case "success":
        this.settle(message.transaction, true, message);
        return;
      case "error":
        this.settle(message.transaction, false, message);
        return;
      case "event":
        if (message.plugindata?.plugin)
          this.hooks.onEvent(
            message.plugindata.plugin,
            message.plugindata.data,
            message.jsep,
          );
        return;
      case "trickle":
        if (
          message.candidate &&
          typeof message.candidate === "object" &&
          "candidate" in message.candidate
        )
          this.hooks.onRemoteCandidate(message.candidate as RTCIceCandidateInit);
        return;
      case "hangup":
        this.hooks.onMediaGone();
        return;
      case "detached":
      case "timeout":
        // The handle (or the whole session) is gone, but the socket may not
        // close: tell the owner so the line is not left looking registered.
        if (!this.closed) this.hooks.onClosed();
        return;
      default:
        return;
    }
  }
}
