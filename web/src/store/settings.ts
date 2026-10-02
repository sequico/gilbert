import { useEffect, useState } from "react";
import { create } from "zustand";
import {
  type DateFormat,
  setDateTimePrefs,
  setUiLanguageForFormatting,
  type TimeFormat,
} from "@/lib/datetime";
import { loadLanguage } from "@/lib/i18n";
import { resolveUiLanguage } from "@/lib/languages";
import type { SortLevel, SortPreset } from "@/lib/listSort";
import {
  effectiveMode,
  legacyTheme,
  type Mode,
  migrateTheme,
  type PaletteId,
} from "@/lib/palette";
import {
  type PolicyChange,
  policyChanges,
  policyDefaults,
  policyEnforced,
  policyStatus,
} from "@/lib/settingsPolicy";
import { pendingSettingsKeys, queueSettingsPush } from "@/lib/settingsSync";
import { hasCachedJson, isDeviceTrusted, loadJson, saveJson } from "@/lib/storage";
import type { SwipeAction } from "@/lib/swipe";
import { useSession } from "@/store/session";

/**
 * "gilbert" is a dark theme carrying the palette from ihasmail.org. It is a
 * theme rather than an accent because it changes the backgrounds, borders and
 * text as well as the highlight colour — an accent could not.
 */
export type Theme = "system" | "light" | "dark" | "gilbert";
export type Density = "comfortable" | "cozy" | "compact";
export type ReadingPane = "right" | "bottom" | "off";
export type ImagePolicy = "ask" | "always" | "contacts";
export type ComposeFormat = "html" | "text";
export type ReadReceiptPolicy = "ask" | "never";

/** How prominent a label is in the sidebar. */
export type LabelVisibility = "always" | "unread" | "hidden";

export interface Label {
  /** The IMAP keyword itself, which is what actually rides on the message. */
  keyword: string;
  name: string;
  color: string;
  /**
   * The keyword of the label this one sits under, if any.
   *
   * Nesting is display only. The keywords stay flat on the message, which is
   * what keeps them readable by every other client -- a label moved under
   * another one does not rewrite anything in the mailbox.
   */
  parent?: string;
  /** Absent means "always", so a settings file written before this parses unchanged. */
  visibility?: LabelVisibility;
}

/** A calendar subscribed to by URL, read-only and redrawn on every refresh. */
export interface IcalSubscription {
  id: string;
  url: string;
  name: string;
  color: string;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  html: string;
}

/** A signer remembered for an address. See `knownSigners`. */
export interface SignerPin {
  /** SHA-256 of the certificate's DER, lowercase hex. */
  fingerprint: string;
  /** What the certificate called its holder, so a change can be described. */
  name: string;
  /** When this fingerprint was first pinned, ISO 8601. */
  firstSeen: string;
  /**
   * The message that established the pin.
   *
   * Without this, the message that *created* a pin reads as corroborated by it
   * the next time it is opened — "the same signer as before", where before is
   * itself. That is a claim of corroboration from evidence that does not
   * exist, and it appears on the very first signed message somebody receives.
   */
  messageId?: string;
}

export interface Settings {
  /**
   * Kept, and kept correct, for a device still running a build that only knows
   * this field. It cannot express "Gruvbox", but it can express light or dark,
   * which is the half that stops an older device showing a theme nobody chose.
   */
  theme: Theme;
  /** The colours. */
  palette: PaletteId;
  /** Light, dark, or whatever the system says. */
  mode: Mode;
  accent: string;
  density: Density;
  readingPane: ReadingPane;
  conversationMode: boolean;
  showPreview: boolean;
  showAvatars: boolean;
  pageSize: number;
  markReadDelay: number; // seconds; -1 = never auto
  /**
   * Shared calendars and address books the reader has added, as
   * `accountId:collectionId`.
   *
   * JMAP keeps this on the collection itself, in `isSubscribed`, and that is
   * still tried first -- a preference the server holds is one every client
   * sees. But subscribing writes to the *owner's* account, and Stalwart 0.16.19
   * refuses that for an address book shared read-only: "You are not allowed to
   * modify this address book." It accepts the same write on a shared calendar,
   * which is the inconsistency this list exists to paper over.
   *
   * So where the server will not remember, Gilbert does, in the settings that
   * already follow the reader between devices.
   */
  addedShares: string[];

