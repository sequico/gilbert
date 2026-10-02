import { isRecord } from "@gilbert/shared/json";
import { withBase } from "@/lib/basePath";
import { pendingSettingsKeys } from "@/lib/settingsSync";
import { isSettingsKey, type Settings, useSettings } from "@/store/settings";

/**
 * What the installation has decided about settings, rather than the reader.
 *
 * Two powers, from #207. `defaults` seed an account that has never had settings
 * of its own and can be changed afterwards like anything else. `enforced` are
 * applied on every load and cannot be changed here at all -- their controls stay
 * visible and go dead, which is what the issue asked for: hiding them confuses
 * somebody who has used Gilbert somewhere without a policy.
 *
 * Fetched once per account, from `/api/account/policy` (ADR 0001) —
 * authenticated, since the policy is now a fact about the signed-in account's
 * own copy of the published document rather than a fact about the
 * installation everybody saw before signing in. Called after `accountId` is
 * known (`App.tsx`), before anybody's settings are read.
 */
export interface PolicyChange {
  /** Unique in the policy; what an account stores to say it has had this one. */
  version: string;
  settings: Partial<Settings>;
}

export interface SettingsPolicy {
  defaults: Partial<Settings>;
  enforced: Partial<Settings>;
  /**
   * Applied once each, to everybody, and changeable afterwards.
   *
   * The third power in #207, and the one that needed somewhere to remember: an
   * admin turning something on for existing accounts, without it snapping back
   * on for a reader who then turned it off.
   */
  changes: PolicyChange[];
}

const EMPTY: SettingsPolicy = { defaults: {}, enforced: {}, changes: [] };

/**
 * What this client knows about the installation's policy.
 *
 * A policy object that starts empty cannot tell "this installation sets
 * nothing" from "nobody has managed to ask", and only the first of those is an
 * answer a write may be measured against. Asking is the difference: the
 * endpoint is the signed-in account's own copy of the published document
 * (ADR 0001), so a session that has just signed in can meet a 401 on it, a
 * server having a bad minute a 5xx -- and a page load with no enforced map at
 * all, an administrator's setting neither applied nor locked, with nothing on
 * screen saying the policy was never read.
 *
 * `unread` is not that state: nobody has asked yet, the fetch is in flight
 * while the first frames of a session are on screen, and the load completion
 * re-applies enforcement over anything written in that window.
 */
export type PolicyStatus = "unread" | "read" | "unavailable";

/**
 * What a read of the installation's policy came back with.
 *
 * The union is the guarantee: an empty policy is only ever reached through
 * `read`, so no caller can take a request that did not answer for an
 * installation that sets nothing.
 */
export type PolicyRead =
  | { status: "read"; policy: SettingsPolicy }
  | { status: "unavailable" };

let standing: PolicyStatus = "unread";
/**
 * The policy in hand: what the last answer brought, and `EMPTY` until one does.
 *
 * A read that fails leaves the last answer standing for what is already on
 * screen -- a control the installation locked stays locked rather than
 * unlocking itself because a request failed -- and no write lands on it: the
 * door in the settings store refuses every patch while the status is
 * `unavailable`.
 */
let policy: SettingsPolicy = EMPTY;
let fetched: Promise<PolicyRead> | null = null;

/**
 * Keys the installation names that this build does not have.
 *
 * A policy written against a newer Gilbert, or with a typo in it, must not
 * introduce a setting that nothing reads: `update` would carry it around and
 * `syncedPart` would push it to the reader's settings file. Anything not in
 * `DEFAULT_SETTINGS` is dropped here, at the door. (Contrast `importJson`,
 * which trusts what it is handed -- only a parse failure rejects it: an
 * unknown key it admits rides in that browser's state and cache, and a device
 * that reads the file back drops it through `acceptRemote`.)
 */
function known(obj: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (isSettingsKey(k)) out[k] = v;
  return out as Partial<Settings>;
}

