import { DEFAULT_IDENTITY_KEY } from "@gilbert/shared/settingsDocument";
import { t } from "@/lib/i18n";
import { DEFAULT_SETTINGS } from "@/store/settings";

/**
 * The Settings-key table shown under "Settings keys" in the policy editor.
 *
 * One row per key this build knows, grouped by category: the key name, what
 * it does (English source, rendered through `t()` like every other catalogue
 * key), and the minimal JSON value that activates it — the fragment to put
 * under `defaults`, under `enforced`, or inside a `change`'s `settings`.
 *
 * The data below is written from the doc comments on the `Settings`
 * interface in `web/src/store/settings.ts`: `GROUPS` names the keys each
 * category holds and `ENTRIES` says what each one does, kept in step by hand.
 * What is *checked* is that hand work: `settingsKeyTable.test.ts` fails when a
 * key a group names has no entry, or when an entry names a key this build does
 * not have. Keys that upstream adds later have no entry yet and fall back to a
 * generic row rather than vanishing.
 */

type Example = string | number | boolean | null | string[] | Record<string, never>;

export interface KeyEntry {
  /** English source; rendered through t(). */
  desc: string;
  example: Example;
}

export const ENTRIES: Record<string, KeyEntry> = {
  theme: {
    desc: t("The theme this build knows: system, light, dark, or Gilbert's own."),
    example: "gilbert",
  },
  palette: {
    desc: t("The colour palette (Gilbert's own or one of the shipped ones)."),
    example: "gilbert",
  },
  mode: { desc: t("Light, dark, or whatever the system says."), example: "system" },
  accent: {
    desc: t("The accent colour that sits on top of any palette."),
    example: "#5b8def",
  },
  density: {
    desc: t("How much fits on screen: comfortable, cozy or compact."),
    example: "cozy",
  },
  fontSize: {
    desc: t("Interface text size: small, medium or large (device-local)."),
    example: "medium",
  },
  readingPane: {
    desc: t("Where the reading pane sits: right, bottom, or off."),
    example: "right",
  },
  listPaneWidth: {
    desc: t("Message-list width with the pane on the right (px, device-local)."),
    example: 320,
  },
  listPaneHeight: {
    desc: t("Message-list height with the pane below (px, device-local)."),
    example: 260,
  },
  sidebarCollapsed: {
    desc: t("Whether the sidebar is collapsed (device-local)."),
    example: false,
  },
  showHiddenFolders: {
    desc: t("Show hidden folders in Files (the gilbert app folder and more)."),
    example: false,
  },
  themeMessageBody: {
    desc: t("Let messages follow the app's theme instead of white."),
    example: true,
  },

  conversationMode: { desc: t("Thread messages into conversations."), example: true },
  showPreview: {
    desc: t("Show a preview line under the subject in the list."),
    example: true,
  },
  showAvatars: { desc: t("Show avatars in the message list."), example: true },
  pageSize: { desc: t("Messages per page in the list."), example: 50 },
  markReadDelay: {
    desc: t("Seconds before an opened message counts as read; -1 never auto."),
    example: 3,
  },
  autoAdvance: {
    desc: t("Where the list moves after acting: newer, older, or back to the list."),
    example: "newer",
  },
  archiveOnReply: {
    desc: t("Archive the original when replying to it."),
    example: false,
  },
  listSortPreset: {
    desc: t("Message-list order: newest, oldest, unread or starred first."),
    example: "unreadFirst",
  },
  listSortLevels: { desc: t("Secondary sort levels under the preset."), example: [] },
  listSortScope: {
    desc: t("Which folders the sort covers: inbox only, or all."),
    example: "inbox",
  },
  swipeLeft: { desc: t("What a left swipe does in the list."), example: "archive" },
  swipeRight: { desc: t("What a right swipe does in the list."), example: "archive" },

  composeFormat: { desc: t("Compose in HTML or plain text."), example: "html" },
  includeQuote: { desc: t("Quote the original message when replying."), example: true },
  signatureAboveQuote: {
    desc: t("Put the signature above the quoted text."),
    example: false,
  },
  sendAndArchive: { desc: t("Send and archive in one action."), example: false },
  spellcheck: { desc: t("Spellcheck the composer."), example: true },
  templates: { desc: t("Compose templates the account saved."), example: [] },

  imagePolicy: {
    desc: t("Remote images: ask, always load, or only from contacts."),
    example: "always",
  },
  trustedImageSenders: {
    desc: t("Senders whose remote images load without asking."),
    example: [],
  },
  knownSigners: {
    desc: t("S/MIME signers pinned per address (fingerprint → name)."),
    example: {},
  },
  requestReadReceipt: { desc: t("Ask senders for a read receipt."), example: false },
  readReceiptPolicy: {
    desc: t("When a receipt is asked for: ask each time, or never."),
    example: "ask",
  },
  confirmDelete: { desc: t("Ask before deleting."), example: true },
  attachmentReminder: {
    desc: t("Warn when a message mentions an attachment but has none."),
    example: true,
  },
  externalSenderBanner: {
    desc: t("Banner when a sender is outside the account's domains."),
    example: true,
  },
  externalRecipientConfirm: {
    desc: t("Confirm when a recipient is outside the account's domains."),
    example: true,
  },
  externalLinkWarning: {
    desc: t("Warn before opening links to outside domains."),
    example: true,
  },
  internalDomains: {
    desc: t("Domains counted as internal, on top of the account's own."),
    example: ["example.com"],
  },
  trustedLinkDomains: {
    desc: t("Outside domains whose links open without warning."),
    example: [],
  },
  replyAllThreshold: {
    desc: t("People on a message before Reply-all asks; 0 is off."),
    example: 3,
  },

  desktopNotifications: {
    desc: t("Desktop notifications for new mail (device-local)."),
    example: true,
  },
  notificationSound: {
    desc: t("Play a sound for new mail (device-local)."),
    example: true,
  },

  calendarDefaultView: {
    desc: t("The calendar view a new open starts on."),
    example: "week",
  },
  workDayStart: { desc: t("Hour the working day starts (calendar grid)."), example: 9 },
  workDayEnd: { desc: t("Hour the working day ends (calendar grid)."), example: 17 },
  defaultEventDuration: { desc: t("Default event length, in minutes."), example: 30 },
  defaultAlertMinutes: { desc: t("Default reminder lead, in minutes."), example: 10 },
  weekStart: {
    desc: t("First day of the week: 0 Sunday, 1 Monday, 6 Saturday."),
    example: 1,
  },
  timeZone: {
    desc: t("The calendar time zone; null means the browser's."),
    example: "Europe/Rome",
  },
  birthdayCalendar: {
    desc: t("Show a calendar of birthdays from the address book."),
    example: true,
  },
  icalSubscriptions: { desc: t("Calendars subscribed to by URL."), example: [] },
  eventCategories: {
    desc: t("Outlook-style colour categories for calendar events."),
    example: [],
  },

  locale: {
    desc: t("The mail-server locale; empty means follow the server."),
    example: "",
  },
  uiLanguage: { desc: t("The interface language; empty means English."), example: "it" },
  dateFormat: {
    desc: t("How dates are written; auto follows the locale."),
    example: "auto",
  },
  timeFormat: {
    desc: t("12- or 24-hour clock; auto follows the locale."),
    example: "auto",
  },

  labels: { desc: t("The account's labels."), example: [] },
  labelsSidebar: { desc: t("Show labels in the sidebar."), example: true },
  folderColors: { desc: t("Folder colours by mailbox id (device-local)."), example: {} },
  hiddenIdentities: {
    desc: t("Identities hidden from the compose picker."),
    example: [],
  },
  defaultIdentityByAccount: {
    desc: t("Default sending identity per account."),
    example: {},
  },
  addedShares: {
    desc: t("Address books whose shared writes the reader remembered."),
    example: [],
  },
};