  /**
   * S/MIME signers pinned on first sight, keyed by lowercased address.
   *
   * This is the whole trust model for signature checking, and it is a small
   * one: a browser has no system trust store, and the certificate that signs a
   * message travels inside it, so "this signature verifies" on its own says
   * only that the sender held the key they attached. What makes it worth
   * anything is remembering — the same signer as last time is reassuring, and a
   * different one is worth interrupting somebody over.
   *
   * It lives in the synced settings rather than in this browser because a pin
   * that only one device knows about would greet the same correspondent as new
   * on every other one, which trains people to click past exactly the warning
   * this exists to raise.
   */
  knownSigners: Record<string, SignerPin>;
  imagePolicy: ImagePolicy;
  /** Let messages follow the app's light/dark theme instead of always sitting on white. */
  themeMessageBody: boolean;
  /**
   * Extend that to mail which brings colours of its own.
   *
   * Only meaningful with `themeMessageBody` on. Off by default because it
   * cannot be done perfectly: see `markKeptSurfaces` in lib/html.ts for the
   * bargain it makes, and #290 for why the conservative default alone left
   * essentially all HTML mail on a white card.
   */
  themeStyledMessages: boolean;
  composeFormat: ComposeFormat;
  signatureAboveQuote: boolean;
  includeQuote: boolean;
  requestReadReceipt: boolean;
  /**
   * What to do when a sender asks for a read receipt. There is deliberately no
   * "always": an automatic receipt confirms to whoever asked that the address
   * is live and when it was read, which is exactly what a sender who should
   * not have that is fishing for. RFC 8098 asks that a person decide each one.
   */
  readReceiptPolicy: ReadReceiptPolicy;
  confirmDelete: boolean;
  /**
   * What dragging a message row sideways does, on a touchscreen.
   *
   * Two settings rather than one "swipe actions" toggle because the pair is
   * the choice: which hand-side gets the destructive one is personal, and the
   * usual complaint about swipe gestures is not that they exist but that the
   * app picked the wrong ones. "none" turns a direction off; turning both off
   * turns the gesture off.
   *
   * They follow the account rather than the device: someone who has decided
   * that a left swipe deletes has decided it for their phone and their tablet
   * both, and the setting is meaningless on the desktop that would otherwise
   * be the odd one out.
   */
  swipeRight: SwipeAction;
  swipeLeft: SwipeAction;
  desktopNotifications: boolean;
  notificationSound: boolean;
  attachmentReminder: boolean;
  weekStart: 0 | 1 | 6;
  /** "" = follow the mail server's locale, then the browser's. */
  locale: string;
  /**
   * The language the interface is written in, and what `<html lang>` says.
   *
   * Separate from `locale` above, which is a *formatting* choice — what
   * calendar, clock and numerals to use. They are genuinely different
   * questions: German dates with an English interface is a real preference,
   * and so is the reverse. Folding them together would silently rewrite
   * everybody's date format the first time they picked a language.
   *
   * Absent means English, for a new account and for every existing one whose
   * settings file predates this. The browser's `Accept-Language` is
   * deliberately not consulted as the stored default: a served locale should
   * be something the reader chose, not something guessed on their behalf and
   * then written down as though they had.
   */
  uiLanguage: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  calendarDefaultView: "month" | "week" | "day" | "agenda";
  workDayStart: number;
  workDayEnd: number;
  defaultEventDuration: number; // minutes
  defaultAlertMinutes: number;
  timeZone: string | null; // null = browser
  labelsSidebar: boolean;
  /**
   * Birthdays from the address book, shown as a calendar of their own.
   * Off by default: it is derived data, and a calendar that fills itself with
   * dates nobody put there is a surprise rather than a feature.
   */
  birthdayCalendar: boolean;
  /**
   * Calendars subscribed to by URL. The subscription is the setting; the
   * events themselves are fetched on demand and never stored, so this follows
   * the account the way every other preference does and costs nothing to sync.
   */
  icalSubscriptions: IcalSubscription[];
  /** What order the message list is in. See lib/listSort.ts. */
  listSortPreset: SortPreset;
  listSortLevels: SortLevel[];
  /**
   * Which folders it covers. Inbox-only is the useful default rather than a
   * timid one: unread-first is what people want where they triage, and
   * confusing in Sent, where everything is read.
   */
  listSortScope: "inbox" | "all";
  fontSize: "small" | "medium" | "large";
  templates: Template[];
  labels: Label[];
  /**
   * Folder colours, by mailbox id.
   *
   * The ids are mailboxes of the reader's own account, so this follows the
   * account like the rest of the settings -- a colour picked on the desktop is
   * there on the laptop -- rather than staying on the machine it was chosen on.
   * JMAP has nowhere on a Mailbox to keep one, which is why it is here at all.
   */
  folderColors: Record<string, string>;
  sidebarCollapsed: boolean;
  showHiddenFolders: boolean;
  trustedImageSenders: string[];
  /**
   * The three warnings, each off until switched on. A client that starts by
   * interrupting is one people learn to click through, and a warning clicked
   * through without reading costs the same attention and buys nothing.
   */
  externalSenderBanner: boolean;
  externalRecipientConfirm: boolean;
  /**
   * Domains that count as inside, *in addition to* the account's own identity
   * domains, which are always internal and are not configuration.
   */
  internalDomains: string[];
  /** People on a message before sending asks. 0 is off. */
  replyAllThreshold: number;
  externalLinkWarning: boolean;
  trustedLinkDomains: string[];
  archiveOnReply: boolean;
  autoAdvance: "newer" | "older" | "list";
  spellcheck: boolean;
  sendAndArchive: boolean;
  /** Width (px) of the message list when the reading pane is on the right. */
  listPaneWidth: number;
  /** Width (px) of the contact list, beside the contact on show. */
  contactsListWidth: number;
  /**
   * Width (px) of the sidebar, dragged by its edge. Null until someone drags
   * it, and null again after a double-click resets it — which leaves the width
   * to the stylesheet's `--sidebar-w`, so a reader who already widens the
   * sidebar with their own CSS keeps what they had until they choose
   * otherwise.
   */
  sidebarWidth: number | null;
  /** Height (px) of the message list when the reading pane is below. */
  listPaneHeight: number;
  /** Outlook-style colour categories for calendar events. */
  eventCategories: Array<{ name: string; color: string }>;
  /** Default sending identity per account (JMAP has no such flag). */
  defaultIdentityByAccount: Record<string, string>;
  /**
   * Identities kept out of the compose picker, by id.
   *
   * An account with alias domains can have every address twice over while only
   * a handful are ever sent from, which makes the picker useless (#73). This
   * hides them from the picker only — the identity still exists on the server,
   * still receives, and is still listed and editable in Settings, exactly as an
   * unsubscribed folder still exists.
   *
   * A flat list rather than keyed by account: identity ids are unique, and an
   * id belonging to another account simply never matches.
   */
  hiddenIdentities: string[];
  /**
   * Installation policy changes this account has already had applied.
   *
   * The third power in #207: an admin turns a setting on for everybody who is
   * already here, and readers may still turn it back off afterwards. That only
   * works if "already applied" is remembered, or the next sign-in would undo
   * their decision again and the setting would be enforcement wearing a
   * different hat.
   *
   * Ids, not a high-water mark. The reporter's analogy is a schema migration,
   * where each change carries its own version, and remembering the set rather
   * than the maximum is what lets an admin add a change dated earlier than one
   * already applied without it being silently skipped.
   *
   * Synced with the rest, so it is per account and not per browser: signing in
   * on a phone must not apply everything a second time.
   */
  appliedPolicyChanges: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  /**
   * gilbert's own palette is what a new account gets, so the app looks like
   * itself before anyone has chosen anything. It is only a default: a stored
   * theme always wins, so nobody who has picked one — including everyone
   * already using Gilbert, whose choice is saved even if they never changed
   * it — is moved off it.
   */
  theme: "gilbert",
  palette: "gilbert",
  mode: "dark",
  accent: "teal",
  density: "cozy",
  readingPane: "off",
  conversationMode: true,
  showPreview: true,
  showAvatars: true,
  pageSize: 50,
  markReadDelay: 0,
  addedShares: [],
  knownSigners: {},
  imagePolicy: "always",
  themeMessageBody: false,
  themeStyledMessages: false,
  composeFormat: "html",
  signatureAboveQuote: true,
  includeQuote: true,
  requestReadReceipt: false,
  readReceiptPolicy: "ask",
  confirmDelete: false,
  /*
   * Right archives and left deletes, which is what the mail apps a phone came
   * with already do. A default nobody has to learn beats a better one they do.
   */
  swipeRight: "archive",
  swipeLeft: "delete",
  desktopNotifications: true,
  notificationSound: true,
  attachmentReminder: true,
  weekStart: 1,
  locale: "",
  uiLanguage: "en",
  dateFormat: "auto",
  timeFormat: "auto",
  calendarDefaultView: "week",
  workDayStart: 8,
  workDayEnd: 18,
  defaultEventDuration: 60,
  defaultAlertMinutes: 10,
  timeZone: null,
  labelsSidebar: true,
  birthdayCalendar: false,
  icalSubscriptions: [],
  listSortPreset: "newest",
  listSortLevels: [],
  listSortScope: "inbox",
  fontSize: "medium",
  templates: [],
  labels: [],
  folderColors: {},
  sidebarCollapsed: false,
  showHiddenFolders: false,
  trustedImageSenders: [],
  externalSenderBanner: false,
  externalRecipientConfirm: false,
  internalDomains: [],
  replyAllThreshold: 0,
  externalLinkWarning: false,
  trustedLinkDomains: [],
  archiveOnReply: false,
  autoAdvance: "list",
  spellcheck: true,
  sendAndArchive: false,
  listPaneWidth: 520,
  contactsListWidth: 320,
  sidebarWidth: null,
  listPaneHeight: 340,
  eventCategories: [
    { name: "Important", color: "#dc2626" },
    { name: "Work", color: "#2563eb" },
    { name: "Personal", color: "#16a34a" },
    { name: "Travel", color: "#ea580c" },
    { name: "Family", color: "#9333ea" },
  ],
  defaultIdentityByAccount: {},
  hiddenIdentities: [],
  appliedPolicyChanges: [],
};

