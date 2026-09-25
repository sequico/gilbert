import { Fragment, Suspense, useEffect, useRef, useState } from "react";
import { Redirect, Route, Router, Switch, useLocation } from "wouter";
import { client } from "@/jmap/client";
import { catchUpLive, push } from "@/jmap/push";
import { BASE_PATH, withBase } from "@/lib/basePath";
import { DEFAULT_APP_NAME } from "@/lib/brand";
import { RELOAD_DEBOUNCE_MS } from "@/lib/fileNodeReload";
import { plural, t, useLanguageVersion, whenLanguageReady } from "@/lib/i18n";
import { lazyView } from "@/lib/lazyView";
import { liveMailAccountIds } from "@/lib/mailAccounts";
import {
  notificationAskDue,
  rememberNotificationAsk,
  setBaseTitle,
  setUnreadBadge,
  shouldAskForNotifications,
} from "@/lib/notify";
import { refreshSettingsPolicy } from "@/lib/settingsPolicy";
import {
  armSettingsSync,
  loadRemoteSettings,
  queueSettingsPush,
  settingsAlreadyLoadedFor,
  settingsSyncAvailable,
} from "@/lib/settingsSync";
import { reloadIfServerRebuilt } from "@/lib/staleBuild";
import { publishWorkerFacts } from "@/lib/swFacts";
import { confirmLeaveUnsaved, hasUnsavedChanges } from "@/lib/unsavedChanges";
import {
  autoEnableWebPush,
  listenForVerification,
  reregisterWebPush,
  turnOnNotificationsHere,
} from "@/lib/webpushEnable";
import { useCalendar } from "@/store/calendar";
import { useChat } from "@/store/chat";
import { useContacts } from "@/store/contacts";
import { useFiles } from "@/store/files";
import { useMail } from "@/store/mail";
import { scheduleSupported, useScheduled } from "@/store/scheduled";
import { useSession } from "@/store/session";
import { settingsInHandFor, syncedPart, useSettings } from "@/store/settings";
import { useSieve } from "@/store/sieve";
import { ConfirmHost } from "@/ui/dialog";
import { Spinner } from "@/ui/misc";
import { ToastHost, toast } from "@/ui/toast";
import { AppShell } from "@/views/AppShell";
import { ComposerDock } from "@/views/compose/ComposerDock";
import { ForcedPasswordChange } from "@/views/ForcedPasswordChange";
import { LoginPage } from "@/views/Login";
import { MailView } from "@/views/mail/MailView";
import { webPushFailureSentence } from "@/views/webPushCopy";

const ContactsView = lazyView(() =>
  import("@/views/contacts/ContactsView").then((m) => ({ default: m.ContactsView })),
);
const CalendarView = lazyView(() =>
  import("@/views/calendar/CalendarView").then((m) => ({ default: m.CalendarView })),
);
const FilesView = lazyView(() =>
  import("@/views/files/FilesView").then((m) => ({ default: m.FilesView })),
);
const SettingsView = lazyView(() =>
  import("@/views/settings/SettingsView").then((m) => ({ default: m.SettingsView })),
);
const AdminView = lazyView(() =>
  import("@/views/AdminView").then((m) => ({ default: m.AdminView })),
);