/** Category → keys, in display order. A key belongs to exactly one category. */
export const GROUPS: Array<{ title: string; keys: string[] }> = [
  {
    title: t("Appearance and layout"),
    keys: [
      "theme",
      "palette",
      "mode",
      "accent",
      "density",
      "fontSize",
      "readingPane",
      "listPaneWidth",
      "listPaneHeight",
      "sidebarCollapsed",
      "showHiddenFolders",
      "themeMessageBody",
    ],
  },
  {
    title: t("Message list"),
    keys: [
      "conversationMode",
      "showPreview",
      "showAvatars",
      "pageSize",
      "markReadDelay",
      "autoAdvance",
      "archiveOnReply",
      "listSortPreset",
      "listSortLevels",
      "listSortScope",
      "swipeLeft",
      "swipeRight",
    ],
  },
  {
    title: t("Composing and sending"),
    keys: [
      "composeFormat",
      "includeQuote",
      "signatureAboveQuote",
      "sendAndArchive",
      "spellcheck",
      "templates",
    ],
  },
  {
    title: t("Security and privacy"),
    keys: [
      "imagePolicy",
      "trustedImageSenders",
      "knownSigners",
      "requestReadReceipt",
      "readReceiptPolicy",
      "confirmDelete",
      "attachmentReminder",
      "externalSenderBanner",
      "externalRecipientConfirm",
      "externalLinkWarning",
      "internalDomains",
      "trustedLinkDomains",
      "replyAllThreshold",
    ],
  },
  {
    title: t("Notifications"),
    keys: ["desktopNotifications", "notificationSound"],
  },
  {
    title: t("Calendar and events"),
    keys: [
      "calendarDefaultView",
      "workDayStart",
      "workDayEnd",
      "defaultEventDuration",
      "defaultAlertMinutes",
      "weekStart",
      "timeZone",
      "birthdayCalendar",
      "icalSubscriptions",
      "eventCategories",
    ],
  },
  {
    title: t("Language, dates and time"),
    keys: ["locale", "uiLanguage", "dateFormat", "timeFormat"],
  },
  {
    title: t("Labels and account data"),
    keys: [
      "labels",
      "labelsSidebar",
      "folderColors",
      "hiddenIdentities",
      DEFAULT_IDENTITY_KEY,
      "addedShares",
    ],
  },
];