/**
 * Settings that describe *this screen or this browser*, and so stay in
 * localStorage: a list-pane width picked on a 27" monitor is wrong on a
 * laptop, and the notification toggles track a permission the browser grants
 * per-device, so syncing them would claim something untrue elsewhere.
 *
 * Everything else follows the account (issue #54). The list is written as the
 * exceptions rather than the rule so that a setting added later syncs by
 * default, which is what someone adding one almost always wants.
 */
export const DEVICE_KEYS: ReadonlySet<keyof Settings> = new Set<keyof Settings>([
  "density",
  "fontSize",
  "sidebarCollapsed",
  "desktopNotifications",
  "notificationSound",
  "listPaneWidth",
  "contactsListWidth",
  "sidebarWidth",
  "listPaneHeight",
]);

/** The part of the settings that is written to the account's settings file. */
export function syncedPart(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(s) as Array<keyof Settings>) {
    if (!DEVICE_KEYS.has(key)) out[key] = s[key];
  }
  return out;
}

/**
 * What of a settings file we are willing to apply: known keys only, and never
 * a device one — an older Gilbert wrote the whole object up, and that file
 * should not now drag another machine's pane width across.
 */
export function acceptRemote(remote: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(remote)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    if (DEVICE_KEYS.has(key as keyof Settings)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return migratedThemeFields(out) as Partial<Settings>;
}

/**
 * A settings file written before palettes existed carries `theme` and neither
 * `palette` nor `mode`, so it is read through the old enum. Settings live in
 * the account's own Files and are opened by whatever version happens to run
 * next, so this is not a one-release migration -- it has to keep working. An
 * imported file is the same shape of thing, and is read through it too.
 *
 * Only when the new fields are absent: a file that has both is newer, and its
 * `theme` is the derived copy rather than the choice. Nothing is dropped, so a
 * caller that trusts its input (`importJson`) still hands every unknown key on.
 */
function migratedThemeFields(source: Record<string, unknown>): Record<string, unknown> {
  if (!source || typeof source !== "object") return source;
  if (
    source.palette === undefined &&
    source.mode === undefined &&
    typeof source.theme === "string"
  ) {
    const migrated = migrateTheme(source.theme);
    return { ...source, palette: migrated.palette, mode: migrated.mode };
  }
  return source;
}

/**
 * The settings file laid over the ones in hand, minus anything still queued.
 *
 * A change that has not been written up yet is newer than the file by
 * definition, so it wins. Picking a language is where this showed: that
 * remounts the tree, the remount re-reads the file, and the file still holds
 * the language from before the click, so the click comes undone. The symptom
 * reads as "sometimes it takes several clicks": the click that sticks is the
 * one made after the previous write has landed.
 */
export function mergeRemote(
  current: Settings,
  remote: Record<string, unknown>,
  held: ReadonlySet<string> = new Set(),
): Settings {
  const incoming = acceptRemote(remote);
  for (const key of held) delete incoming[key as keyof Settings];
  return { ...current, ...incoming };
}

/**
 * Why the door refused a patch: the installation's policy has not been read.
 *
 * A code rather than a sentence, because the sentence belongs where codes are
 * turned into the reader's language, and named once here, beside the only place
 * that refuses, so that catalogue can be keyed by it instead of every caller
 * carrying its own copy of the string.
 */
export const SETTINGS_POLICY_UNKNOWN = "policy_unknown";

/** What the door answers: `null` when the patch went through, or why it did not. */
export type SettingsWriteRefusal = typeof SETTINGS_POLICY_UNKNOWN;

interface SettingsState {
  settings: Settings;
  /**
   * Change the settings, whichever route asks.
   *
   * Answers `null` when the patch is applied, and a refusal code when it is
   * not, so a caller can say why nothing moved. A policy nobody could read is
   * not a policy that enforces nothing, and the patch is refused rather than
   * applied as though the installation had decided nothing.
   */
  update(patch: Partial<Settings>): SettingsWriteRefusal | null;
  reset(): void;
  /**
   * Drop what is in hand, without writing anything.
   *
   * Not `reset`: reset is the reader asking for the installation's starting
   * point, and it writes that to the account. This is the session ending, and
   * there is nobody left to write for -- the copy the app is holding is the one
   * `clearSignedInData` cannot reach, so it is dropped here instead of at the
   * next sign-in, where it would paint the previous reader's pins, trusted
   * senders, internal domains and language over the new account's first frames.
   * Driven by the session store; see the subscription at the foot of this file.
   */
  discard(): void;
  exportJson(): string;
  importJson(json: string): boolean;
  /** Apply the account's settings file over the cached ones. */
  hydrate(remote: Record<string, unknown>): void;
  /**
   * Seed an account that has never had settings of its own.
   *
   * Only for that case, which is why it is not `update`: these are a starting
   * point the reader may change, so applying them to somebody who already has
   * settings would be overwriting choices rather than defaulting them.
   */
  seedFromPolicy(): void;
  /**
   * Apply the installation's change list, each entry once.
   *
   * Returns the changes that were applied, so the caller can say what moved --
   * a setting changing under somebody without a word is the part of this the
   * reporter was uneasy about, and rightly.
   */
  applyPolicyChanges(): PolicyChange[];
}

/**
 * The settings this device painted from before the account's own arrived.
 *
 * The cache is a copy of a file, so it is read through the same schema the file
 * is: a key this build no longer has is not a setting, and leaving one in the
 * object would push it back into the file on the next write -- a key the schema
 * dropped, kept alive by the one reader that did not ask it.
 */
const initialSettings = {
  ...DEFAULT_SETTINGS,
  ...knownSettings(loadJson<Record<string, unknown>>("settings", {})),
};

/** The keys of `DEFAULT_SETTINGS`, and nothing else: the schema is that list. */
function knownSettings(raw: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw))
    if (key in DEFAULT_SETTINGS && value !== undefined) out[key] = value;
  return migratedThemeFields(out) as Partial<Settings>;
}

