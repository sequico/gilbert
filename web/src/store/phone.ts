/**
 * The phone's state (ADR 0023): the one line, the call on it, and the actions
 * the surfaces offer.
 *
 * The Janus SIP client is `@/lib/phone/sip`; this store owns what the screen
 * reads and the person's own account. Exactly one tab holds the line, and the
 * seat is a **Web Lock**: the first tab to ask it registers the account, and
 * every other tab of the same origin waits on the lock and shows no phone. A
 * tab that holds the seat keeps it until it is closed, reloaded or signed out —
 * the browser releases the lock then — and the next waiting tab takes over.
 */
import { create } from "zustand";
import { CAP } from "@/jmap/client";
import { accountFor, readSipAccounts } from "@/lib/phone/credential";
import {
  requestMicrophone as askMicrophone,
  type MicrophonePermission,
  microphoneState as readMicrophoneState,
} from "@/lib/phone/microphone";
import { type LineState, Phone } from "@/lib/phone/sip";
import { useMail } from "./mail";
import { useSession } from "./session";

/** The line as the top-bar entry reads it; `off` is the feature not offered. */
export type PhoneState = LineState | "off";

interface PhoneStore {
  state: PhoneState;
  /** Whether the phone is offered at all: an account, and a bridge that works. */
  ready: boolean;
  /** The ringing call, before it is answered. */
  incoming: string | null;
  /** The call, once it is connected. */
  call: { remote: string } | null;
  /** What the call surface plays: the peer's audio. */
  stream: MediaStream | null;
  muted: boolean;
  error: string | null;
  /** What the browser will say about the microphone, without prompting. */
  microphone: MicrophonePermission;

  /** Take the seat if it is free, and register the account. */
  start(): Promise<void>;
  /** Give the seat up and stop. Called on sign-out and on `pagehide`. */
  stop(): Promise<void>;
  dial(target: string): Promise<void>;
  answer(): Promise<void>;
  decline(): Promise<void>;
  hangup(): Promise<void>;
  setMuted(muted: boolean): void;
  sendDtmf(tones: string): void;
  /** Ask for the microphone, in this gesture, and remember the answer. */
  requestMicrophone(): Promise<MicrophonePermission>;
}

/** The Web Lock that seats one tab. */
const SEAT = "gilbert-phone";
const CREDENTIAL_RETRY_MS = 30_000;

/** The store's own setter, able to take an update built from the current state. */
type SetState = (
  partial: Partial<PhoneStore> | ((state: PhoneStore) => Partial<PhoneStore>),
) => void;

/** The one phone of this tab. */
let phone: Phone | null = null;
/** Whether this tab has begun taking the seat. */
let started = false;
/** Releases the seat; resolving it is how this tab gives the lock up. */
let releaseSeat: (() => void) | null = null;
/** Bumped by `stop()`, so an abandoned run tears its own work down. */
let generation = 0;
let credentialRetry: number | null = null;

export const usePhone = create<PhoneStore>((set, get) => ({
  state: "off",
  ready: false,
  incoming: null,
  call: null,
  stream: null,
  muted: false,
  error: null,
  microphone: "unknown",

  async start() {
    if (started) return;
    started = true;
    const gen = generation;
    if (!navigator.locks?.request) {
      // A browser with no Web Locks has one tab to coordinate with: this one.
      await begin(set, gen);
      return;
    }
    /*
     * The lock is held for as long as this callback stays pending, which is as
     * long as the tab is the phone. `request` is deliberately not awaited here:
     * this run is done once `begin` has registered, and the tab keeps the seat
     * afterwards.
     */
    void navigator.locks.request(SEAT, async () => {
      if (gen !== generation) return;
      await begin(set, gen);
      if (gen !== generation) return;
      await new Promise<void>((resolve) => {
        releaseSeat = resolve;
      });
      releaseSeat = null;
    });
  },

  async stop() {
    generation += 1;
    clearCredentialRetry();
    releaseSeat?.();
    releaseSeat = null;
    started = false;
    const held = phone;
    phone = null;
    await held?.stop().catch(() => undefined);
    set({
      state: "off",
      ready: false,
      incoming: null,
      call: null,
      stream: null,
      muted: false,
      error: null,
    });
  },

  async dial(target) {
    if (!phone) return;
    set({ error: null });
    await get().requestMicrophone();
    try {
      await phone.call(target);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async answer() {
    await get().requestMicrophone();
    await phone?.answer().catch(() => undefined);
    set({ incoming: null });
  },

  async decline() {
    await phone?.decline().catch(() => undefined);
    set({ incoming: null });
  },

  async hangup() {
    await phone?.hangup().catch(() => undefined);
  },

  setMuted(muted) {
    set({ muted });
    phone?.setMuted(muted);
  },

  sendDtmf(tones) {
    phone?.sendDtmf(tones);
  },

  async requestMicrophone() {
    const microphone = await askMicrophone();
    set({ microphone });
    return microphone;
  },
}));

/** Read the person's account, and register the identity they send as. */
async function begin(set: SetState, gen: number): Promise<void> {
  const session = useSession.getState();
  const accountId = session.ownAccountFor(CAP.mail);
  if (!accountId) {
    set({ state: "off", ready: false });
    return;
  }
  const accounts = await readSipAccounts(accountId);
  if (gen !== generation) return;
  const identity = useMail.getState().defaultIdentity();
  const primary =
    Object.values(session.session?.accounts ?? {}).find((a) => a.isPersonal)?.name ??
    session.session?.username ??
    "";
  const credential =
    accountFor(accounts, identity?.email) ?? accountFor(accounts, primary);
  if (!credential) {
    /*
     * The identity list may not have landed yet, or the account holds no
     * account at all. A retry is what keeps a slow read from disabling the
     * phone for the session; a real absence simply retries quietly.
     */
    set({ state: "off", ready: false });
    scheduleCredentialRetry(set, gen);
    return;
  }
  clearCredentialRetry();
  void readMicrophoneState().then((microphone) => set({ microphone }));
  const held = phone;
  phone = null;
  await held?.stop().catch(() => undefined);

  phone = new Phone(credential, {
    onLine: (state) =>
      set((current) => ({
        state,
        ready: state === "registered" || current.ready,
      })),
    onIncoming: (from) => set({ incoming: from || null }),
    onCall: (call, stream) => set({ call, stream }),
    onError: (message) => set({ error: message }),
  });
  await phone.start();
}

function scheduleCredentialRetry(set: SetState, gen: number): void {
  if (credentialRetry !== null) return;
  credentialRetry = window.setTimeout(() => {
    credentialRetry = null;
    if (gen !== generation) return;
    void begin(set, gen);
  }, CREDENTIAL_RETRY_MS);
}

function clearCredentialRetry(): void {
  if (credentialRetry === null) return;
  window.clearTimeout(credentialRetry);
  credentialRetry = null;
}