function jsonFor(key: string, value: Example): string {
  return `"${key}": ${JSON.stringify(value)}`;
}

/** Expandable reference: key, what it does, and the JSON that activates it. */
export function SettingsKeyTable() {
  const grouped = GROUPS.map((group) => ({
    title: group.title,
    rows: group.keys.flatMap((k): Array<readonly [string, KeyEntry]> => {
      if (k === "appliedPolicyChanges" || !(k in DEFAULT_SETTINGS)) return [];
      const entry = ENTRIES[k];
      return entry ? [[k, entry]] : [];
    }),
  })).filter((g) => g.rows.length);
  // Keys this build gained that no group names (upstream additions).
  const stray = Object.keys(DEFAULT_SETTINGS).filter(
    (k) => k !== "appliedPolicyChanges" && !(k in ENTRIES),
  );

  return (
    <details>
      <summary>{t("Settings keys")}</summary>
      <p className="hint">
        {t(
          "Each example is the fragment to put under defaults, under enforced, or inside a change's settings.",
        )}
      </p>
      <table className="sessions-table" style={{ width: "100%" }}>
        <thead>
          <tr>
            <th>{t("Key")}</th>
            <th>{t("What it does")}</th>
            <th>{t("Example")}</th>
          </tr>
        </thead>
        <tbody>
          {grouped.map((group) => (
            <RowGroup key={group.title} group={group} />
          ))}
          {stray.length > 0 && (
            <>
              <tr>
                <th colSpan={3} style={{ textAlign: "left" }}>
                  {t("Unknown")}
                </th>
              </tr>
              {stray.map((key) => (
                <tr key={key}>
                  <td>
                    <code>{key}</code>
                  </td>
                  <td>{t("New in this build — no description yet.")}</td>
                  <td>
                    <code>"{key}": …</code>
                  </td>
                </tr>
              ))}
            </>
          )}
        </tbody>
      </table>
    </details>
  );
}

function RowGroup({
  group,
}: {
  group: { title: string; rows: Array<readonly [string, KeyEntry]> };
}) {
  return (
    <>
      <tr>
        <th colSpan={3} style={{ textAlign: "left" }}>
          {group.title}
        </th>
      </tr>
      {group.rows.map(([key, entry]) => (
        <tr key={key}>
          <td>
            <code>{key}</code>
          </td>
          <td>{entry.desc}</td>
          <td>
            <code>{jsonFor(key, entry.example)}</code>
          </td>
        </tr>
      ))}
    </>
  );
}
