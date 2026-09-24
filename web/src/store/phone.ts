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
import { t } from "@/lib/i18n";
import { PhoneAgent, type PhoneCallView, type PhoneLineState } from "@/lib/phone/agent";
import { iceServers, phoneOffered } from "@/lib/phone/config";
import {
  credentialFor,
  readSipCredentials,
  type SipCredential,
} from "@/lib/phone/credentials";
import {
  requestMicrophone as askMicrophone,
  type MicrophonePermission,
  microphoneState as readMicrophoneState,
} from "@/lib/phone/microphone";
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
  /** What the browser will say about the microphone, without prompting. */
  microphone: MicrophonePermission;

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
  /** Ask for the microphone, in this gesture, and remember the answer. */
  requestMicrophone(): Promise<MicrophonePermission>;
}

/** The one agent of this page. */
let agent: PhoneAgent | null = null;
/** The run of `start()` on its way, so a second call joins it rather than racing. */
let startPromise: Promise<void> | null = null;
let started = false;
let leader = false;
/**
 * A count of the starts this page has begun. `stop()` bumps it, and a `begin`
 * that sees a different number knows its run was abandoned and abandons the
 * agent it made rather than leaving a live registration nobody owns.
 */
let generation = 0;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

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
 * Claim the line: write, wait a jittered moment, then read back — and only the
 * tab whose write is still there owns it.
 *
 * Two tabs opening at once both see a stale (or absent) lease and both write;
 * the jittered re-read is what leaves one of them holding it, rather than two
 * registrations from one device. Where storage is refused (a private window,
 * a hardened browser) there is nothing to coordinate with, and the one tab is
 * the only tab.
 */
async function claimLeadership(): Promise<boolean> {
  if (leaderIsLive()) return false;
  try {
    localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, at: Date.now() }));
  } catch {
    return true;
  }
  await sleep(20 + Math.random() * 60);
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
    const gen = generation;
    startPromise = begin(set, gen).finally(() => {
      startPromise = null;
    });
    return startPromise;
  },

  async stop() {
    generation += 1;
    clearTimers();
    releaseLeadership();
    await agent?.stop().catch(() => undefined);
    agent = null;
    started = false;
    leader = false;
    startPromise = null;
    currentSip = null;
    currentCredential = null;
    closeMirror();
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
    if (!agent || !leader) return;
    set({ error: null });
    await get().requestMicrophone();
    try {
      await agent.call(target);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async answer() {
    if (!leader) return;
    await get().requestMicrophone();
    await agent?.answer().catch(() => undefined);
    set({ incoming: null });
  },

  async decline() {
    if (!leader) return;
    await agent?.decline().catch(() => undefined);
    set({ incoming: null });
  },

  async hangup() {
    if (!leader) return;
    await agent?.hangup().catch(() => undefined);
  },

  switchTo(id) {
    if (!leader) return;
    agent?.activate(id);
  },

  setMuted(muted) {
    set({ muted });
    agent?.setMuted(muted);
  },

  sendDtmf(tones) {
    if (!leader) return;
    agent?.sendDtmf(tones);
  },

  async requestMicrophone() {
    const microphone = await askMicrophone();
    set({ microphone });
    return microphone;
  },
}));

/** Read the configuration, then register or follow the tab that does. */
async function begin(
  set: (partial: Partial<PhoneStore>) => void,
  gen: number,
): Promise<void> {
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
  if (gen !== generation) return;
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
  // The microphone's state is read once the phone is offered: the surface says
  // what is missing without prompting, and prompts only in a gesture.
  void readMicrophoneState().then((microphone) => set({ microphone }));

  if (!(await claimLeadership())) {
    if (gen !== generation) return;
    // Another tab holds the line: follow the call it carries, and be ready to
    // take over if it dies.
    set({ leader: false, state: "connecting" });
    listenToMirror();
    scheduleStandbyPoll(set, gen);
    return;
  }
  if (gen !== generation) return;
  await takeLine(set, gen, sip, credential);
}

/** Register the line, and watch for the page going away. */
async function takeLine(
  set: (partial: Partial<PhoneStore>) => void,
  gen: number,
  sip: InstallationSip,
  credential: SipCredential,
): Promise<void> {
  leader = true;
  keepAlive();
  // The standby already has a channel with its listener on it; reusing it is
  // what keeps the mirror one object rather than leaking the one it replaced.
  if (!mirror) mirror = openMirror();
  set({ leader: true });
  if (standbyPoll !== null) {
    window.clearInterval(standbyPoll);
    standbyPoll = null;
  }
  await startAgent(set, gen, sip, credential);
  if (gen !== generation) {
    // The run was abandoned while the agent was starting: take it down rather
    // than leave a registration nobody owns.
    await agent?.stop().catch(() => undefined);
    agent = null;
    return;
  }
  window.addEventListener(
    "pagehide",
    () => {
      void usePhone.getState().stop();
    },
    { once: true },
  );
}

async function startAgent(
  set: (partial: Partial<PhoneStore>) => void,
  gen: number,
  sip: InstallationSip,
  credential: SipCredential,
): Promise<void> {
  agent = new PhoneAgent(
    {
      address: credential.address,
      password: credential.password,
      endpoints: sip.endpoints,
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
        // `incoming` is deliberately left alone: a call ending is not a ring
        // ending, and a still-ringing invitation must not lose its surface.
        set({
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
  // The reader's mute choice survives a takeover: the new agent starts unmuted,
  // so the flag the store already holds is pushed onto it.
  agent.setMuted(usePhone.getState().muted);
  try {
    await agent.start();
    if (gen !== generation) return;
  } catch (err) {
    if (gen !== generation) return;
    /*
     * The line could not register. The reader gets a sentence naming what to
     * look at, and the transport's own words go to the console: a raw
     * "WebSocket closed …" is a fact for whoever configured the server, not a
     * sentence for whoever wanted to make a call.
     */
    console.warn("[gilbert] phone registration failed:", err);
    set({
      state: "unavailable",
      error: t(
        "The line could not register with the SIP server. Check the server address in the installation's SIP Phone settings.",
      ),
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

function closeMirror(): void {
  if (!mirror) return;
  try {
    mirror.close();
  } catch {
    /* already closed */
  }
  mirror = null;
}

/**
 * The tabs that do not hold the line still show the line and the call the
 * leader carries: they hear its state over a `BroadcastChannel` and render it,
 * so a device rings in one place and everyone sees the same call. A follower
 * owns no controls — the launcher gates them on `leader` — and this only paints.
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
        usePhone.setState({ call: message.call ?? null, held: message.held ?? [] });
        break;
      default:
        break;
    }
  };
}

/** Take the line over when the tab that held it stops renewing the lease. */
function scheduleStandbyPoll(
  set: (partial: Partial<PhoneStore>) => void,
  gen: number,
): void {
  if (standbyPoll !== null) return;
  standbyPoll = window.setInterval(() => {
    if (leader || !currentSip || !currentCredential || gen !== generation) return;
    void (async () => {
      if (!(await claimLeadership())) return;
      if (gen !== generation) return;
      await takeLine(set, gen, currentSip!, currentCredential!);
    })();
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