/**
 * The published policy out of the answer, or `null` when the answer is not one.
 *
 * The endpoint answers `{ policy: { defaults, enforced, changes } }`, built from
 * a document the server validated when it was published
 * (`server/src/adminPolicy.ts`), so anything else -- a proxy's error page, a
 * body from something that does not know this endpoint, a `changes` that is not
 * a list -- is a request that did not bring a policy back. Reading it as an
 * installation that sets nothing is the mistake this module is shaped against,
 * so it is refused here rather than forgiven. A section that is not an object
 * is refused for the same reason the server refuses one at publish time: a
 * scalar where an object belongs loads as settings that are not there.
 */
function policyDocument(body: unknown): SettingsPolicy | null {
  if (!isRecord(body)) return null;
  const policy = body.policy;
  if (!isRecord(policy)) return null;
  const { defaults, enforced, changes } = policy;
  if (defaults !== undefined && !isRecord(defaults)) return null;
  if (enforced !== undefined && !isRecord(enforced)) return null;
  if (changes !== undefined && !Array.isArray(changes)) return null;
  return {
    defaults: known(isRecord(defaults) ? defaults : {}),
    enforced: known(isRecord(enforced) ? enforced : {}),
    /* A change whose every key this build does not have is dropped whole:
       applying nothing and then recording it as applied would mean it never
       ran on the gilbert that does have the setting. An entry that is not a
       change at all is dropped the same way. */
    changes: (Array.isArray(changes) ? changes : [])
      .map((entry) => {
        const c = isRecord(entry) ? entry : {};
        return {
          version: typeof c.version === "string" ? c.version : "",
          settings: known(isRecord(c.settings) ? c.settings : {}),
        };
      })
      .filter((c) => c.version && Object.keys(c.settings).length),
  };
}

/**
 * Read the installation's policy.
 *
 * The answer says which of the two silences it is: `unavailable` when the
 * request did not bring the document back -- a refusal, a server error, a
 * connection that failed, a body that is not the document -- and a policy whose
 * `enforced` is empty when the installation genuinely sets nothing. Only the
 * second of those is a licence to write settings, which is what the return type
 * is for.
 *
 * A read that answered is memoised for the page lifetime. A read that failed is
 * not: the memo goes at the moment the failure lands, so the next caller
 * reaches the endpoint rather than the memory of a request that did not answer.
 */
export function loadSettingsPolicy(): Promise<PolicyRead> {
  if (!fetched) {
    const attempt = readPolicy();
    /*
     * One answer for everybody who is waiting, and the only place a read
     * reaches the state the rest of the app consults. A read that throws is a
     * read that did not answer, and it is turned into `unavailable` here
     * rather than handed on as a rejection: nothing on the sign-in path
     * catches, and a rejection held in the memo is a failure nobody could ask
     * past.
     */
    const read = attempt.then(
      (result) => {
        if (fetched === read) return settle(result);
        return result;
      },
      () => {
        const refused: PolicyRead = { status: "unavailable" };
        if (fetched === read) return settle(refused);
        return refused;
      },
    );
    fetched = read;
  }
  return fetched;
}

/**
 * What an accepted read leaves behind, and what it corrects.
 *
 * Only the read the memo still holds may speak for the client: a
 * `refreshSettingsPolicy` that started later has a newer answer, and an older
 * read settling late must neither reopen the door with a policy a publication
 * has already replaced nor shut it with a failure that has since been answered.
 */
function settle(read: PolicyRead): PolicyRead {
  if (read.status === "unavailable") {
    standing = "unavailable";
    /*
     * A failure is not an answer to keep: the memo goes, so the next caller
     * asks the endpoint again instead of being handed the memory of a request
     * that did not answer. Only the read the memo still holds reaches here,
     * so a newer read is never forgotten by an older one settling late.
     */
    fetched = null;
    return read;
  }
  policy = read.policy;
  standing = "read";
  /*
   * A change made while the fetch was in flight went through `update`
   * with no enforcement to apply, and is queued for the settings file
   * as-is. Re-run the door over the current settings now and re-queue the
   * corrected snapshot, so the queued write cannot land a value the
   * policy forbids. (Without this the first flush -- which happens only
   * after the load has settled -- writes the pre-policy value.)
   *
   * The answer is in whichever way the correction goes, so a correction that
   * throws is caught here rather than reported to the caller as a policy that
   * never arrived.
   */
  try {
    if (Object.keys(read.policy.enforced).length && pendingSettingsKeys().size)
      useSettings.getState().update({ ...read.policy.enforced });
  } catch {
    /* The policy is in hand; there is nothing left to do about the queue. */
  }
  return read;
}