export function App() {
  const status = useSession((s) => s.status);
  const bootstrap = useSession((s) => s.bootstrap);
  /*
   * The forced-password-change wall (ADR 0001): while it stands, the data
   * routes answer 403 and the only usable screen is the change form. Gating
   * here rather than inside AuthedApp means the wall mounts instead of the
   * app — AuthedApp's data loads and push stream never start, and its
   * cleanup runs when a mid-session force unmounts it.
   */
  const forcedPasswordChange = useSession((s) => s.forcedPasswordChange);
  /*
   * Subscribed once, here, and used as a key below.
   *
   * `t()` is a plain function rather than a hook, so a component has no way of
   * knowing its strings just changed. Rather than make every one of the
   * thousand call sites a subscriber -- which would turn extracting a string
   * from "wrap it" into "wrap it and add a hook" -- the whole tree is thrown
   * away and rebuilt when the catalogue changes. Picking a language is a
   * once-in-an-account event; paying for it there is far cheaper than paying
   * for it on every render everywhere.
   */
  const languageVersion = useLanguageVersion();
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  /*
   * Wait for the catalogue before the first paint.
   *
   * The tree is rebuilt when a catalogue lands, so components recover on
   * their own -- but a string computed in an effect does not. A toast fired
   * in the gap is emitted in English and stays English, in an interface that
   * is otherwise not. The wait costs nothing visible: the session bootstrap
   * is already showing a spinner, and English resolves immediately.
   */
  const [languageReady, setLanguageReady] = useState(false);
  useEffect(() => {
    let live = true;
    void whenLanguageReady().finally(() => live && setLanguageReady(true));
    return () => {
      live = false;
    };
  }, []);

  if (status === "loading" || !languageReady) {
    return (
      <div className="center" style={{ height: "100%" }}>
        <Spinner size="lg" />
      </div>
    );
  }
  return (
    /*
     * Every in-app navigation runs through `aroundNav` -- links, redirects and
     * `navigate()` alike, since wouter routes them all through the same place.
     * That is what makes the guard hold for the app rail and the settings nav
     * without either of them knowing an editor exists.
     *
     * The back button is the gap: by the time `popstate` arrives the history
     * has already moved, and the only way to hold the page would be to push an
     * entry back, which breaks the button for everyone who has nothing pending.
     * Reload and tab close are covered by `beforeunload` instead.
     */
    <Router
      /*
       * The one place the mount prefix enters the router. Every `<Route path>`,
       * `<Link href>` and `navigate()` in the app stays written root-absolute
       * -- `/mail/:mailboxId?` -- and wouter strips the base off the address
       * before matching and puts it back on when it navigates. So a deep link
       * to `/mail/inbox/abc` under a `/mail` mount is `/mail/mail/inbox/abc`
       * and nothing in the views has to know it.
       *
       * Empty is wouter's own default, so the root case is untouched.
       */
      base={BASE_PATH}
      aroundNav={(navigate, to, options) => {
        /*
         * Ask whether the build moved, at the moment a move is asked for.
         *
         * Every view but Mail is a lazy chunk, so the way a stale tab first
         * meets a new build is a 404 on the chunk the click just asked for
         * -- which, with no boundary nearby, unmounts the whole tree into a
         * blank page. The slow poll and the visibility check usually reload
         * the tab first, but the click can beat them. Asking here, alongside
         * the navigation, closes that window: when the server is running a
         * different build the reload lands on the view being navigated to,
         * and its chunk comes from the new build instead of 404ing.
         *
         * After the navigate rather than before, so the reload preserves the
         * destination; and only where the navigation actually proceeds -- a
         * reader who cancels the leave-unsaved dialog is staying on this
         * build, and the poll still covers them.
         */
        const go = () => {
          navigate(to, options);
          void reloadIfServerRebuilt();
        };
        if (!hasUnsavedChanges()) {
          go();
          return;
        }
        void confirmLeaveUnsaved().then((ok) => {
          if (ok) go();
        });
      }}
    >
      <Fragment key={languageVersion}>
        {status === "anonymous" ? (
          <LoginPage />
        ) : forcedPasswordChange ? (
          <ForcedPasswordChange />
        ) : (
          <AuthedApp />
        )}
      </Fragment>
      <ToastHost />
      <ConfirmHost />
    </Router>
  );
}