/**
 * The settings with `theme` brought back into line.
 *
 * `theme` is derived, never chosen: whatever set the palette or the mode -- the
 * toggle, Appearance, an imported file, a reset -- the legacy field is written
 * from the two that replaced it here, rather than at the call sites, so a
 * fourth way to change the theme cannot forget to update it and leave a device
 * on an older build showing a theme nobody picked.
 */
function deriveTheme(s: Settings): Settings {
  const prefersDark = Boolean(
    window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );
  return {
    ...s,
    theme: legacyTheme({ palette: s.palette, mode: s.mode }, prefersDark),
  };
}

/**
 * The account whose settings are in hand, or null while they are only the
 * defaults.
 *
 * A cache is one *account's* settings, so the question is whose it is rather
 * than whether there is one. A constant computed once at module load answers
 * yes after a sign-out and a second sign-in in the same tab, and the
 * authenticated tree then paints the first reader's
 * copy -- their pinned signers, trusted senders, internal domains, language --
 * and an `update` in that window could have pushed the whole of it into the
 * new account's settings file. `discard` clears this at the end of a session,
 * and `hydrate` claims it for the account whose file just landed.
 *
 * False on any untrusted device, where the cache is never read: in that state
 * `uiLanguage` starts as English and only becomes the account's choice once
 * the settings file lands, which is why the authenticated tree waits for it.
 */
