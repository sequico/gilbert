/**
 * The phone's state (ADR 0023): the one line, the call on it, and the actions
 * the surfaces offer.
 *
 * The SIP.js engine is wrapped in `@/lib/phone/agent`; this store owns what the
 * screen reads — the line's state, the call, the remote stream, whether the
 * microphone is muted — and the account's own configuration: the installation's
 * endpoints (from the session) and the person's SIP address and password (from
 * their account). Nothing here registers twice: one tab per device holds the
 * line, and the others follow the call it carries.
 */
import type { InstallationSip } from "@gilbert/shared/installation";
import { create } from "zustand";
import { CAP } from "@/jmap/client";
import { PhoneAgent, type PhoneLineState } from "@/lib/phone/agent";
import { iceServers, phoneOffered } from "@/lib/phone/config";
import {
  credentialFor,
  readSipCredentials,
  type SipCredential,
} from "@/lib/phone/credentials";
import { useMail } from "./mail";
import { useSession } from "./session";

/** The line as the top-bar entry reads it; `off` is the feature not offered. */
export type PhoneState = PhoneLineState | "off" | "standby";

export interface ActiveCall {
  remote: string;
  incoming: boolean;
}

interface PhoneStore {
  state: PhoneState;
  /** Whether this installation and this account can offer the phone. */
  ready: boolean;
  /** The ringing call, before it is answered. */
  incoming: string | null;
  /** The established call. */
  call: ActiveCall | null;
  /** What the call surface plays: the peer's audio. */
  stream: MediaStream | null;
  muted: boolean;
  error: string | null;

  /** Read the configuration and, when this tab holds the line, register. */
  start(): Promise<void>;
  /** Deregister and stop. Called on `pagehide`, never on backgrounding. */
  stop(): Promise<void>;
  dial(target: string): Promise<void>;
  answer(): Promise<void>;
  decline(): Promise<void>;
  hangup(): Promise<void>;
  setMuted(muted: boolean): void;
  sendDtmf(tones: string): void;
}

/** The one agent of this page. */
let agent: PhoneAgent | null = null;
/** The tab that holds the line, so a device never rings twice. */
let leader = false;
let heartbeat: number | null = null;
let mirror: BroadcastChannel | null = null;
let started = false;

const LEADER_KEY = "gilbert.phone.leader";
const MIRROR_CHANNEL = "gilbert.phone";
const LEADER_TTL_MS = 15_000;
const TAB_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Math.random());

/** Claim the line for this tab, or say another tab holds it. */
function claimLeadership(): boolean {
  try {
    const raw = localStorage.getItem(LEADER_KEY);
    if (raw) {
      const held = JSON.parse(raw) as { id?: string; at?: number };
      if (
        held.id &&
        held.id !== TAB_ID &&
        typeof held.at === "number" &&
        Date.now() - held.at < LEADER_TTL_MS
      )
        return false;
    }
    localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, at: Date.now() }));
    return true;
  } catch {
    // No storage (a private window, a hardened browser): one tab is the only tab.
    return true;
  }
}

function releaseLeadership(): void {
  try {
    const raw = localStorage.getItem(LEADER_KEY);
    if (raw && (JSON.parse(raw) as { id?: string }).id === TAB_ID)
      localStorage.removeItem(LEADER_KEY);
  } catch {
    /* Nothing to release. */
  }
}

function keepAlive(): void {
  if (heartbeat !== null) return;
  heartbeat = window.setInterval(() => {
    if (leader) {
      try {
        localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, at: Date.now() }));
      } catch {
        /* ignored */
      }
    }
  }, 5_000);
}

