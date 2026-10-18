import { DEFAULT_IDENTITY_KEY } from "@gilbert/shared/settingsDocument";
import { t } from "@/lib/i18n";
import { DEFAULT_SETTINGS, isSettingsKey } from "@/store/settings";

/**
 * The Settings-key table shown under "Settings keys" in the policy editor.
 *
 * One row per key this build knows, grouped by category: the key name, what
 * it does (English source, rendered through `t()` like every other catalogue
 * key), and the minimal JSON value that activates it — the fragment to put
 * under `defaults`, under `enforced`, or inside a `change`'s `settings`.
 *
 * The descriptions below are written from the doc comments on the `Settings`
 * interface in `web/src/store/settings.ts`: `GROUPS` names the keys each
 * category holds and `ENTRIES` says what each one does, kept in step by hand.
 * What is *checked* is that hand work: `settingsKeyTable.test.ts` fails when a
 * key a group names has no entry, or when an entry names a key this build does
 * not have. Keys that upstream adds later have no entry yet and fall back to a
 * generic row rather than vanishing.
 *
 * The **example** is not written here: it is the default the product ships,
 * read from `DEFAULT_SETTINGS`, so a row cannot quote a value the code stopped
 * using. Only the six keys whose default teaches nothing carry a filled sample
 * of their own, and the table's own test fences those in.
 */

/**
 * A value as the JSON fragment that activates a key.
 *
 * Objects and arrays of objects are here too (`knownSigners`, `folderColors`,
 * the calendar's colour categories): the column shows what to paste, and a
 * fragment that could not be pasted would be no fragment at all.
 */
type Example =
  | string
  | number
  | boolean
  | null
  | string[]
  | Record<string, unknown>
  | unknown[];

interface KeyEntry {
  /** English source; rendered through t(). */
  desc: string;
}

/**
 * A sample for the keys whose shipped default teaches nothing: an empty list
 * gives the type but not the contents, `null` gives neither, and a hex or a
 * URL is a form the default name does not show. Every other row shows the
 * default itself, which is the fragment an administrator pasting this under
 * `defaults` actually wants.
 */
export const EXAMPLES: Record<string, Example> = {
  accent: "#5b8def",
  folderColors: { "<mailboxId>": "#5b8def" },
  icalSubscriptions: ["https://example.com/team.ics"],
  internalDomains: ["example.com"],
  knownSigners: { "ops@example.com": "Operations" },
  timeZone: "Europe/Rome",
};

/** The JSON to copy for `key`: the default this build ships, or a sample. */
export function exampleFor(key: string): Example {
  const sample = (EXAMPLES as Record<string, Example | undefined>)[key];
  if (sample !== undefined) return sample;
  const shipped = (DEFAULT_SETTINGS as unknown as Record<string, Example | undefined>)[
    key
  ];
  // `null` is an answer, not a missing one: a key whose shipped default is null
  // is quoted as null, because quoting it as `""` would be a value this build
  // does not ship -- the drift this column exists to remove.
  return shipped === undefined ? null : shipped;
}