function AuthedApp() {
  const accountId = useSession((s) => s.accountId);
  const [location] = useLocation();

  /*
   * Settings that live with the account rather than the browser.
   *
   * When this browser has them cached they have already painted, and this only
   * has to correct them (issue #54). When it does not -- an untrusted device,
   * or the sign-out that every deploy causes -- the first frame is the
   * defaults, and the defaults are English. Rendering then means anything
   * computed before the settings land is computed in the wrong language: not
   * the interface, which is rebuilt when the catalogue arrives, but a string
   * emitted once, like a toast. That is why the stale-folder toast came out
   * in English on an otherwise German screen.
   *
   * So without a cache the tree waits, which costs nothing: there was nothing
   * worth painting yet. With one it does not wait, and the screen is as quick
   * as it was.
   *
   * Once per account, not once per mount: this subtree is keyed on the
   * language version, so picking a language throws it away and builds it
   * again. Re-reading the settings file there would apply a copy written
   * before the change and undo it.
   *
   * "Already painted" is asked of the account rather than of the browser
   * (`settingsInHandFor`): a cache that survived into this sign-in is this
   * account's, and one that did not -- every sign-out clears it -- leaves the
   * tree waiting instead of painting the last reader's settings. The constant
   * this replaced answered "is there a cache at all", computed once at module
   * load, so a second sign-in in the same tab painted the first reader's copy
   * and could push it into the new account before its file landed.
   */
  const [ready, setReady] = useState(() => settingsInHandFor(accountId));
  useEffect(() => {
    if (settingsAlreadyLoadedFor(accountId)) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      /* Before the account's own settings, so both the seeding below and the
         enforcement inside `hydrate` have something to apply. */
      await refreshSettingsPolicy();
      if (cancelled) return;
      const remote = await loadRemoteSettings();
      if (cancelled) return;
      if (remote) useSettings.getState().hydrate(remote);
      // No settings file: this account has never had settings of its own, so
      // the installation's defaults are what it starts on rather than
      // Gilbert's. Issue #207.
      else useSettings.getState().seedFromPolicy();
      /*
       * After both, and for everybody: a change the installation wants applied
       * once has to reach accounts that already exist, which is the whole of
       * why it is not just a default. Each is remembered, so a reader who turns
       * one back off keeps it off. Issue #207.
       */
      const applied = useSettings.getState().applyPolicyChanges();
      if (applied.length) {
        toast.show(
          plural(applied.length, {
            one: "Your administrator changed {n} setting",
            other: "Your administrator changed {n} settings",
          }),
          {
            action: {
              label: t("Settings"),
              onClick: () => {
                window.location.href = withBase("/settings/general");
              },
            },
          },
        );
      }
      // The catalogue for whatever language that turned out to be. Hydrating
      // asks for it; this is waiting for the answer.
      await whenLanguageReady();
      if (cancelled) return;
      setReady(true);
      // Pushes were held back until now so they could not race the load. A
      // change made while it was in flight was kept, and goes out here.
      armSettingsSync();
      // No file yet — seed one from what this browser has, so the next device
      // to sign in starts from these rather than from the defaults.
      if (!remote && settingsSyncAvailable())
        queueSettingsPush(syncedPart(useSettings.getState().settings));
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Initial data + push wiring
  useEffect(() => {
    if (!accountId) return;
    /*
     * The push stream opens first, before the startup reads below.
     *
     * A browser allows only a handful of connections per host, and the live
     * updates dot is yellow until this stream's response comes back: started
     * after the reads, it sits queued behind every one of them and the dot
     * stays yellow long after the app is usable. Opened first, it claims its
     * connection and turns green while the reads run behind it.
     */
    push.start();
    const mail = useMail.getState();
    /*
     * Renewal is chained onto this load on purpose: the registration's
     * emailPush filter is built from the inbox id, which only exists once the
     * mailbox tree has landed. A subscription made too early silently carries
     * no filter, and Stalwart then pushes every unread message -- junk
     * included -- for the whole life of the subscription.
     *
     * `autoEnableWebPush` renews a browser that already has push, and makes
     * the subscription for one whose permission is granted but whose switch was
     * never turned on -- the state that used to get no prompt at all.
     */
    void mail
      .loadMailboxes()
      .then(() => autoEnableWebPush())
      .catch(() => {});
    void mail.loadIdentities();
    void mail.loadQuota();
    // So a held message shows its banner wherever it is opened from, not just
    // after a visit to the Scheduled folder.
    if (scheduleSupported()) void useScheduled.getState().load();
    void useContacts.getState().init();
    void useCalendar.getState().init();
    void useFiles.getState().init();
    void useSieve.getState().init();
    // A push subscription stays silent until its verification code is echoed
    // back, and the code may have arrived while no tab was open.
    listenForVerification();
    /*
     * A push subscription expires -- seven days is the ceiling JMAP puts on one,
     * and re-registering before that is the client's job. Nothing did it, so
     * background notifications lapsed within a week of being switched on and
     * only came back if somebody happened to toggle the switch. Opening the app
     * is the moment this is done -- registering is a JMAP call, and a start is
     * when the app is open and about to use the subscription -- so it runs on
     * every start, chained onto the mailbox load above.
     */
    /*
     * One pass for a burst of StateChanges, every account and type in it.
     *
     * Not the per-key debounce the FileNode readers use
     * (`lib/fileNodeReload`): this one collects the whole burst and hands it to
     * the dispatchers once, because each dispatcher routes the accounts it
     * holds, while those re-read one group or one account each. The window is
     * the same number, because it is the same burst being smoothed.
     */
    const pending = new Map<string, Set<string>>();
    let timer: number | null = null;
    /*
     * Hand one account's types to every store that draws them. The promises are
     * returned so a cancellable pass can wait for its own paging reads (mail
     * and chat); the stores that only kick a single reload off are not awaited
     * (each is one read with its own error handling) and are not dispatched at
     * all once the pass is already aborted.
     */
    const dispatch = (
      accountId: string,
      types: Set<string>,
      signal?: AbortSignal,
    ): Promise<unknown>[] => {
      if (signal?.aborted) return [];
      const work: Promise<unknown>[] = [];
      if (accountId === useMail.getState().accountId) {
        work.push(useMail.getState().applyChanges(types, signal));
      } else {
        // A mailbox changed while the reader is elsewhere -- a group box under
        // their own, or their own while they are inside a group. The store
        // refreshes its tree and announces what it received, or ignores an
        // account that is not one of the reader's mailboxes.
        work.push(useMail.getState().applyAccountChanges(accountId, types, signal));
      }
      /*
       * Shared data lives in an account that is not the reader's own, but these
       * stores draw it beside their own: a change to a shared account has to
       * reach them too. Each store routes the account — its own, or one whose
       * shared cache it renders — and ignores the rest.
       */
      useContacts.getState().applyChanges(types, accountId);
      useCalendar.getState().applyChanges(types, accountId);
      if (accountId === useFiles.getState().accountId)
        useFiles.getState().applyChanges(types);
      if (accountId === useSieve.getState().accountId)
        useSieve.getState().applyChanges(types);
      // Chat is FileNode state on the group accounts (ADR 0005); the store
      // ignores accounts it does not hold and events it does not need, so
      // every FileNode change can be offered to it.
      if (types.has("FileNode"))
        work.push(useChat.getState().applyChanges(accountId, signal));
      return work;
    };
    const queue = (acct: string, type: string) => {
      const types = pending.get(acct) ?? new Set<string>();
      types.add(type);
      pending.set(acct, types);
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = null;
        for (const [a, types] of pending) dispatch(a, types);
        pending.clear();
      }, RELOAD_DEBOUNCE_MS);
    };
    const unsub = push.subscribe((acct, type) => queue(acct, type));
    /*
     * One catch-up pass, run from the two signals that say the server can be
     * reached: the live stream coming back after a drop, and the reachability
     * probe behind each failed attempt — which is all a network that blocks the
     * stream leaves. The pass is the same `catchUpLive` over the same account
     * set the live path uses, so it cannot cover less than the live path does,
     * and it is idempotent from each store's last-known state.
     *
     * It is single-flight and cancellable. One pass runs at a time and a signal
     * arriving meanwhile is coalesced into a single re-run; when the connection
     * leaves "connected" the pass in flight is aborted — through the signal
     * every call in it carries — so a line that drops mid-sync neither leaves
     * requests running against nothing nor stacks a second pass on top.
     */
    let catchUpAbort: AbortController | null = null;
    let catchUpRunning = false;
    let catchUpWanted = false;
    const runCatchUp = async (signal: AbortSignal) => {
      const byAccount = new Map<string, Set<string>>();
      const mail = useMail.getState();
      catchUpLive(
        liveMailAccountIds(mail.accountId, mail.mailAccounts),
        (accountId, type) => {
          const types = byAccount.get(accountId) ?? new Set<string>();
          types.add(type);
          byAccount.set(accountId, types);
        },
      );
      const work: Promise<unknown>[] = [];
      for (const [accountId, types] of byAccount)
        work.push(...dispatch(accountId, types, signal));
      await Promise.allSettled(work);
    };
    const startCatchUp = () => {
      if (catchUpRunning) {
        catchUpWanted = true;
        return;
      }
      catchUpRunning = true;
      catchUpWanted = false;
      const controller = new AbortController();
      catchUpAbort = controller;
      void runCatchUp(controller.signal).finally(() => {
        catchUpRunning = false;
        if (catchUpAbort === controller) catchUpAbort = null;
        // A signal that arrived during the pass re-runs it. An abort does not:
        // `stopCatchUp` cleared the flag before aborting, so only a trigger
        // that came *after* the abort can still be waiting here.
        if (catchUpWanted) startCatchUp();
      });
    };
    const stopCatchUp = () => {
      catchUpWanted = false;
      catchUpAbort?.abort();
    };
    // The stream returning after a drop is the reconnect catch-up; leaving
    // "connected" aborts whatever pass is in flight. The first connect of a
    // session is deliberately exempt (see `onReconnect`): the initial load is
    // happening right then.
    const unsubReconnect = push.onReconnect(startCatchUp);
    /*
     * Abort only on a transition *out of* "connected". The dot's state also
     * notifies for its own reasons — a failed attempt's reason arrives in a
     * second update that is still "connecting" — and treating every
     * non-connected emission as a drop would abort the very pass the
     * reachability probe just started.
     */
    let wasConnected = false;
    const unsubConn = push.onConnection((state) => {
      if (state === "connected") {
        wasConnected = true;
        return;
      }
      if (wasConnected) {
        wasConnected = false;
        stopCatchUp();
      }
    });
    const unsubReach = push.onReachability((reachable) => {
      // Only the blocked-stream case needs this: while the stream is up it is
      // the catch-up trigger, and on a down line nothing is reachable.
      if (!reachable) stopCatchUp();
      else if (!push.connected) startCatchUp();
    });
    // The browser knows a line dropped before the stream's error does; a pass
    // already in flight is stopped at once.
    const onOffline = () => stopCatchUp();
    window.addEventListener("offline", onOffline);
    const unsubState = client.onSessionState(() => {
      void useSession.getState().refresh();
      // A session refresh can add or drop group mailboxes; rediscover them.
      void useMail.getState().discoverMailAccounts();
    });
    return () => {
      unsub();
      unsubReconnect();
      unsubConn();
      unsubReach();
      unsubState();
      window.removeEventListener("offline", onOffline);
      // A live burst queued but not yet flushed must not dispatch against the
      // stores of the next account.
      if (timer) window.clearTimeout(timer);
      stopCatchUp();
      push.stop();
    };
  }, [accountId]);

  // Unread badge in title/favicon. The reader's own inbox, not the active
  // account's: browsing a group mailbox must not swap the badge for the
  // group's unread count. Each account's tree in accountTrees is kept fresh
  // by loadMailboxes (active) and refreshAccountTree (the others).
  const inboxUnread = useMail((s) => {
    const ownId = s.ownAccountId;
    const tree = ownId ? s.accountTrees[ownId] : null;
    if (!tree) return 0;
    for (const id in tree) {
      const m = tree[id];
      if (m?.role === "inbox") return m.unreadEmails ?? 0;
    }
    return 0;
  });
  const appName = useSession((s) => s.session?.gilbert?.appName) || DEFAULT_APP_NAME;
  useEffect(() => {
    setBaseTitle(appName);
    setUnreadBadge(inboxUnread);
  }, [inboxUnread, appName]);

  /*
   * Leave the service worker its briefing.
   *
   * Written from here rather than once at startup because everything in it can
   * change while the app is open -- the language from Settings, the archive
   * folder from the mailbox list arriving -- and what is written is what the
   * worker will still be reading a week from now, with no tab to correct it.
   * See lib/swFacts.ts.
   */
  const archiveId = useMail((s) => s.roleId("archive"));
  const inboxId = useMail((s) => s.roleId("inbox"));
  const mailAccounts = useMail((s) => s.mailAccounts);
  const accountTrees = useMail((s) => s.accountTrees);
  /*
   * A stable signature of the chats and their watermarks, so the worker's
   * cache is rewritten only when what it reads actually changes. The
   * conversations object is replaced on every draft keystroke, which is not a
   * reason to publish anything.
   */
  const chatSignature = useChat((s) =>
    Object.values(s.conversations)
      .filter((c) => c.folders)
      .map(
        (c) =>
          `${c.accountId}|${c.name}|${c.folders!.chat}|${c.nodes.reduce(
            (m, n) => (n.at > m ? n.at : m),
            "",
          )}`,
      )
      .join("\n"),
  );
  const languageVersion = useLanguageVersion();
  useEffect(() => {
    /*
     * One entry per account the subscription covers (ADR 0016): the reader's
     * own and every group mailbox, each with the Inbox and archive its
     * notification needs, its name, and -- where it has a chat -- the chat
     * folder and the newest instant the app has seen. The watermark is the
     * maximum `at` over the held nodes rather than the last node's: the
     * transcript is ordered by server `created`, and a sender whose clock is
     * behind would otherwise drag the watermark backwards and have an old
     * message announced again.
     */
    const conversations = Object.values(useChat.getState().conversations);
    const ownAddress = useSession.getState().session?.username ?? "";
    const accounts = mailAccounts.map((a) => {
      if (a.kind === "own")
        return {
          accountId: a.accountId,
          own: true,
          name: ownAddress,
          inboxId,
          archiveId,
          chatFolderId: null,
          watermark: "",
        };
      const tree = Object.values(accountTrees[a.accountId] ?? {});
      const conv = conversations.find((c) => c.accountId === a.accountId && c.folders);
      return {
        accountId: a.accountId,
        own: false,
        name: a.name,
        inboxId: tree.find((m) => m.role === "inbox")?.id ?? null,
        archiveId: tree.find((m) => m.role === "archive")?.id ?? null,
        chatFolderId: conv?.folders?.chat ?? null,
        watermark: conv ? conv.nodes.reduce((m, n) => (n.at > m ? n.at : m), "") : "",
      };
    });
    void publishWorkerFacts(accounts, ownAddress);
  }, [mailAccounts, accountTrees, inboxId, archiveId, languageVersion, chatSignature]);

  /*
   * Ask for the notification permission where the reader will see it.
   *
   * The browser grants this permission only to a gesture, so nothing can turn
   * notifications on by itself -- but the switches default on and the ask
   * never happens is how somebody ends up with none and no idea why. This is
   * the ask, and its button is the gesture the permission needs. The action
   * also subscribes this browser where the device can do background push, so
   * "on" means the system notification and not only the in-tab one. It is
   * shown once the app is ready, and never once the browser has answered.
   */
  const notificationsWanted = useSettings((s) => s.settings.desktopNotifications);
  useEffect(() => {
    if (!ready || !accountId) return;
    const permission =
      typeof Notification === "undefined" || !("Notification" in window)
        ? "unsupported"
        : Notification.permission;
    if (!shouldAskForNotifications(permission, notificationsWanted)) return;
    if (!notificationAskDue()) return;
    rememberNotificationAsk();
    toast.show(
      t(
        "Turn on notifications? New mail and chat reach you even when Gilbert is in the background.",
      ),
      {
        duration: 0,
        action: {
          label: t("Turn on notifications"),
          onClick: async () => {
            const res = await turnOnNotificationsHere();
            if (res.failure) toast.error(webPushFailureSentence(res.failure));
          },
        },
      },
    );
  }, [ready, accountId, notificationsWanted]);

  /*
   * A subscription is built once and extended only in `expires`: its `types`
   * and its `emailPush` map are fixed at creation. So the accounts it covers --
   * and whether it watches `FileNode` at all, which a reader joining a first
   * group or leaving a last one changes -- are what a re-registration has to
   * follow, not the chat switch alone. The signature is the accounts and their
   * Inbox ids; the first value seen is the one the start's own registration
   * already used.
   */
  const pushTargetSignature = mailAccounts
    .map((a) => {
      const inbox =
        a.kind === "own"
          ? inboxId
          : (Object.values(accountTrees[a.accountId] ?? {}).find(
              (m) => m.role === "inbox",
            )?.id ?? "");
      return `${a.accountId}:${inbox ?? ""}`;
    })
    .join("|");
  const pushTargetSeen = useRef<string | null>(null);
  useEffect(() => {
    if (pushTargetSeen.current === null) {
      pushTargetSeen.current = pushTargetSignature;
      return;
    }
    if (pushTargetSeen.current === pushTargetSignature) return;
    pushTargetSeen.current = pushTargetSignature;
    void reregisterWebPush();
  }, [pushTargetSignature]);

  // Nothing worth painting until the account's settings are in force; see the
  // comment on `ready` above. With a cache this was true from the first frame.
  if (!ready) {
    return (
      <div className="center" style={{ height: "100%" }}>
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <AppShell>
      <Suspense fallback={<Spinner size="lg" />}>
        <Switch>
          <Route path="/mail/:mailboxId?/:threadId?">
            {(p) => <MailView mailboxId={p.mailboxId} threadId={p.threadId} />}
          </Route>
          <Route path="/search/:threadId?">
            {(p) => <MailView search threadId={p.threadId} />}
          </Route>
          <Route path="/contacts/:id?">{(p) => <ContactsView id={p.id} />}</Route>
          <Route path="/calendar/:view?/:date?">
            {(p) => <CalendarView view={p.view} date={p.date} />}
          </Route>
          <Route path="/files/:nodeId?">{(p) => <FilesView nodeId={p.nodeId} />}</Route>
          <Route path="/settings/:section?">
            {(p) => <SettingsView section={p.section} />}
          </Route>
          <Route path="/admin/:section?">
            {(p) => <AdminView section={p.section} />}
          </Route>
          <Route path="/login">
            <Redirect to="/mail" />
          </Route>
          <Route>
            {location === "/" ? <Redirect to="/mail" /> : <Redirect to="/mail" />}
          </Route>
        </Switch>
      </Suspense>
      <ComposerDock />
    </AppShell>
  );
}