let inHandFor: string | null = null;

/** Whether the settings in hand are this account's, or merely the defaults. */
export function settingsInHandFor(accountId: string | null | undefined): boolean {
  return Boolean(accountId) && inHandFor === accountId;
}

applyDateTimePrefs(initialSettings);

export const useSettings = create<SettingsState>((set, get) => ({
  settings: initialSettings,
  update(patch) {
    /*
     * A policy nobody could read is not a policy that enforces nothing, and
     * `policyEnforced()` cannot tell them apart: it answers `{}` for both, so a
     * 401 or a 5xx on `/api/account/policy` -- the endpoint is the signed-in
     * account's own copy, ADR 0001 -- lets a whole page load apply every patch
     * as though the installation had decided nothing, silently, with the
     * administrator's setting neither applied nor locked and nothing on screen
     * saying so. So the door asks what is known first, and with nothing known
     * it refuses: the patch is not merged, not cached and not queued, and the
     * caller is handed the code that says why.
     */
    if (policyStatus() === "unavailable") return SETTINGS_POLICY_UNKNOWN;
    /*
     * Enforcement lives here rather than only on the controls. The controls are
     * disabled and say why, which is the part a reader sees -- but a setting
     * the installation has decided must not be changeable through an imported
     * settings file, a keyboard shortcut, or a control somebody adds later and
     * forgets to check. There is one door, so the lock is on it. Issue #207.
     */
    const settings = deriveTheme({
      ...get().settings,
      ...patch,
      ...policyEnforced(),
    });
    saveJson("settings", settings);
    set({ settings });
    applyTheme(settings);
    applyDateTimePrefs(settings);
    applyLang(settings);
    // Dragging a splitter changes a device key on every frame and must not put
    // a request in the air; anything else is queued and coalesced.
    if (Object.keys(patch).some((k) => !DEVICE_KEYS.has(k as keyof Settings))) {
      queueSettingsPush(syncedPart(settings));
    }
    return null;
  },
  seedFromPolicy() {
    const defaults = policyDefaults();
    const enforced = policyEnforced();
    // `update()` already merges `policyEnforced()` after the patch, so an
    // empty `defaults` is harmless to pass through it — but returning here
    // before ever calling `update()` skips that merge entirely. An
    // installation with `enforced` settings and no `defaults` (a completely
    // ordinary configuration — "force imagePolicy: block" needs no default)
    // would otherwise leave every first-run account, and every account on a
    // deployment with no Files capability, with an admin-mandated setting
    // never actually applied for the session.
    if (!Object.keys(defaults).length && !Object.keys(enforced).length) return;
    get().update(defaults);
  },
  /*
   * The third power in #207, and the only one that remembers anything.
   *
   * A change is applied when this account has not already had it, whatever the
   * setting currently says: the point is to reach everybody who is already
   * here, so somebody who had turned it off before the admin decided does get
   * it turned back on. That is intended and the reporter has confirmed it --
   * the difference from `enforced` is that they may turn it off again
   * afterwards and it will stay off, because the version is remembered.
   *
   * Ids rather than a high-water mark, so a change dated earlier than one
   * already applied is not silently skipped.
   *
   * One `update` for the lot, not one per change: each would push a settings
   * file, and a policy with four changes on a first sign-in would write four.
   */
  applyPolicyChanges() {
    const seen = new Set(get().settings.appliedPolicyChanges ?? []);
    const pending = policyChanges().filter((c) => !seen.has(c.version));
    if (!pending.length) return [];
    let patch: Partial<Settings> = {};
    for (const c of pending) patch = { ...patch, ...c.settings };
    const refusal = get().update({
      ...patch,
      appliedPolicyChanges: [...seen, ...pending.map((c) => c.version)],
    });
    /* A refused write applied nothing, and the caller tells the reader which
       settings moved: naming one that did not happen is the same lie in the
       other direction. */
    return refusal ? [] : pending;
  },
  reset() {
    /* Back to how this installation starts an account, not to how Gilbert
       starts one: resetting must not be a way around a policy, and the defaults
       an admin chose are the honest meaning of "reset" where there are any.
       Through the same derivation every other way of changing a setting uses:
       a policy may choose a palette or a mode, and the legacy `theme` an older
       device reads has to be told about it here as much as anywhere. */
    const base = deriveTheme({
      ...DEFAULT_SETTINGS,
      ...policyDefaults(),
      ...policyEnforced(),
    });
    saveJson("settings", base);
    set({ settings: base });
    applyTheme(base);
    applyDateTimePrefs(base);
    applyLang(base);
    queueSettingsPush(syncedPart(base));
  },
  /*
   * The defaults, and nothing written: a session ending is not a change anybody
   * asked to keep, and a copy left in the cache would be claimed by the next
   * sign-in. `clearSignedInData` has already dropped the stored copy by the
   * time this runs, and on a device we do not trust `saveJson` writes nothing
   * at all, so there is nothing to leave behind either way.
   */
  discard() {
    inHandFor = null;
    const settings = { ...DEFAULT_SETTINGS };
    set({ settings });
    applyTheme(settings);
    applyDateTimePrefs(settings);
    applyLang(settings);
  },
  exportJson() {
    return JSON.stringify(get().settings, null, 2);
  },
  importJson(json) {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      /*
       * Read through the same migration an account's own file gets. An export
       * from before palettes carries `theme` alone, and handing that to `update`
       * unchanged makes the import report success while changing nothing: `update`
       * derives `theme` from `palette` and `mode`, so the imported legacy field
       * was written back over by the palette it did not carry. Unknown keys are
       * still handed on -- an import is the reader's own file, and the
       * known-keys-only rule is `acceptRemote`'s, for files off the server.
       */
      get().update(migratedThemeFields(parsed) as Partial<Settings>);
      return true;
    } catch {
      return false;
    }
  },
  hydrate(remote) {
    /* Enforced values win over what the account's own file says: a policy that
       an older sign-in has already written past would otherwise stay written
       past for ever. */
    const settings = {
      ...mergeRemote(get().settings, remote, pendingSettingsKeys()),
      ...policyEnforced(),
    };
    // Cache it, so the next first frame on this browser is already right.
    saveJson("settings", settings);
    set({ settings });
    applyTheme(settings);
    applyDateTimePrefs(settings);
    applyLang(settings);
    /* This account's own settings are in hand now, so a remount -- picking a
       language throws the authenticated subtree away and builds it again --
       may paint with them rather than waiting for the file a second time. */
    inHandFor = useSession.getState().accountId ?? null;
  },
}));

