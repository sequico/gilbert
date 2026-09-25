import {
  Calendar,
  ChevronsUpDown,
  Download,
  FolderOpen,
  HelpCircle,
  LogOut,
  type LucideIcon,
  Mail,
  Menu as MenuIcon,
  Moon,
  PenSquare,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  Smartphone,
  Sun,
  Upload,
  Users,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useLocation } from "wouter";
import { DEFAULT_APP_NAME } from "@/lib/brand";
import { formatSize } from "@/lib/format";
import { t } from "@/lib/i18n";
import { lazyView } from "@/lib/lazyView";
import { toggleTarget } from "@/lib/palette";
import { accountQuota } from "@/lib/quota";
import { collectShare } from "@/lib/shareTarget";
import { applyAppUpdate } from "@/lib/staleBuild";
import { draftFromMailto, useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { useEffectiveTheme, useSettings } from "@/store/settings";
import { BrandLogo } from "@/ui/BrandLogo";
import { Avatar, useIsMobile } from "@/ui/misc";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { Splitter } from "@/ui/Splitter";
import { TranslateBoundary } from "@/ui/TranslateBoundary";
import { ChatLauncher } from "./chat/ChatLauncher";
import { InstallAppDialog, InstallBanner, useInstallState } from "./InstallApp";
import { MailboxPicker } from "./mail/MailboxPicker";
import { MailboxTree } from "./mail/MailboxTree";
import { PhoneLauncher } from "./phone/PhoneLauncher";
import { SearchBar } from "./SearchBar";
import { offerShare } from "./ShareOffer";
import { ShortcutsDialog, useGlobalShortcuts } from "./Shortcuts";

/*
 * The other sections' sidebars, loaded with the section they belong to.
 *
 * `lazyView` rather than `lazy`: a chunk that hangs reaches the crash boundary
 * instead of leaving a spinner forever, which is the convention every route view
 * in this app already follows.
 */
const CalendarSidebar = lazyView(() =>
  import("./calendar/CalendarSidebar").then((m) => ({ default: m.CalendarSidebar })),
);
const ContactsSidebar = lazyView(() =>
  import("./contacts/ContactsSidebar").then((m) => ({ default: m.ContactsSidebar })),
);
const FilesTree = lazyView(() =>
  import("./files/FilesTree").then((m) => ({ default: m.FilesTree })),
);

/*
 * How far the sidebar edge can be dragged. Below about 240px the module bar
 * and the folder names start to run short in English; the floor sits a little
 * above that. Long folder names are allowed to ellipsize -- narrowing the pane
 * is asking for that. The ceiling keeps a list and a reading pane beside it on
 * an ordinary laptop screen.
 */
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 480;

const PUSH_LABEL = {
  connected: "Live updates connected",
  connecting: "Live updates reconnecting…",
  disconnected: "Live updates off — checking periodically instead",
} as const;

/**
 * A section of the app, and what starting something in it means.
 *
 * `event` is how a section that has its own view asks that view to open its
 * editor: the view owns the dialog, the shell only knows the button. Mail is
 * the exception and has no event -- its composer is this app's own store, so
 * the button calls it directly.
 */
interface Module {
  id: string;
  href: string;
  label: string;
  icon: LucideIcon;
  action: { label: string; icon: LucideIcon; event?: string };
}

/**
 * The five sections, written down once.
 *
 * Four things on this screen are a list of them: the drawer's compose button,
 * the module bar at the foot of the drawer, the phone's tab bar and the phone's
 * floating button. Every one of those renders this table, which is what keeps
 * them agreeing about which section is current, what its primary action is and
 * what that action is called.
 *
 * A section that has an editor of its own is reached through `event` rather
 * than by this file: the shell dispatches, the view that owns the dialog
 * listens (see CalendarView, ContactsView, FilesView). `.action`
 * carrying no event is how mail says its composer is the app's own store and
 * is called directly.
 *
 * `search` is not one of these: it is mail, filtered, and `currentModule`
 * answers with mail for it so the renderers agree about which module is
 * current while a search is open.
 */
const MODULES: Module[] = [
  {
    id: "mail",
    href: "/mail",
    label: "Mail",
    icon: Mail,
    action: { label: "Compose", icon: PenSquare },
  },
  {
    id: "calendar",
    href: "/calendar",
    label: "Calendar",
    icon: Calendar,
    action: { label: "New event", icon: Plus, event: "ihm:new-event" },
  },
  {
    id: "contacts",
    href: "/contacts",
    label: "Contacts",
    icon: Users,
    action: { label: "New contact", icon: Plus, event: "ihm:new-contact" },
  },
  {
    id: "files",
    href: "/files",
    label: "Files",
    icon: FolderOpen,
    action: { label: "Upload", icon: Upload, event: "ihm:files-upload" },
  },
];

/**
 * The module a location's section belongs to, or `undefined` where there is
 * none — the settings and admin screens are not one of the four.
 *
 * Search is deliberately not a section of its own: it is mail, filtered, so the
 * four renderers agree about which module is current while it is open.
 */
function currentModule(section: string): Module | undefined {
  if (section === "search") return MODULES[0];
  return MODULES.find((m) => m.id === section);
}

/**
 * Whether a message is open in the reading pane, from the url alone.
 *
 * The reading pane is full screen on a phone, so the floating button that
 * writes a new message covers the message it is floating over -- which is not
 * what a thumb is reaching for while reading. Mail and search are the two
 * routes that carry a thread, and they carry it in different segments: mail is
 * `/mail/:mailboxId?/:threadId?` and search is `/search/:threadId?` (see
 * App.tsx). Calendar, contacts and files carry a place, not a message, so
 * nothing is hidden there however deep the url goes.
 */
function readingMessage(section: string, location: string): boolean {
  const parts = location.split("/");
  if (section === "search") return Boolean(parts[2]);
  if (section === "mail") return Boolean(parts[3]);
  return false;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const isMobile = useIsMobile();
  const collapsed = useSettings((s) => s.settings.sidebarCollapsed);
  const sidebarWidth = useSettings((s) => s.settings.sidebarWidth);
  const update = useSettings((s) => s.update);
  /*
   * The width while a drag is in progress, kept here and written to settings
   * once on release -- the same arrangement as the message-list splitter, so a
   * drag is a re-render per frame and not a localStorage write per frame.
   */
  const [liveSidebarWidth, setLiveSidebarWidth] = useState<number | null>(null);
  // The same value, readable in the same tick it was set: a key press resizes
  // and ends in one go, before any render could hand the state back.
  const liveSidebarRef = useRef<number | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const shownSidebarWidth = liveSidebarWidth ?? sidebarWidth;
  const [drawer, setDrawer] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const appInstall = useInstallState();
  const appIsInstalled =
    appInstall.state === "in-app" || appInstall.state === "installed";
  const openCompose = useCompose((s) => s.open);
  const openShare = useCompose((s) => s.openFromShare);
  const pushState = useSession((s) => s.pushState);
  const pushReason = useSession((s) => s.pushReason);
  const pushTitle = pushReason
    ? `${t(PUSH_LABEL[pushState])} — ${pushReason}`
    : t(PUSH_LABEL[pushState]);
  const session = useSession((s) => s.session);
  const logout = useSession((s) => s.logout);
  const appName = useSession((s) => s.session?.gilbert?.appName) || DEFAULT_APP_NAME;
  const acctMenu = useMenu();
  /*
   * "Go to folder" (#233), hosted here rather than in the mail view because
   * the `g` shortcuts are global: pressing it from the calendar should still
   * take you to a folder, and the mail view is not mounted to hear about it.
   */
  const [goFolder, setGoFolder] = useState(false);
  const section = location.split("/")[1] || "mail";
  const mod = currentModule(section);
  /*
   * The action the drawer's compose button offers, and the fab's.
   *
   * The drawer button is on every screen, settings included, so where no module
   * owns the section it falls back to mail's action: a button at the top of an
   * empty pane that starts a message is the one that is always meaningful. The
   * fab is not drawn there at all (see below), being the section's own action.
   */
  const action = mod?.action ?? MODULES[0]!.action;
  const SectionAction = action.icon;
  /*
   * Where the shield takes the reader back to: the section that was open
   * before the last jump into /admin. Remembered on the click that leaves
   * it -- the shield is the way back too, and "back" means "where I was",
   * not a hard-coded section. After a reload inside /admin the memory is
   * gone and the shield falls back to Mail, the home section.
   */
  const adminBackTo = useRef("/mail");

  useGlobalShortcuts({
    onHelp: () => setHelpOpen(true),
    onGoToFolder: () => setGoFolder(true),
  });
  useEffect(() => setDrawer(false), [location]);

  // Escape closes it too, for the tablet with a keyboard attached.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  // Deep link: /mail?compose=new (PWA shortcut) / mailto handler
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("compose") === "new") {
      openCompose();
      navigate("/mail", { replace: true });
    }
    const mailto = params.get("mailto");
    if (mailto) {
      openCompose(draftFromMailto(mailto));
      navigate("/mail", { replace: true });
    }
  }, [openCompose, navigate]);

  /*
   * A share from the operating system, collected rather than read off the URL.
   *
   * The other deep links above arrive as a query the app can read on the spot.
   * A share cannot: it is a POST, the service worker answered it, and what it
   * left behind has to survive the redirect -- and, when nobody was signed in,
   * a trip through the sign-in page as well. So this asks on every start
   * instead of only when `?share=1` says so, and finds nothing almost every
   * time. The `at` stamp is what stops an abandoned one turning up days later.
   *
   * It runs here rather than in `main.tsx` because attaching needs an account:
   * `addFiles` uploads as it goes, and there is nothing to upload to until the
   * session is in place. AppShell only exists once there is one.
   */
  useEffect(() => {
    void collectShare().then(async (share) => {
      if (!share) return;
      if (new URLSearchParams(window.location.search).has("share"))
        navigate("/mail", { replace: true });
      // Asked about first, not opened straight away: see `offerShare`.
      await offerShare(share, openShare);
    });
  }, [openShare, navigate]);

  /*
   * No account switcher.
   *
   * Switching the whole app to somebody else's account is the wrong door to
   * what other people share: Stalwart advertises every capability on a shared
   * account, so mail, calendar and contacts go with it and are refused. Shares
   * are listed where they belong -- in Files and in Contacts, beside the
   * reader's own -- and found without anyone having to know an account switch
   * is involved.
   */

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="icon-btn"
          aria-label={t("Menu")}
          onClick={() =>
            isMobile ? setDrawer((d) => !d) : update({ sidebarCollapsed: !collapsed })
          }
        >
          <MenuIcon size={22} />
        </button>
        <Link href="/mail" className="brand">
          <BrandLogo kind="mark" />
          {/* A product name, not a word: translated it is a different product.
              Read from the session rather than written here, so a deployment
              that set APP_NAME is called what it calls itself -- the document
              title has taken it from there all along. */}
          <span className="brand-name notranslate" translate="no">
            {appName}
          </span>
        </Link>
        {/* The live-updates bead reads as the product's own state, so it sits
            with the name — "Gilbert ●" — and the right cluster is left to
            actions. */}
        <span
          className="push-status"
          role="img"
          aria-label={pushTitle}
          title={pushTitle}
        >
          <span className={`push-dot ${pushState}`} />
        </span>
        <SearchBar />
        <div className="topbar-actions">
          {/* Chat comes first in the action cluster, with the phone entry
              beside it: ADR 0005. Rendered (or not) by the launcher itself. */}
          <ChatLauncher />
          {/* The phone (ADR 0023): its own entry, its own state, and no
              presence at all where the installation or the account has none. */}
          <PhoneLauncher />
          {session?.gilbert?.isAdmin && session?.gilbert?.administration !== false && (
            <button
              type="button"
              className={`icon-btn ${section === "admin" ? "active" : ""}`}
              aria-label={t("Admin")}
              title={t("Admin")}
              aria-current={section === "admin" ? "page" : undefined}
              onClick={() => {
                if (section === "admin") {
                  navigate(adminBackTo.current);
                  return;
                }
                adminBackTo.current = location;
                navigate("/admin");
              }}
            >
              <Shield size={21} />
            </button>
          )}
          {/* `hide-mobile`: the account menu beside it already carries
              Settings, and a phone's bar has no room for both. */}
          <Link
            href="/settings"
            className={`icon-btn hide-mobile ${section === "settings" ? "active" : ""}`}
            aria-label={t("Settings")}
            title={t("Settings")}
          >
            <Settings size={21} />
          </Link>
          <button
            className="icon-btn"
            style={{ width: "auto", padding: "0 2px", borderRadius: 999 }}
            onClick={acctMenu.open}
            aria-label={t("Account")}
          >
            <Avatar
              who={{ name: session?.username, email: session?.username }}
              size="sm"
            />
          </button>
          <Popover
            anchor={acctMenu.anchor}
            onClose={acctMenu.close}
            trigger={acctMenu.trigger}
            align="end"
            width={280}
          >
            <div
              style={{
                padding: "10px 10px 6px",
                display: "flex",
                gap: 10,
                alignItems: "center",
              }}
            >
              <Avatar who={{ name: session?.username, email: session?.username }} />
              <div className="grow">
                <div style={{ fontWeight: 600 }} className="truncate">
                  {session?.username}
                </div>
                <div className="hint truncate notranslate" translate="no">
                  {session?.gilbert?.loginName}
                </div>
              </div>
            </div>
            <MenuSep />
            <MenuItem
              icon={<HelpCircle size={16} />}
              label={t("Help")}
              onClick={() => setHelpOpen(true)}
            />
            <ThemeMenuItem />
            <MenuItem
              icon={<Settings size={16} />}
              label={t("Settings")}
              onClick={() => navigate("/settings")}
            />
            {/*
              The install/update command, on a phone only: a desktop browser
              installs from its address bar, and the account menu there already
              carries Settings. The label follows what is true -- offering to
              install an app that is already installed is the thing this exists
              to avoid.
            */}
            {isMobile && (
              <MenuItem
                icon={appIsInstalled ? <Smartphone size={16} /> : <Download size={16} />}
                label={appIsInstalled ? t("Mobile app") : t("Install mobile app")}
                onClick={() => setInstallOpen(true)}
              />
            )}
            {session?.gilbert?.administrationNeedsOwnDevice && (
              <MenuItem
                icon={<Shield size={16} />}
                disabled
                label={
                  <>
                    <span style={{ display: "block" }}>{t("Administration")}</span>
                    <span
                      className="hint"
                      style={{ display: "block", whiteSpace: "normal" }}
                    >
                      {t(
                        "Only on a device you've marked as your own. Sign in again with \u201cThis is my own device\u201d ticked.",
                      )}
                    </span>
                  </>
                }
              />
            )}
            {/*
              Refresh asks the worker for its script first -- the half a plain
              reload cannot force -- and reloads whether or not the version
              moved: the reader pressed the button, so the page comes back
              fresh, and a client stuck on an old worker lands the new one.
            */}
            <MenuItem
              icon={<RefreshCw size={16} />}
              label={t("Refresh")}
              onClick={() => {
                void applyAppUpdate().then((outcome) => {
                  if (outcome !== "reloading") window.location.reload();
                });
              }}
            />
            <MenuItem
              icon={<LogOut size={16} />}
              label={t("Sign out")}
              onClick={() => void logout()}
            />
          </Popover>
        </div>
      </header>

      {/*
        The install nudge, above the app body so it pushes nothing under the
        top bar. Mobile only, and only while there is something true to say --
        it hides itself once installed and in the installed app (`InstallBanner`).
      */}
      <InstallBanner onOpen={() => setInstallOpen(true)} />

      <div
        className={`app-body ${collapsed && !isMobile ? "collapsed" : ""} ${liveSidebarWidth != null ? "resizing" : ""}`}
        style={
          shownSidebarWidth != null && !isMobile
            ? ({ "--sidebar-w": `${shownSidebarWidth}px` } as CSSProperties)
            : undefined
        }
      >
        <div
          className={`drawer-backdrop ${drawer ? "open" : ""}`}
          onClick={() => setDrawer(false)}
        />
        <aside ref={sidebarRef} className={`sidebar ${drawer ? "open" : ""}`}>
          {/*
            The way back out.

            The drawer covers the top bar -- it has to, being taller than it --
            so the hamburger that opened it is underneath, and pressing the
            same place again did nothing. That left the dimmed strip beside the
            drawer as the only exit, which is not a thing anyone is told about.
            Putting a close where the hamburger was means the second press
            lands on the control that undoes the first, which is where the hand
            is already going. It cannot be done by raising the top bar over the
            drawer instead: the top bar sits under everything that takes the
            screen -- see the stack by `.dialog-backdrop` -- and lifting it
            past the drawer would put it in among the composer and the
            dialogs, which it has no business covering.
          */}
          {isMobile && (
            <div className="drawer-head">
              <button
                className="icon-btn"
                aria-label={t("Close menu")}
                onClick={() => setDrawer(false)}
              >
                <X size={22} />
              </button>
            </div>
          )}
          {/* Whatever this pane is for. In Files it starts an upload rather
              than a message: Compose belongs to mail, not to the file
              manager. */}
          <button
            className="compose-btn"
            onClick={() => {
              const { event } = action;
              if (event) window.dispatchEvent(new CustomEvent(event));
              else openCompose();
            }}
          >
            <SectionAction size={22} />
            <span>{t(action.label)}</span>
          </button>
          <div className="sidebar-scroll">
            {(section === "mail" || section === "search") && <MailboxTree />}
            {/*
              The other sections' sidebars load with the section, the way their
              views already do: each is only drawn under one section, and
              keeping all three in the main chunk is what made a mail-only
              session carry the calendar, contacts and files trees.
            */}
            <Suspense fallback={null}>
              {section === "calendar" && <CalendarSidebar />}
              {section === "contacts" && <ContactsSidebar />}
              {section === "files" && <FilesTree />}
            </Suspense>
            {section === "settings" && (
              <div className="nav-section">
                <span>{t("Settings")}</span>
              </div>
            )}
          </div>
          {(section === "mail" || section === "search") && <QuotaBar />}
          <nav className="module-bar" aria-label={t("Go to")}>
            {MODULES.map((m) => (
              <ModuleLink
                key={m.id}
                href={m.href}
                icon={<m.icon size={20} />}
                label={t(m.label)}
                active={mod?.id === m.id}
              />
            ))}
          </nav>
        </aside>
        {/* Not on a phone, where the sidebar is a drawer over the page, and not
            while collapsed to icons, where there is no width to choose. */}
        {!isMobile && !collapsed && (
          <Splitter
            direction="vertical"
            className="sidebar-splitter"
            ariaLabel={t("Resize sidebar")}
            onResize={(delta) => {
              // From the setting once there is one. Before that it is null and
              // says nothing about a width set in the reader's own CSS, so the
              // first drag starts from what is on screen. Not always from the
              // screen: the width eases, and a second key press lands
              // mid-transition, where the measured width is still the old one.
              const start =
                liveSidebarRef.current ??
                useSettings.getState().settings.sidebarWidth ??
                sidebarRef.current?.getBoundingClientRect().width ??
                SIDEBAR_MIN;
              const max = Math.max(
                SIDEBAR_MIN,
                Math.min(SIDEBAR_MAX, window.innerWidth - 600),
              );
              const next = Math.round(
                Math.min(max, Math.max(SIDEBAR_MIN, start + delta)),
              );
              liveSidebarRef.current = next;
              setLiveSidebarWidth(next);
            }}
            onEnd={() => {
              // Written once, on release: a drag is a re-render per frame and
              // not a settings write per frame. The keyboard path relies on
              // this too, which is why a key press ends the drag it started.
              const width = liveSidebarRef.current;
              if (width != null) update({ sidebarWidth: width });
              liveSidebarRef.current = null;
              setLiveSidebarWidth(null);
            }}
            onReset={() => {
              // Null is "whatever the stylesheet says", which is what a reader
              // who never dragged has -- and what one who has their own CSS
              // for it wants back.
              liveSidebarRef.current = null;
              setLiveSidebarWidth(null);
              update({ sidebarWidth: null });
            }}
          />
        )}
        {/*
          Scoped to the content, not the shell. If Chrome's translator breaks a
          message list, the top bar, the folder tree and any open composer are
          outside this and carry on -- so recovery is a pane blinking rather
          than the app disappearing.
        */}
        <main className="main">
          <TranslateBoundary>{children}</TranslateBoundary>
        </main>
      </div>

      {isMobile && (
        <>
          {/*
            The section's primary action, floating over the list. Hidden while
            a message is open in the reading pane -- see `readingMessage`.
          */}
          {mod && !readingMessage(section, location) && (
            <button
              className="fab"
              aria-label={t(action.label)}
              onClick={() => {
                const { event } = action;
                if (event) window.dispatchEvent(new CustomEvent(event));
                else openCompose();
              }}
            >
              <SectionAction size={24} />
            </button>
          )}
          <nav className="mobile-tabbar" aria-label={t("Sections")}>
            {MODULES.map((m) => (
              <Link
                key={m.id}
                href={m.href}
                className={mod?.id === m.id ? "active" : ""}
                aria-current={mod?.id === m.id ? "page" : undefined}
              >
                <m.icon size={22} />
                {t(m.label)}
              </Link>
            ))}
          </nav>
        </>
      )}
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <InstallAppDialog open={installOpen} onClose={() => setInstallOpen(false)} />
      {goFolder && (
        <MailboxPicker
          title={t("Go to folder…")}
          /* Read, not write: a shared folder you may read but not file into is
             still somewhere worth going. */
          need="mayReadItems"
          onClose={() => setGoFolder(false)}
          onPick={(id) => {
            setGoFolder(false);
            navigate(`/mail/${id}`);
          }}
        />
      )}
    </div>
  );
}

