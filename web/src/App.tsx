import { Fragment, Suspense, useEffect, useState } from "react";
import { Redirect, Route, Router, Switch, useLocation } from "wouter";
import { client } from "@/jmap/client";
import { catchUpAfterReconnect, push } from "@/jmap/push";
import { BASE_PATH, withBase } from "@/lib/basePath";
import { DEFAULT_APP_NAME } from "@/lib/brand";
import { plural, t, useLanguageVersion, whenLanguageReady } from "@/lib/i18n";
import { lazyView } from "@/lib/lazyView";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { setBaseTitle, setUnreadBadge } from "@/lib/notify";
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
import { listenForVerification, renewWebPush } from "@/lib/webpushEnable";
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
    const mail = useMail.getState();
    /*
     * Renewal is chained onto this load on purpose: the registration's
     * emailPush filter is built from the inbox id, which only exists once the
     * mailbox tree has landed. A subscription made too early silently carries
     * no filter, and Stalwart then pushes every unread message -- junk
     * included -- for the whole life of the subscription.
     */
    void mail
      .loadMailboxes()
      .then(() => renewWebPush())
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
    push.start();
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
    const pending = new Map<string, Set<string>>();
    let timer: number | null = null;
    const queue = (acct: string, type: string) => {
      const types = pending.get(acct) ?? new Set<string>();
      types.add(type);
      pending.set(acct, types);
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = null;
        for (const [a, types] of pending) {
          if (a === useMail.getState().accountId) {
            void useMail.getState().applyChanges(types);
          } else if (useMail.getState().mailAccounts.some((x) => x.accountId === a)) {
            // A mailbox changed while the reader is elsewhere -- a group box
            // under their own, or their own while they are inside a group.
            // Refresh its folder tree so the sidebar's counts stay honest.
            void useMail.getState().refreshAccountTree(a);
          }
          /*
           * Shared data lives in an account that is not the reader's own, but
           * these stores draw it beside their own: a change to a shared
           * account has to reach them too. Each store routes the account — its
           * own, or one whose shared cache it renders — and ignores the rest.
           */
          useContacts.getState().applyChanges(types, a);
          useCalendar.getState().applyChanges(types, a);
          if (a === useFiles.getState().accountId)
            useFiles.getState().applyChanges(types);
          if (a === useSieve.getState().accountId)
            useSieve.getState().applyChanges(types);
          // Chat is FileNode state on the group accounts (ADR 0005); the
          // store ignores accounts it does not hold and events it does not
          // need, so every FileNode change can be offered to it.
          if (types.has("FileNode")) void useChat.getState().applyChanges(a);
        }
        pending.clear();
      }, 400);
    };
    const unsub = push.subscribe((acct, type) => queue(acct, type));
    /*
     * Catch-up when the push connection comes back after a drop — sleep, a
     * wifi blip, a suspended tab. Push delivered nothing while it was down,
     * and the poll below only runs while it is down, so the moment the
     * connection returns is the one moment left to fetch what happened in the
     * gap; without this the lists and the badge stay stale until an unrelated
     * event arrives. Every account is caught up the way a StateChange for it
     * would be — per-account changes from the store's last-known state, which
     * is safe and idempotent whether or not the server replays anything on
     * reconnect — and every live type goes to the dispatcher the live path
     * uses, so no surface is left out of the gap. The first connect of a
     * session is deliberately exempt: the initial load is happening right now.
     */
    const unsubReconnect = push.onReconnect(() => {
      const mail = useMail.getState();
      const accounts = new Set<string>();
      if (mail.accountId) accounts.add(mail.accountId);
      for (const a of mail.mailAccounts) accounts.add(a.accountId);
      // A group mailbox is reached through the account that owns it.
      for (const a of groupMailboxAccounts(mail.mailAccounts)) accounts.add(a.accountId);
      catchUpAfterReconnect(accounts, queue);
    });
    const unsubState = client.onSessionState(() => {
      void useSession.getState().refresh();
      // A session refresh can add or drop group mailboxes; rediscover them.
      void useMail.getState().discoverMailAccounts();
    });
    // Poll fallback when push is disconnected (every 2 minutes)
    const poll = window.setInterval(() => {
      if (!push.connected && document.visibilityState === "visible") {
        void useMail.getState().applyChanges(new Set(["Email", "Mailbox"]));
        for (const a of groupMailboxAccounts(useMail.getState().mailAccounts))
          void useChat.getState().applyChanges(a.accountId);
      }
    }, 120_000);
    return () => {
      unsub();
      unsubReconnect();
      unsubState();
      window.clearInterval(poll);
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
  const languageVersion = useLanguageVersion();
  useEffect(() => {
    void publishWorkerFacts(accountId, archiveId);
  }, [accountId, archiveId, languageVersion]);

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
