/**
 * The phone's state (ADR 0023): the one line, the calls on it, and the actions
 * the surfaces offer.
 *
 * The SIP.js engine is wrapped in `@/lib/phone/agent`; this store owns what the
 * screen reads — the line's state, the active call and those on hold, the
 * remote stream, whether the microphone is muted — and the account's own
 * configuration: the installation's endpoints (from the session) and the
 * person's SIP address and password (from their account). One tab per device
 * holds the line, the others follow the call it carries; the registration ends
 * on `pagehide` and when the session does, never on backgrounding.
 */
import type { InstallationSip } from "@gilbert/shared/installation";
import { create } from "zustand";
import { CAP } from "@/jmap/client";
import { PhoneAgent, type PhoneCallView, type PhoneLineState } from "@/lib/phone/agent";
import { iceServers, phoneOffered } from "@/lib/phone/config";
import {
  credentialFor,
  readSipCredentials,
  type SipCredential,
} from "@/lib/phone/credentials";
import { ensureMicrophone, type MicrophoneState } from "@/lib/phone/microphone";
import { useMail } from "./mail";
import { useSession } from "./session";

/** The line as the top-bar entry reads it; `off` is the feature not offered. */
export type PhoneState = PhoneLineState | "off";

/** The active call. `id` is the session's, and is unique. */
export interface ActiveCall {
  id: string;
  remote: string;
}

/** A call waiting while another is active. */
export interface HeldCall {
  id: string;
  remote: string;
}

interface PhoneStore {
  state: PhoneState;
  /** Whether this installation and this account can offer the phone. */
  ready: boolean;
  /** Whether this tab holds the line (false on the tabs that follow it). */
  leader: boolean;
  /** The ringing call, before it is answered. */
  incoming: string | null;
  /** The active call. */
  call: ActiveCall | null;
  /** Calls on the line that are not active, held while the reader talks. */
  held: HeldCall[];
  /** What the call surface plays: the active peer's audio. */
  stream: MediaStream | null;
  muted: boolean;
  error: string | null;
  microphone: MicrophoneState | "unknown";

  /** Read the configuration and, when this tab holds the line, register. */
  start(): Promise<void>;
  /** Deregister and stop. Called on `pagehide` and on sign-out. */
  stop(): Promise<void>;
  dial(target: string): Promise<void>;
  answer(): Promise<void>;
  decline(): Promise<void>;
  hangup(): Promise<void>;
  /** Make a held call the active one. */
  switchTo(id: string): void;
  setMuted(muted: boolean): void;
  sendDtmf(tones: string): void;
  /** Ask for the microphone, and remember what the browser answered. */
  requestMicrophone(): Promise<MicrophoneState>;
}

/** The one agent of this page. */
let agent: PhoneAgent | null = null;
/** The run of `start()` on its way, so a second call joins it rather than racing. */
let startPromise: Promise<void> | null = null;
let started = false;
let leader = false;
let heartbeat: number | null = null;
let standbyPoll: number | null = null;
let credentialRetry: number | null = null;
let mirror: BroadcastChannel | null = null;
/** What the standby tab needs to take the line over if the leader dies. */
let currentSip: InstallationSip | null = null;
let currentCredential: SipCredential | null = null;

const LEADER_KEY = "gilbert.phone.leader";
const MIRROR_CHANNEL = "gilbert.phone";
/*
 * The lease is longer than a background tab's throttled timer, so a tab the
 * browser has slowed to a crawl is not mistaken for a dead one; a standby that
 * does find the lease stale takes the line over within one poll.
 */
const LEADER_TTL_MS = 90_000;
const HEARTBEAT_MS = 15_000;
const STANDBY_POLL_MS = 10_000;
const CREDENTIAL_RETRY_MS = 30_000;
const TAB_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Math.random());

function readLeader(): { id?: string; at?: number } | null {
  try {
    const raw = localStorage.getItem(LEADER_KEY);
    return raw ? (JSON.parse(raw) as { id?: string; at?: number }) : null;
  } catch {
    return null;
  }
}

function leaderIsLive(): boolean {
  const held = readLeader();
  return Boolean(
    held?.id &&
      held.id !== TAB_ID &&
      typeof held.at === "number" &&
      Date.now() - held.at < LEADER_TTL_MS,
  );
}

/**
 * Claim the line: write, then read back, and only the last writer owns it.
 *
 * Two tabs opening at once both see a stale (or absent) lease and both write;
 * the read-back is what leaves one of them holding it, rather than two
 * registrations from one device.
 */
function claimLeadership(): boolean {
  if (leaderIsLive()) return false;
  try {
    localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, at: Date.now() }));
  } catch {
    // No storage (a private window, a hardened browser): one tab is the only tab.
    return true;
  }
  return readLeader()?.id === TAB_ID;
}

function releaseLeadership(): void {
  if (readLeader()?.id !== TAB_ID) return;
  try {
    localStorage.removeItem(LEADER_KEY);
  } catch {
    /* Nothing to release. */
  }
}

function keepAlive(): void {
  if (heartbeat !== null) return;
  heartbeat = window.setInterval(() => {
    if (!leader) return;
    try {
      localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, at: Date.now() }));
    } catch {
      /* ignored */
    }
  }, HEARTBEAT_MS);
}