/**
 * One attempt at the endpoint, and what it means for the settings in force.
 *
 * Everything that can go wrong is inside the try, reading the document
 * included: `res.json()` on a body that is not JSON throws, and a body that is
 * JSON and not the published shape is refused by `policyDocument`. Either way
 * the attempt answers `unavailable`, because a throw that escapes here is a
 * read the client can neither report nor ask past.
 */
async function readPolicy(): Promise<PolicyRead> {
  try {
    const res = await fetch(withBase("/api/account/policy"), {
      credentials: "same-origin",
    });
    if (!res.ok) return { status: "unavailable" };
    const policy = policyDocument(await res.json());
    /* An installation that cannot be reached and one that sets nothing are
       the same silence here. Neither is a policy, and a sign-in does not stop
       for either. */
    if (!policy) return { status: "unavailable" };
    return { status: "read", policy };
  } catch {
    /* Nothing came back, or nothing that parses. */
    return { status: "unavailable" };
  }
}

/**
 * Forget the fetched policy and load it again.
 *
 * The first fetch is cached for the page lifetime, so a session that
 * re-signs-in on the same page — or an administrator who has just published a
 * policy (ADR 0001) — would keep the policy fetched before the publish. This
 * forgets it and loads again, and the load completion logic (the enforcement
 * re-apply) runs exactly as it does for the first fetch. A load that comes back
 * `unavailable` is not kept either, so asking again is always a real attempt.
 */
export async function refreshSettingsPolicy(): Promise<PolicyRead> {
  fetched = null;
  return loadSettingsPolicy();
}

/**
 * What this client knows about the installation's policy.
 *
 * The door in the settings store reads this, and reads nothing else, to decide
 * whether a patch may be applied: `policyEnforced()` cannot answer the
 * question, because an installation nobody could ask and one that enforces
 * nothing are both `{}` there.
 */
export function policyStatus(): PolicyStatus {
  return standing;
}

/** What the installation has settled, for a reader who has none of their own. */
export function policyDefaults(): Partial<Settings> {
  return policy.defaults;
}

/**
 * What the installation has settled that a reader may not change.
 *
 * The values are the last answer a read brought. Ask `policyStatus()` for
 * whether there is an answer at all: a patch that goes through the door while
 * no policy is in hand is a patch nobody could measure.
 */
export function policyEnforced(): Partial<Settings> {
  return policy.enforced;
}

/** Whether this setting belongs to the administrator rather than the reader. */
export function isEnforced(key: keyof Settings): boolean {
  return key in policy.enforced;
}

/** Changes the installation wants applied once each. */
export function policyChanges(): PolicyChange[] {
  return policy.changes;
}

/** Only for tests: forget what was fetched. */
export function resetSettingsPolicyForTest(next: Partial<SettingsPolicy> = {}): void {
  policy = {
    defaults: known((next.defaults ?? {}) as Record<string, unknown>),
    enforced: known((next.enforced ?? {}) as Record<string, unknown>),
    changes: (next.changes ?? [])
      .map((c) => ({
        version: c.version,
        settings: known(c.settings as Record<string, unknown>),
      }))
      .filter((c) => c.version && Object.keys(c.settings).length),
  };
  // The hook stands for an installation that answered with this document, so
  // the status is `read`; a test that wants a read that did not arrive stubs
  // `fetch` and calls `loadSettingsPolicy`.
  standing = "read";
  // Forget the fetch too: `loadSettingsPolicy` re-runs its completion logic
  // (the enforcement re-apply) against whatever the next test feeds it.
  fetched = null;
}
