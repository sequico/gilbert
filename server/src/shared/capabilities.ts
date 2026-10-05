/**
 * The JMAP capability URNs, one definition for both tiers.
 *
 * A capability URN is a contract with the server, and it is read in three
 * places that have to agree: a request's `using` array, the session's
 * `capabilities` and `primaryAccounts`, and each account's
 * `accountCapabilities`. The two tiers name the same vocabulary — the server
 * to talk to Stalwart (`jmap.ts`, `upstream.ts`, `push.ts`, `app.ts`,
 * `account.ts`, `appFolder.ts`), the browser to select the account that owns a
 * surface and to build each request's `using` (`web/src/jmap/client.ts`'s
 * `CAP`) — and a URN spelled twice is a capability that silently never matches:
 * a request that names one the server does not know is refused with
 * `unknownMethod`, and an account lookup keyed by a near-miss finds nothing.
 *
 * Stalwart advertises several of these per account rather than at the session
 * level, `urn:stalwart:jmap` above all (see `gilbert-stalwart`). That is a fact
 * about *where* to look, not about what the URN is: the spelling is one, and it
 * is here.
 *
 * The keys are the ones the client's `CAP` uses. The server's own aliases
 * (`JMAP_CORE`, `JMAP_MAIL`, `JMAP_SUBMISSION`, `STALWART_CAP` in `jmap.ts`;
 * `FILENODE_CAP` in `appFolder.ts`) are re-exported from this record for its
 * tier's call sites, so the agent and admin code keeps reading the vocabulary
 * its own layer named.
 */
/**
 * The Stalwart release line Gilbert requires: sign-in refuses anything older,
 * once and with a clear message. One constant, so the refusal and the About
 * panel cannot name different minimums.
 */
export const STALWART_MIN_VERSION = "0.16";

export const CAPABILITIES = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
  vacation: "urn:ietf:params:jmap:vacationresponse",
  sieve: "urn:ietf:params:jmap:sieve",
  contacts: "urn:ietf:params:jmap:contacts",
  contactsParse: "urn:ietf:params:jmap:contacts:parse",
  calendars: "urn:ietf:params:jmap:calendars",
  calendarsParse: "urn:ietf:params:jmap:calendars:parse",
  principals: "urn:ietf:params:jmap:principals",
  availability: "urn:ietf:params:jmap:principals:availability",
  quota: "urn:ietf:params:jmap:quota",
  blob: "urn:ietf:params:jmap:blob",
  filenode: "urn:ietf:params:jmap:filenode",
  websocket: "urn:ietf:params:jmap:websocket",
  webpushVapid: "urn:ietf:params:jmap:webpush-vapid",
  emailpush: "urn:ietf:params:jmap:emailpush",
} as const;

/**
 * Stalwart's own registry, and not a JMAP capability in the RFC sense.
 *
 * It is spelled `urn:stalwart:jmap` and it is the marker for the `x:` objects
 * that carry the account registry, credentials and the newer FileNode shape.
 * It is here because it is a URN both tiers compare against, and it is beside
 * `CAPABILITIES` rather than inside it because the client never sends it: the
 * browser's vocabulary is the set of capabilities it can name in a request's
 * `using`, and this one is read, never sent.
 */
export const STALWART_REGISTRY = "urn:stalwart:jmap";