export const usePhone = create<PhoneStore>((set, get) => ({
  state: "off",
  ready: false,
  leader: false,
  incoming: null,
  call: null,
  held: [],
  stream: null,
  muted: false,
  error: null,
  microphone: "unknown",

  async start() {
    if (started) return;
    if (startPromise) return startPromise;
    startPromise = begin(set).finally(() => {
      startPromise = null;
    });
    return startPromise;
  },

  async stop() {
    clearTimers();
    await agent?.stop().catch(() => undefined);
    agent = null;
    started = false;
    leader = false;
    startPromise = null;
    currentSip = null;
    currentCredential = null;
    if (mirror) {
      try {
        mirror.close();
      } catch {
        /* already closed */
      }
      mirror = null;
    }
    set({
      state: "off",
      ready: false,
      leader: false,
      incoming: null,
      call: null,
      held: [],
      stream: null,
      muted: false,
    });
  },

  async dial(target) {
    if (!agent) return;
    set({ error: null });
    await get().requestMicrophone();
    try {
      await agent.call(target);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async answer() {
    await get().requestMicrophone();
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

  switchTo(id) {
    agent?.activate(id);
  },

  setMuted(muted) {
    agent?.setMuted(muted);
    set({ muted });
  },

  sendDtmf(tones) {
    agent?.sendDtmf(tones);
  },

  async requestMicrophone() {
    const microphone = await ensureMicrophone();
    set({ microphone });
    return microphone;
  },
}));

/** Read the configuration, then register or follow the tab that does. */
async function begin(set: (partial: Partial<PhoneStore>) => void): Promise<void> {
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
  const credential =
    credentialFor(credentials, identity?.email) ?? credentialFor(credentials, primary);
  if (!credential) {
    // The phone is offered, but this account has nothing to register with yet:
    // a transient failed read must not disable it for the session.
    set({ state: "off", ready: false, leader: false });
    scheduleCredentialRetry();
    return;
  }
  clearCredentialRetry();
  currentSip = sip;
  currentCredential = credential;
  started = true;
  set({ ready: true });

  if (!claimLeadership()) {
    // Another tab holds the line: follow the call it carries, and be ready to
    // take over if it dies.
    set({ leader: false, state: "connecting" });
    listenToMirror();
    scheduleStandbyPoll(set);
    return;
  }
  await takeLine(set, sip, credential);
}

/** Register the line, and watch for the page going away. */
async function takeLine(
  set: (partial: Partial<PhoneStore>) => void,
  sip: InstallationSip,
  credential: SipCredential,
): Promise<void> {
  leader = true;
  keepAlive();
  mirror = openMirror();
  set({ leader: true });
  await startAgent(set, sip, credential);
  window.addEventListener(
    "pagehide",
    () => {
      releaseLeadership();
      void usePhone.getState().stop();
    },
    { once: true },
  );
}

async function startAgent(
  set: (partial: Partial<PhoneStore>) => void,
  sip: InstallationSip,
  credential: SipCredential,
): Promise<void> {
  agent = new PhoneAgent(
    {
      address: credential.address,
      password: credential.password,
      endpoint: sip.endpoints[0]!,
      iceServers: iceServers(sip),
    },
    {
      onLine: (state) => {
        set({ state });
        mirror?.postMessage({ kind: "line", state });
      },
      onIncoming: (from) => {
        set({ incoming: from || null });
        mirror?.postMessage({ kind: "incoming", from });
      },
      onCalls: (calls: PhoneCallView[], stream) => {
        const active = calls.find((c) => c.active) ?? calls[0] ?? null;
        const held: HeldCall[] = calls
          .filter((c) => c !== active)
          .map((c) => ({ id: c.id, remote: c.remote }));
        set({
          incoming: null,
          call: active ? { id: active.id, remote: active.remote } : null,
          held,
          stream,
        });
        mirror?.postMessage({
          kind: "calls",
          call: active ? { id: active.id, remote: active.remote } : null,
          held,
        });
      },
      onError: (message) => set({ error: message }),
    },
  );
  try {
    await agent.start();
  } catch (err) {
    set({
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
 * The tabs that do not hold the line still show the line and the call the
 * leader carries: they hear its state over a `BroadcastChannel` and render it,
 * so a device rings in one place and everyone sees the same call.
 */
function listenToMirror(): void {
  if (mirror) return;
  mirror = openMirror();
  if (!mirror) return;
  mirror.onmessage = (event: MessageEvent) => {
    const message = event.data as {
      kind?: string;
      from?: string;
      state?: PhoneLineState;
      call?: ActiveCall | null;
      held?: HeldCall[];
    };
    switch (message.kind) {
      case "line":
        if (message.state) usePhone.setState({ state: message.state });
        break;
      case "incoming":
        usePhone.setState({ incoming: message.from || null });
        break;
      case "calls":
        usePhone.setState({
          incoming: null,
          call: message.call ?? null,
          held: message.held ?? [],
        });
        break;
      default:
        break;
    }
  };
}

/** Take the line over when the tab that held it stops renewing the lease. */
function scheduleStandbyPoll(set: (partial: Partial<PhoneStore>) => void): void {
  if (standbyPoll !== null) return;
  standbyPoll = window.setInterval(() => {
    if (leader || !currentSip || !currentCredential) return;
    if (!claimLeadership()) return;
    if (standbyPoll !== null) {
      window.clearInterval(standbyPoll);
      standbyPoll = null;
    }
    void takeLine(set, currentSip, currentCredential);
  }, STANDBY_POLL_MS);
}

function scheduleCredentialRetry(): void {
  if (credentialRetry !== null) return;
  credentialRetry = window.setTimeout(() => {
    credentialRetry = null;
    started = false;
    void usePhone.getState().start();
  }, CREDENTIAL_RETRY_MS);
}

function clearCredentialRetry(): void {
  if (credentialRetry === null) return;
  window.clearTimeout(credentialRetry);
  credentialRetry = null;
}

function clearTimers(): void {
  clearCredentialRetry();
  if (heartbeat !== null) {
    window.clearInterval(heartbeat);
    heartbeat = null;
  }
  if (standbyPoll !== null) {
    window.clearInterval(standbyPoll);
    standbyPoll = null;
  }
}
