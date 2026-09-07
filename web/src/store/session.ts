import { create } from "zustand";
import { ApiError, apiFetch, CAP, client } from "@/jmap/client";
import { type PushState, push } from "@/jmap/push";
import type { Id, JmapSession } from "@/jmap/types";
import { accountForCapability, ownAccountForCapability } from "@/lib/accountRouting";
import { setServerLocale } from "@/lib/datetime";
import { startIdleLogout, stopIdleLogout } from "@/lib/idleLogout";
import { flushSettingsPush, stopSettingsSync } from "@/lib/settingsSync";
import { reloadIfServerRebuilt } from "@/lib/staleBuild";
import { clearAllData, clearSignedInData, setDeviceTrusted } from "@/lib/storage";
import { unsubscribeThisDevice } from "@/lib/webpush";

export type AuthStatus = "loading" | "anonymous" | "authenticated";

/** A session probe already on its way, so two callers share one request. */
let bootstrapInFlight: Promise<void> | null = null;

interface SessionState {
  status: AuthStatus;
  session: JmapSession | null;
  /** Selected mail account (defaults to primary). */
  accountId: Id | null;
  error: string | null;
  pushConnected: boolean;
  /** Finer than pushConnected: tells "reconnecting" from "not connected". */
  pushState: PushState;
  /**
   * ADR 0005: the server is refusing the data routes until this account's
   * password changes. True when the session says so and when a request comes
   * back 403 password_change_required; the app renders the forced-change
   * wall instead of itself while it is set.
   */
  forcedPasswordChange: boolean;
  bootstrap(): Promise<void>;
  login(
    username: string,
    password: string,
    totp: string,
    remember: boolean,
  ): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  setAccount(id: Id): void;
  /** The account to read and write for a capability, honouring the account switcher. */
  accountFor(cap: string): Id | null;
  /** The user's own account for a capability, whatever they are looking at. */
  ownAccountFor(cap: string): Id | null;
}

export const useSession = create<SessionState>((set, get) => ({
  status: "loading",
  session: null,
  accountId: null,
  error: null,
  pushConnected: false,
  pushState: "disconnected",
  forcedPasswordChange: false,

  async bootstrap() {
    /*
     * One probe at a time. The App mounts the bootstrap effect once, but
     * React's StrictMode (dev) mounts, unmounts and remounts it, so two
     * calls can race out of the same first paint -- and an anonymous client
     * answers 401, twice. Every caller wants the same session, so a call
     * already on the way is the answer; the latch drops once it lands so a
     * later, genuinely new probe still happens.
     */
    if (bootstrapInFlight) return bootstrapInFlight;
    bootstrapInFlight = (async () => {
      try {
        const s = await apiFetch<JmapSession>("/api/auth/session");
        applySession(s, set);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401)
          set({
            status: "anonymous",
            session: null,
            accountId: null,
            forcedPasswordChange: false,
          });
        else
          set({
            status: "anonymous",
            session: null,
            accountId: null,
            forcedPasswordChange: false,
            error: (err as Error).message,
          });
      } finally {
        bootstrapInFlight = null;
      }
    })();
    return bootstrapInFlight;
  },

  async login(username, password, totp, remember) {
    set({ error: null });
    const s = await apiFetch<JmapSession>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, totp: totp || undefined, remember }),
    });
    applySession(s, set);
  },

  async logout() {
    push.stop();
    setServerLocale(null);
    // Anything still sitting in the debounce is written while the session can
    // still write it; a setting changed seconds before signing out is not lost.
    try {
      await flushSettingsPush();
    } catch {
      /* ignore */
    }
    // A push subscription lives on the account, not the session, so signing out
    // without removing it leaves this browser notifying for a mailbox nobody is
    // signed into. On a shared machine that is somebody else's mail.
    try {
      await unsubscribeThisDevice();
    } catch {
      /* never block signing out over this */
    }
    stopSettingsSync();
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    stopIdleLogout();
    // Unconditional. The push subscription above is removed for exactly this
    // reason -- that a browser left holding someone's mail is somebody else's
    // problem next -- and the address book cached here is the same argument.
    clearSignedInData();
    client.session = null;
    set({
      status: "anonymous",
      session: null,
      accountId: null,
      forcedPasswordChange: false,
    });
  },

  async refresh() {
    try {
      const s = await apiFetch<JmapSession>("/api/auth/session?refresh=1");
      client.session = s;
      setServerLocale(s.gilbert?.userLocale);
      // A refresh after the forced-change wall was lifted is what lets the app
      // continue; a refresh while the wall stands keeps it up.
      set({ session: s, forcedPasswordChange: s.gilbert?.mustChangePassword === true });
    } catch {
      /* ignore */
    }
  },

  setAccount(id) {
    set({ accountId: id });
  },

  accountFor(cap) {
    return accountForCapability(get().session, get().accountId, cap);
  },

  ownAccountFor(cap) {
    return ownAccountForCapability(get().session, cap);
  },
}));