function applyDateTimePrefs(s: Settings): void {
  // The interface language feeds the automatic locale, so month and weekday
  // names follow the language somebody chose rather than staying English.
  setUiLanguageForFormatting(resolveUiLanguage(s.uiLanguage));
  setDateTimePrefs({
    locale: s.locale,
    dateFormat: s.dateFormat,
    timeFormat: s.timeFormat,
  });
}

/**
 * Put the served language on `<html lang>`.
 *
 * Chrome offers to translate when the language it detects does not match the
 * one the page declares, so a `lang` that is briefly wrong is enough to raise
 * the prompt on a page that was already correct — and accepting that prompt is
 * what rewrites the DOM under React and crashes the component tree
 * (facebook/react#11538).
 *
 * So this is not done in an effect after mount. It runs where `applyTheme`
 * runs: at module load, from the localStorage cache, before `createRoot()` has
 * rendered anything and therefore before first paint. `index.html` ships
 * `lang="en"` statically, so the very first bytes are already right for the
 * default and this only ever corrects a reader who chose otherwise.
 *
 * There is no server-rendered alternative to reach for. Gilbert serves a
 * static shell and keeps no account state; the settings file lives in the
 * reader's own JMAP Files on the mail server, so the only way to read it
 * before the page existed would be to authenticate to Stalwart on every page
 * load, which is the thing the whole design avoids.
 */