export const ENTRIES: Record<string, KeyEntry> = {
  theme: {
    desc: t("Which theme to use: system, light, dark, or Gilbert's own."),
  },
  palette: {
    desc: t("The colour palette (Gilbert's own or one of the shipped ones)."),
  },
  mode: { desc: t("Light, dark, or whatever the system says.") },
  accent: {
    desc: t("The accent colour that sits on top of any palette."),
  },
  density: {
    desc: t("How much fits on screen: comfortable, cozy or compact."),
  },
  fontSize: {
    desc: t("Interface text size: small, medium or large (device-local)."),
  },
  readingPane: {
    desc: t("Where the reading pane sits: right, bottom, or off."),
  },
  listPaneWidth: {
    desc: t("Message-list width with the pane on the right (px, device-local)."),
  },
  listPaneHeight: {
    desc: t("Message-list height with the pane below (px, device-local)."),
  },
  sidebarCollapsed: {
    desc: t("Whether the sidebar is collapsed (device-local)."),
  },
  showHiddenFolders: {
    desc: t("Show folders that Files normally hides."),
  },
  themeMessageBody: {
    desc: t("Let messages follow the app's theme instead of white."),
  },

  conversationMode: { desc: t("Thread messages into conversations.") },
  showPreview: {
    desc: t("Show a preview line under the subject in the list."),
  },
  showAvatars: { desc: t("Show avatars in the message list.") },
  pageSize: { desc: t("Messages per page in the list.") },
  markReadDelay: {
    desc: t("Seconds before an opened message counts as read; -1 never auto."),
  },
  autoAdvance: {
    desc: t("Where the list moves after acting: newer, older, or back to the list."),
  },
  archiveOnReply: {
    desc: t("Archive the original when replying to it."),
  },
  listSortPreset: {
    desc: t("Message-list order: newest, oldest, unread or starred first."),
  },
  listSortLevels: { desc: t("Secondary sort levels under the preset.") },
  listSortScope: {
    desc: t("Which folders the sort covers: inbox only, or all."),
  },
  swipeLeft: { desc: t("What a left swipe does in the list.") },
  swipeRight: { desc: t("What a right swipe does in the list.") },

  composeFormat: { desc: t("Compose in HTML or plain text.") },
  includeQuote: { desc: t("Quote the original message when replying.") },
  signatureAboveQuote: {
    desc: t("Put the signature above the quoted text."),
  },
  sendAndArchive: { desc: t("Send and archive in one action.") },
  spellcheck: { desc: t("Spellcheck the composer.") },
  templates: { desc: t("Compose templates the account saved.") },

  imagePolicy: {
    desc: t("Remote images: ask, always load, or only from contacts."),
  },
  trustedImageSenders: {
    desc: t("Senders whose remote images load without asking."),
  },
  knownSigners: {
    desc: t("S/MIME signers pinned per address (fingerprint → name)."),
  },
  requestReadReceipt: { desc: t("Ask senders for a read receipt.") },
  readReceiptPolicy: {
    desc: t("When a receipt is asked for: ask each time, or never."),
  },
  confirmDelete: { desc: t("Ask before deleting.") },
  attachmentReminder: {
    desc: t("Warn when a message mentions an attachment but has none."),
  },
  externalSenderBanner: {
    desc: t("Banner when a sender is outside the account's domains."),
  },
  externalRecipientConfirm: {
    desc: t("Confirm when a recipient is outside the account's domains."),
  },
  externalLinkWarning: {
    desc: t("Warn before opening links to outside domains."),
  },
  internalDomains: {
    desc: t("Domains counted as internal, on top of the account's own."),
  },
  trustedLinkDomains: {
    desc: t("Outside domains whose links open without warning."),
  },
  replyAllThreshold: {
    desc: t("People on a message before Reply-all asks; 0 is off."),
  },

  desktopNotifications: {
    desc: t("Desktop notifications for new mail (device-local)."),
  },
  notificationSound: {
    desc: t("Play a sound for new mail (device-local)."),
  },

  calendarDefaultView: {
    desc: t("The calendar view a new open starts on."),
  },
  workDayStart: { desc: t("Hour the working day starts (calendar grid).") },
  workDayEnd: { desc: t("Hour the working day ends (calendar grid).") },
  defaultEventDuration: { desc: t("Default event length, in minutes.") },
  defaultAlertMinutes: { desc: t("Default reminder lead, in minutes.") },
  weekStart: {
    desc: t("First day of the week: 0 Sunday, 1 Monday, 6 Saturday."),
  },
  timeZone: {
    desc: t("The calendar time zone; null means the browser's."),
  },
  birthdayCalendar: {
    desc: t("Show a calendar of birthdays from the address book."),
  },
  icalSubscriptions: { desc: t("Calendars subscribed to by URL.") },
  eventCategories: {
    desc: t("Outlook-style colour categories for calendar events."),
  },

  locale: {
    desc: t("The mail-server locale; empty means follow the server."),
  },
  uiLanguage: { desc: t("The interface language; empty means English.") },
  dateFormat: {
    desc: t("How dates are written; auto follows the locale."),
  },
  timeFormat: {
    desc: t("12- or 24-hour clock; auto follows the locale."),
  },

  labels: { desc: t("The account's labels.") },
  labelsSidebar: { desc: t("Show labels in the sidebar.") },
  folderColors: { desc: t("Folder colours by mailbox id (device-local).") },
  hiddenIdentities: {
    desc: t("Identities hidden from the compose picker."),
  },
  defaultIdentityByAccount: {
    desc: t("Default sending identity per account."),
  },
  addedShares: {
    desc: t("Address books whose shared writes the reader remembered."),
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
      if (k === "appliedPolicyChanges" || !isSettingsKey(k)) return [];
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
                  <td>{t("No description available.")}</td>
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
            <code>{jsonFor(key, exampleFor(key))}</code>
          </td>
        </tr>
      ))}
    </>
  );
}
