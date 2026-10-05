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
 * client's set: mail and its quota, files and chat, calendars, contacts, and
 * filters.
 *
 * These are JMAP state types, not capabilities. Stalwart parses them from its
 * `DataType` enum, which has no whitelist, and does not require the matching
 * `urn:…` in the request's `using` — the FileNode subscription already ships
 * with core and mail alone. A name outside the enum fails the
 * `PushSubscription/set`, which leaves that account on the relay rather than
 * breaking anything, since the relay is the fallback. See
 * docs/adr/0009-the-push-subscription-covers-every-live-type.md.
 *
 * The agent worker's wake-up set is a different thing and deliberately
 * narrower: `RECONCILED_TYPES` in `server/src/agent/agent.ts` says which types
 * a reconciliation pass reads, and it acts on mail and files only. This list is
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
  // Calendars.
  "Calendar",
  "CalendarEvent",
  // Contacts.
  "AddressBook",
  "ContactCard",
  // Filters.
  "SieveScript",
] as const;

export type PushStateType = (typeof PUSH_STATE_TYPES)[number];

/**
 * The prefix every `deviceClientId` this product sets carries.
 *
 * It is what makes the rows recognisable at all: a subscription can never be
 * identified by its endpoint, because Stalwart does not hand `url` back (live
 * on 0.16.21, 2026-09-14: `url: null` even for a row registered with one). So
 * the name is the only handle, and both tiers spell it here.
 */
export const GILBERT_DEVICE_PREFIX = "gilbert-";

/**
 * A `deviceClientId` for the given identity.
 *
 * Two callers, with two kinds of identity and the same name: the browser builds
 * one from a fresh UUID (`gilbertmailer`), and gilbertserver builds one from
 * this installation's derived identity (`server/src/push.ts`). They are the same
 * kind of row to Stalwart and must not collide, which is what
 * `isBrowserDeviceClientId` is for.
 */
export function gilbertDeviceClientId(identity: string): string {
  return `${GILBERT_DEVICE_PREFIX}${identity}`;
}

/**
 * Whether a `deviceClientId` is a browser's rather than this installation's.
 *
 * By shape, never by the subscription's `types`: the two tiers build their names
 * from different identities (a random UUID against a derived 16-character one),
 * so the shape separates them exactly — while `types` is a property a client may
 * legitimately change, and reading the row's owner off it means a client that
 * subscribes to something else looks like a stranger's row.
 *
 * That is not hypothetical: gilbertserver's reclaim of its own past builds
 * (`server/src/push.ts`) used to recognise a browser by it asking for `Email`
 * alone, so the day a browser asked for anything else — `EmailDelivery`, say —
 * its own registration became a candidate for deletion on a full quota.
 */
export function isBrowserDeviceClientId(id: string | null | undefined): boolean {
  if (typeof id !== "string" || !id.startsWith(GILBERT_DEVICE_PREFIX)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id.slice(GILBERT_DEVICE_PREFIX.length),
  );
}