/** Outlook-style module switcher at the bottom of the folder pane. */
function ModuleLink({
  href,
  icon,
  label,
  active,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`module-link ${active ? "active" : ""}`}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      <span className="module-label">{label}</span>
    </Link>
  );
}

function QuotaBar() {
  const accountId = useMail((s) => s.accountId);
  const quotaAccountId = useMail((s) => s.quotaAccountId);
  const quotas = useMail((s) => s.quotas);
  const loadQuota = useMail((s) => s.loadQuota);
  /*
   * The bar is the storage of the account on screen: opening a group mailbox
   * turns it into the group's, and closing it turns it back. The effect is the
   * guarantee — a switch that did not pass through `openAccount`, or a boot that
   * set the account itself, still refills it — and a quota already held for that
   * account answers itself in the store.
   */
  useEffect(() => {
    if (accountId && quotaAccountId !== accountId) void loadQuota();
  }, [accountId, quotaAccountId, loadQuota]);
  const q = accountQuota(quotas);
  if (!q?.hardLimit) return null;
  const pct = Math.min(100, Math.round((q.used / q.hardLimit) * 100));
  return (
    <div
      className="quota"
      title={t("{used} of {total}", {
        used: formatSize(q.used),
        total: formatSize(q.hardLimit),
      })}
    >
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span>
          {t("{used} of {total}", {
            used: formatSize(q.used),
            total: formatSize(q.hardLimit),
          })}
        </span>
        <ChevronsUpDown size={12} style={{ opacity: 0 }} />
      </div>
      <div className="quota-bar">
        <span
          className={pct > 95 ? "danger" : pct > 80 ? "warn" : ""}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Flip to light and back from the account menu.
 *
 * The setting has four values and only two of them are "light", so the item
 * acts on what is actually on screen rather than on the setting: if you can
 * see a dark theme, one press gives you light.
 *
 * Coming back is the part that needs remembering. There is more than one way
 * to be dark — "dark", "gilbert", or "system" while the OS is — so the way
 * back is whichever you were on, kept in `lastDarkTheme`, rather than plain
 * "dark" for everyone. Without that, two presses would quietly move an
 * gilbert user onto a theme they never chose.
 *
 * It lives in the account menu rather than the top bar: a phone's bar has no
 * room to spare, and the account menu is where Settings already sits.
 */
function ThemeMenuItem() {
  const effective = useEffectiveTheme();
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const prefersDark = Boolean(
    window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );
  const next = toggleTarget(
    { palette: settings.palette, mode: settings.mode },
    prefersDark,
  );
  // Name where it is going, and by the palette when the palette is changing --
  // going back to Gilbert's own colours is not the same as "dark mode".
  // The palette is the same in both modes, so the label is only ever the side.
  const label = next.mode === "light" ? t("light mode") : t("dark mode");
  return (
    <MenuItem
      icon={effective === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      label={t("Switch to {theme}", { theme: label })}
      onClick={() => update(next)}
    />
  );
}