export function applyLang(s: Settings = useSettings.getState().settings): void {
  const tag = resolveUiLanguage(s.uiLanguage);
  document.documentElement.lang = tag;
  /*
   * The catalogue is fetched, so it lands a beat after the attribute. That
   * order is deliberate: `lang` is what stops Chrome offering to translate,
   * and it should not wait on a network request to say something it already
   * knows. English needs no fetch at all and resolves immediately.
   */
  void loadLanguage(tag);
}

/** Background of each theme, for the browser chrome (`theme-color`). */
const THEME_COLOR = { light: "#ffffff", dark: "#0b1220", gilbert: "#0d2430" } as const;

export function applyTheme(s: Settings = useSettings.getState().settings): void {
  const root = document.documentElement;
  const prefersDark = Boolean(
    window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );
  const mode = effectiveMode(s.mode, prefersDark);
  /*
   * Two attributes, because they answer two questions. `data-theme` is the
   * mode, and every dark-only rule in the stylesheet keys off it without
   * knowing any palette exists; `data-palette` layers the colours on top. The
   * accent variants out-specify both, which is what lets an accent still apply
   * over any palette.
   */
  root.dataset.theme = mode;
  if (s.palette && s.palette !== "default") root.dataset.palette = s.palette;
  else delete root.dataset.palette;
  root.dataset.density = s.density;
  root.dataset.accent = s.accent;
  root.dataset.fontsize = s.fontSize;
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]:not([media])',
  );
  if (meta) meta.content = paletteThemeColor(s.palette, mode);
}