export const usePhone = create<PhoneStore>((set, get) => ({
  state: "off",
  ready: false,
  incoming: null,
  call: null,
  stream: null,
  muted: false,
  error: null,

  async start() {
    if (started) return;
    const session = useSession.getState();
    const sip = session.session?.gilbert?.sip;
    if (!phoneOffered(sip)) {
      set({ state: "off", ready: false });
      return;
    }
    const accountId = session.ownAccountFor(CAP.mail);
    if (!accountId || !sip) {
      set({ state: "off", ready: false });
      return;
    }
    const credentials = await readSipCredentials(accountId);
    const identity = useMail.getState().defaultIdentity();
    const primary =
      Object.values(session.session?.accounts ?? {}).find((a) => a.isPersonal)?.name ??
      session.session?.username ??
      "";
    /*
     * The default identity's credential, falling back to the account's own
     * address: the identity list may not have landed when the phone starts, and
     * the default identity almost always is the account's own address.
     */
    const credential: SipCredential | null =
      credentialFor(credentials, identity?.email) ?? credentialFor(credentials, primary);
    if (!credential) {
      // The phone is offered, but this account has nothing to register with.
      set({ state: "off", ready: false });
      return;
    }
    started = true;
    set({ ready: true });
    if (!claimLeadership()) {
      set({ state: "standby" });
      listenToMirror();
      return;
    }
    leader = true;
    keepAlive();
    mirror = openMirror();
    await startAgent(sip, credential);
    // Deregister only when the page actually goes, never when it is hidden.
    window.addEventListener(
      "pagehide",
      () => {
        releaseLeadership();
        void get().stop();
      },
      { once: true },
    );
  },

  async stop() {
    if (heartbeat !== null) {
      window.clearInterval(heartbeat);
      heartbeat = null;
    }
    await agent?.stop().catch(() => undefined);
    agent = null;
    started = false;
    leader = false;
    set({ state: "off", incoming: null, call: null, stream: null, muted: false });
  },

  async dial(target) {
    if (!agent) return;
    set({ error: null });
    try {
      await agent.call(target);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async answer() {
    await agent?.answer().catch(() => undefined);
    set({ incoming: null });
  },

  async decline() {
    await agent?.decline().catch(() => undefined);
    set({ incoming: null });
  },

  async hangup() {
    await agent?.hangup().catch(() => undefined);
  },

  setMuted(muted) {
    agent?.setMuted(muted);
    set({ muted });
  },

  sendDtmf(tones) {
    agent?.sendDtmf(tones);
  },
}));

async function startAgent(
  sip: InstallationSip,
  credential: SipCredential,
): Promise<void> {
  agent = new PhoneAgent(
    {
      address: credential.address,
      password: credential.password,
      server: sip.endpoints[0]!,
      iceServers: iceServers(sip),
    },
    {
      onLine: (state) => usePhone.setState({ state }),
      onIncoming: (from) => {
        usePhone.setState({ incoming: from });
        mirror?.postMessage({ kind: "incoming", from });
      },
      onEstablished: (remote, stream) => {
        usePhone.setState({
          incoming: null,
          call: { remote, incoming: false },
          stream,
          muted: false,
        });
        mirror?.postMessage({ kind: "established", remote });
      },
      onEnded: () => {
        usePhone.setState({ call: null, incoming: null, stream: null, muted: false });
        mirror?.postMessage({ kind: "ended" });
      },
      onError: (message) => usePhone.setState({ error: message }),
    },
  );
  try {
    await agent.start();
  } catch (err) {
    usePhone.setState({
      state: "unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function openMirror(): BroadcastChannel | null {
  try {
    return new BroadcastChannel(MIRROR_CHANNEL);
  } catch {
    return null;
  }
}

/**
 * The tabs that do not hold the line still show the call the leader carries:
 * they hear its state over a `BroadcastChannel` and render it, so a device
 * rings in one place and everyone sees the same call.
 */
function listenToMirror(): void {
  if (mirror) return;
  mirror = openMirror();
  if (!mirror) return;
  mirror.onmessage = (event: MessageEvent) => {
    const message = event.data as { kind?: string; from?: string; remote?: string };
    switch (message.kind) {
      case "incoming":
        usePhone.setState({ incoming: message.from ?? "" });
        break;
      case "established":
        usePhone.setState({
          incoming: null,
          call: { remote: message.remote ?? "", incoming: false },
        });
        break;
      case "ended":
        usePhone.setState({ call: null, incoming: null, stream: null });
        break;
      default:
        break;
    }
  };
}
