/**
 * Every JMAP state type a Gilbert surface keeps live.
 *
 * Changes reach a tab by one of two transports, and they must carry the same
 * types. The relay asks Stalwart for `types=*` and forwards whatever arrives.
 * The push subscription (`server/src/push.ts`) must name its types instead,
 * because Stalwart POSTs a subscriber only the types that subscription asked
 * for. A type left off that list is silently dead under fan-out: the store
 * watching it keeps whatever state it last fetched while the same session on
 * the relay keeps updating — so turning the fan-out on would change which
 * parts of the app are live, and the difference would stay invisible until
 * somebody noticed a stale calendar.
 *
 * The list therefore lives here, once, and `subscribe()` reads it. It is the
 * client's set: mail and its quota, files and chat, calendars and tasks,
 * contacts, and filters.
 *
 * These are JMAP state types, not capabilities. Stalwart parses them from its
 * `DataType` enum, which has no whitelist, and does not require the matching
 * `urn:…` in the request's `using` — the FileNode subscription already ships
 * with core and mail alone. A name outside the enum fails the
 * `PushSubscription/set`, which leaves that account on the relay rather than
 * breaking anything, since the relay is the fallback. See
 * docs/adr/0012-the-push-subscription-covers-every-live-type.md.
 *
 * The agent worker's wake-up set is a different thing and deliberately
 * narrower: `TYPES_BY_AREA` in `server/src/agent/worker.ts` says which types a
 * reconciliation pass reads, and it acts on mail and files only. This list is
 * what a browser keeps live, not what a worker wakes for.
 */
export const PUSH_STATE_TYPES = [
  // Mail, and the quota bar over it.
  "Email",
  "Mailbox",
  "Thread",
  "Identity",
  "EmailSubmission",
  "VacationResponse",
  "Quota",
  // Files, which carry chat and the agent documents too.
  "FileNode",
  // Calendars and tasks.
  "Calendar",
  "CalendarEvent",
  // Contacts.
  "AddressBook",
  "ContactCard",
  // Filters.
  "SieveScript",
  // ADR-0012 OWED: push-types-live-probe
] as const;

export type PushStateType = (typeof PUSH_STATE_TYPES)[number];