/**
 * The browser chrome colour, read from the palette's own background so it does
 * not have to be listed twice and cannot drift from it.
 */
function paletteThemeColor(_palette: PaletteId, mode: "light" | "dark"): string {
  if (typeof getComputedStyle === "function") {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue("--bg")
      .trim();
    if (value) return value;
  }
  return mode === "dark" ? THEME_COLOR.dark : THEME_COLOR.light;
}

/** Whether a theme paints dark, resolving "system" against the OS. */
export function isDarkTheme(theme: Theme, prefersDark = false): boolean {
  return theme === "dark" || theme === "gilbert" || (theme === "system" && prefersDark);
}

/*
 * Whose settings are in hand, answered again when a session starts or ends.
 *
 * A sign-out, a 401 and a sign-in on a device that is not ours all end with
 * nothing of the last reader's. `clearSignedInData`/`clearAllData` drop the
 * stored copy, but by then the copy the app is holding is this one, not
 * storage's -- so the reset has to happen here as well. Calendar, files
 * and contacts clear themselves the same way, for the same reason.
 *
 * The other direction is the cache. A settings file is read over the network,
 * so the frame before it lands is painted from localStorage, and a cache that
 * survived to a sign-in is this account's own: every sign-out, 401 and
 * untrusted sign-in clears it first. Without one there is nothing to paint and
 * `settingsInHandFor` stays false, which is what makes the authenticated tree
 * wait rather than show English to somebody who chose otherwise. (A cache left
 * by a tab closed mid-session is not attributable to an account, since
 * localStorage gives it no label; the account's own file still corrects that
 * frame.)
 *
 * A session that merely changes -- a refresh, a push-state change -- is neither
 * of those events and is left alone on purpose: on an untrusted device a
 * refresh must not throw away the settings that account's own file just gave
 * us.
 */
useSession.subscribe((s, prev) => {
  if (s.status !== "authenticated") {
    /* Ends the session from a state that had one; a boot that never got one has
       nothing of anybody's to drop, and the cache is still worth its frame. */
    if (prev.status === "authenticated") useSettings.getState().discard();
    return;
  }
  if (prev.status === "authenticated") return;
  if (isDeviceTrusted()) {
    if (inHandFor === null && hasCachedJson("settings")) inHandFor = s.accountId;
    return;
  }
  useSettings.getState().discard();
});

if (typeof window !== "undefined") {
  applyTheme();
  // Before `createRoot().render()` in main.tsx, which imports this module on
  // the way in -- so the language is declared before React has produced a
  // single node, let alone painted one.
  applyLang();
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener("change", () => applyTheme());
}

/**
 * The theme actually on screen, which is not the same as the setting: "system"
 * resolves to whatever the OS is doing right now, and follows it as it changes.
 */
export function useEffectiveTheme(): "light" | "dark" {
  const mode = useSettings((s) => s.settings.mode);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return effectiveMode(mode, systemDark);
}

export const settings = () => useSettings.getState().settings;

/**
 * Primitive that changes whenever a date/time preference does, so memoised
 * components that render dates re-render when the format is switched.
 */
export const dateTimeKey = (s: Settings): string =>
  `${s.locale}|${s.dateFormat}|${s.timeFormat}`;