function applySession(s: JmapSession, set: (p: Partial<SessionState>) => void) {
  client.session = s;
  setServerLocale(s.gilbert?.userLocale);
  // `remember` is the answer to "is this device yours", given at sign-in and
  // carried on the session -- so a reload arrives at the same answer without
  // the client storing it, which on an untrusted device it could not do anyway.
  const trusted = Boolean(s.gilbert?.remember);
  setDeviceTrusted(trusted);
  if (trusted) {
    stopIdleLogout();
  } else {
    // Residue from an earlier trusted session on this machine is exactly what
    // an untrusted sign-in is asking us not to keep.
    clearAllData();
    startIdleLogout(() => void useSession.getState().logout());
  }
  const accountId = s.primaryAccounts[CAP.mail] ?? Object.keys(s.accounts)[0] ?? null;
  set({
    status: "authenticated",
    session: s,
    accountId,
    error: null,
    forcedPasswordChange: s.gilbert?.mustChangePassword === true,
  });
}

client.onUnauthenticated(() => {
  push.stop();
  stopSettingsSync();
  stopIdleLogout();
  clearSignedInData();
  client.session = null;
  // Ask before showing the sign-in form rather than after. A deploy is the
  // usual reason to be signed out here, and reloading a form someone has
  // already started typing into would throw the password away.
  void reloadIfServerRebuilt().then((reloading) => {
    if (!reloading)
      useSession.setState({
        status: "anonymous",
        session: null,
        accountId: null,
        forcedPasswordChange: false,
      });
  });
});

/**
 * The forced-password-change door stopped a request (ADR 0005).
 *
 * The session is still alive — this is a wall, not a sign-out — but every
 * loop that would hit the data path has to stop, as on 401, or it would just
 * collect 403s. The store flip unmounts the app and mounts the wall; a
 * successful change refreshes the session and flips it back.
 */
let recheckWall: number | null = null;
client.onForcedPasswordChange(() => {
  push.stop();
  stopSettingsSync();
  useSession.setState({ forcedPasswordChange: true });
  /*
   * A data request that was in flight while the wall stood can answer 403
   * after the password change has already cleared the directive — the door
   * judged it before the clear — and land after the refresh lowered the
   * wall, putting it back up with nothing left to lower it. One re-probe a
   * second after the last such 403 settles the question against the current
   * server state; a session that is genuinely still forced stays up.
   */
  if (recheckWall !== null) window.clearTimeout(recheckWall);
  recheckWall = window.setTimeout(() => {
    recheckWall = null;
    void useSession.getState().refresh();
  }, 1000);
});

push.onConnection((state) =>
  useSession.setState({ pushConnected: state === "connected", pushState: state }),
);

export function hasCap(cap: string): boolean {
  return client.hasCapability(cap);
}
