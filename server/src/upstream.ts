import { config } from "./config.js";

export interface UpstreamSession {
  capabilities: Record<string, unknown>;
  accounts: Record<string, unknown>;
  primaryAccounts: Record<string, string>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
  /**
   * Which credential authenticated this session, where the upstream can say.
   * The mock reports it (it validates the secret itself); Stalwart's session
   * resource does not carry the credential type, so against a real 0.16
   * server the field is absent and a session counts as a password session.
   * See the dated comment in the mock.
   */
  authType?: "password" | "app-password";
  /**
   * Which Stalwart this document came from.
   *
   * Recorded rather than looked up again, because the relative URLs inside it
   * -- apiUrl, uploadUrl and the rest -- only mean anything against the server
   * that issued them. Anything holding a session already knows where to send
   * the next request. Not part of the JMAP session resource; ours.
   */
  baseUrl: string;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const sessionCache = new Map<string, { session: UpstreamSession; fetchedAt: number }>();
const SESSION_CACHE_MS = 5 * 60_000;
/**
 * Absolute ceiling for the caches below, aligned with the shorter session
 * TTL (SESSION_TTL, 12 h). An entry nobody refreshed for that long cannot
 * belong to a session that is still in use -- and some keys are not session
 * ids at all (push.ts caches under "base username"), which no session
 * destruction touches. Such entries are dropped on the next lookup rather
 * than refreshed. That costs nothing for a live session: an access this old
 * would have missed the freshness window and refetched anyway.
 */
const CACHE_MAX_AGE_MS = config.sessionTtl * 1000;

/**
 * The Stalwart a username belongs to.
 *
 * `STALWART_URL` is the default and is always the answer for a domain nobody
 * mapped -- and for a bare username, which Stalwart accepts and which has no
 * domain to map (#238).
 *
 * A *mapped* domain never falls back. If its server is unreachable that
 * sign-in fails, because falling back would authenticate somebody against a
 * server their domain was deliberately routed away from -- and if the same
 * account name exists there, they would land in another tenant's mailbox. The
 * fallback is a decision about unmapped domains, taken before any network
 * call, not a recovery path.
 */
export function upstreamFor(username: string): string {
  const at = username.lastIndexOf("@");
  if (at < 0) return config.stalwartUrl;
  const domain = username
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  return config.stalwartServers[domain] ?? config.stalwartUrl;
}

export function wellKnownUrl(base: string = config.stalwartUrl): string {
  return `${base}/.well-known/jmap`;
}

/**
 * Fetch the JMAP session resource from Stalwart using the given Authorization
 * header. Throws UpstreamError(401) on bad credentials.
 */
export async function fetchUpstreamSession(
  authorization: string,
  base: string = config.stalwartUrl,
): Promise<UpstreamSession> {
  const res = await fetch(wellKnownUrl(base), {
    headers: { authorization, accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError("Invalid credentials", 401);
  }
  if (!res.ok) {
    throw new UpstreamError(`Upstream session request failed (${res.status})`, 502);
  }
  const session = (await res.json()) as UpstreamSession;
  if (!session.apiUrl)
    throw new UpstreamError("Upstream returned an invalid JMAP session", 502);
  return { ...session, baseUrl: base };
}

export async function getUpstreamSession(
  sessionId: string,
  authorization: string,
  base: string = config.stalwartUrl,
  force = false,
) {
  const cached = sessionCache.get(sessionId);
  if (cached) {
    if (Date.now() - cached.fetchedAt >= CACHE_MAX_AGE_MS) {
      // The entry outlived any session that could still be using it: drop it
      // so the map does not grow with every session that ever expired.
      sessionCache.delete(sessionId);
    } else if (!force && Date.now() - cached.fetchedAt < SESSION_CACHE_MS) {
      return cached.session;
    }
  }
  const session = await fetchUpstreamSession(authorization, base);
  sessionCache.set(sessionId, { session, fetchedAt: Date.now() });
  return session;
}

export function forgetUpstreamSession(sessionId: string): void {
  sessionCache.delete(sessionId);
  infoCache.delete(sessionId);
}

/**
 * Whether a resolved `/api/account` permission list marks a Stalwart admin
 * (ADR 0001).
 *
 * JMAP exposes no role or principal attribute, so the one non-forgeable
 * runtime signal is the account's own permission list, read by
 * self-introspection at sign-in and re-checked on every privileged call.
 * The marker is the configured `adminPermissionMarker`, default
 * `sysAccountCreate` (live-verified 2026-09-09, Stalwart 0.16.21); the
 * recovery admin token reports every permission, marker included. A list
 * without the marker — or no list at all — resolves to non-admin: the
 * decision fails closed.
 */
export function isStalwartAdmin(
  permissions: readonly string[] | null | undefined,
): boolean {
  return !!permissions && permissions.includes(config.adminPermissionMarker);
}

/**
 * Whether the session holds a group mailbox to chat in (ADR 0005): a
 * non-personal account with an address. Any non-personal account counts for
 * the chat push rail — there is no product-admin group to exclude since ADR
 * 0001 removed it, and a group mailbox that shares mail is a working group.
 *
 * The match is deliberately by name shape only: a calendar or files share
 * can be a non-personal account too, and this may count it. The cost of
 * being generous is one subscription whose `types` includes FileNode — an
 * extra StateChange POST when that account's own nodes change — which is
 * the volume trade the ADR records as settled at implementation.
 *
 * This server-side rule is the wire-level superset of the client's
 * `groupMailboxAccounts` (web/src/lib/mailAccounts.ts), which probes actual
 * mailbox trees. It must never be *narrower* than the client's offer: if the
 * client offers chat for an account this rule misses, that account's
 * FileNode changes never POST and the chat goes silently stale. When the
 * two drift, narrow the client, never this flag.
 */
export function hasChatGroupAccounts(
  session: Pick<UpstreamSession, "accounts"> | null | undefined,
): boolean {
  if (!session) return false;
  return Object.values(session.accounts ?? {}).some((a) => {
    const account = a as { name?: unknown; isPersonal?: unknown };
    if (account.isPersonal !== false || typeof account.name !== "string") return false;
    const name = account.name.trim().toLowerCase();
    return name.indexOf("@") > 0;
  });
}

/* ------------------------------------------------------------------ */
/* Account locale                                                      */
/* ------------------------------------------------------------------ */

const STALWART_CAP = "urn:stalwart:jmap";
const JMAP_CORE = "urn:ietf:params:jmap:core";

/**
 * Whether this server has Stalwart's JMAP registry — the `x:` objects that
 * carry credentials, account settings and the newer FileNode shape.
 *
 * `urn:stalwart:jmap` is the marker, but **not** in the session-level
 * `capabilities`, which is where a JMAP client would naturally look. Stalwart
 * builds that list from a fixed set that has never included this capability;
 * it hands it out per-account instead, so it turns up in `primaryAccounts` and
 * in each account's `accountCapabilities`. Checking only the session level
 * therefore reported every real 0.16 server as older than 0.16 — which routed
 * self-service credentials to a REST endpoint 0.16 had removed, and told the
 * About page the wrong thing. The session level is still checked last, in case
 * a later release advertises it there as well.
 *
 * This is now what sign-in tests to decide whether a server is supported at
 * all, so the same mistake would lock every user out of a working server
 * rather than merely misroute them.
 */
export function hasStalwartRegistry(
  session:
    | Pick<UpstreamSession, "capabilities" | "accounts" | "primaryAccounts">
    | undefined,
): boolean {
  if (!session) return false;
  if (session.primaryAccounts && STALWART_CAP in session.primaryAccounts) return true;
  for (const account of Object.values(session.accounts ?? {})) {
    const caps = (account as { accountCapabilities?: Record<string, unknown> } | null)
      ?.accountCapabilities;
    if (caps && STALWART_CAP in caps) return true;
  }
  return Boolean(session.capabilities && STALWART_CAP in session.capabilities);
}

export interface AccountInfo {
  /** BCP-47 tag configured for the account, or null if unreadable. */
  locale: string | null;
  /** "oss" | "community" | "enterprise", where the server reports it. */
  edition: string | null;
}

const infoCache = new Map<string, { info: AccountInfo; fetchedAt: number }>();
const INFO_CACHE_MS = 30 * 60_000;
const EMPTY_INFO: AccountInfo = { locale: null, edition: null };

/**
 * glibc modifiers that name a script rather than a dialect or a currency:
 * "sr_RS@latin" is Latin Serbian (sr-Latn-RS), not sr-RS. Anything not listed
 * here (@valencia, @saaho, @euro …) carries no script and is dropped.
 */
const SCRIPT_MODIFIERS: Record<string, string> = {
  latin: "Latn",
  latn: "Latn",
  cyrillic: "Cyrl",
  cyrl: "Cyrl",
  devanagari: "Deva",
  iqtelif: "Latn",
};

/**
 * Normalise a POSIX-style locale ("de_DE.UTF-8@euro") into a BCP-47 tag
 * ("de-DE"). Returns null for the locale-less values ("C", "POSIX") and for
 * anything that does not look like a language tag.
 */
export function normalizeLocale(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const [head, modifier] = raw.trim().split("@");
  const base = head!.split(".")[0]!.replace(/_/g, "-");
  if (!base || base === "C" || base.toUpperCase() === "POSIX") return null;
  if (!/^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/.test(base)) return null;
  const script = modifier ? SCRIPT_MODIFIERS[modifier.toLowerCase()] : undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(base);
    if (!canonical) return null;
    if (!script) return canonical;
    const loc = new Intl.Locale(canonical);
    // Adding the script only helps when it differs from the one the locale
    // already implies (ru-RU is Cyrillic, so "ru_RU@cyrillic" is just ru-RU).
    const implied = loc.script ?? loc.maximize().script;
    return implied === script
      ? canonical
      : new Intl.Locale(canonical, { script }).toString();
  } catch {
    return null;
  }
}

/**
 * Best-effort lookup of what the server can tell us about this account.
 *
 * The locale used to come from `x:Account/get`, which needs the `sysAccountGet`
 * permission — a tenant/admin one that ordinary users are not granted, so the
 * setting silently fell back to the browser locale for exactly the people most
 * likely to want it. Stalwart 0.16 exposes the same field on `x:AccountSettings`,
 * whose `sysAccountSettingsGet` permission *is* part of the built-in user role.
 * Ask for both in one request and take whichever the server allows, which also
 * tells us which generation we are talking to.
 */
async function fetchAccountInfo(
  authorization: string,
  session: UpstreamSession,
): Promise<AccountInfo> {
  // Sign-in refuses a server without the registry, so this should not happen —
  // but a session we cannot read capabilities from is not one to ask.
  if (!session.capabilities || !hasStalwartRegistry(session)) return EMPTY_INFO;
  const accountId =
    session.primaryAccounts?.[STALWART_CAP] ??
    session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ??
    Object.keys(session.accounts ?? {})[0];
  if (!accountId) return EMPTY_INFO;
  const res = await fetch(absoluteUpstream(session.apiUrl), {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      using: [JMAP_CORE, STALWART_CAP],
      methodCalls: [
        [
          "x:AccountSettings/get",
          { accountId, ids: ["singleton"], properties: ["locale"] },
          "s",
        ],
        ["x:Account/get", { accountId, ids: [accountId], properties: ["locale"] }, "a"],
      ],
    }),
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  // A locale request that fails — a permission we lack, a hiccup upstream —
  // costs us the locale and nothing else.
  if (!res.ok) return EMPTY_INFO;
  const body = (await res.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  return interpretAccountInfo(body.methodResponses ?? []);
}

/**
 * Read the pair of replies: prefer the locale from `x:AccountSettings`, whose
 * permission the built-in user role has, and fall back to `x:Account` for the
 * accounts allowed the admin-only `sysAccountGet` instead. Both are 0.16
 * methods; this is a permissions fallback, not a version one.
 */
export function interpretAccountInfo(
  responses: [string, Record<string, unknown>, string][],
): AccountInfo {
  const settings = responses.find((r) => r[2] === "s");
  const account = responses.find((r) => r[2] === "a");
  return { locale: localeOf(settings) ?? localeOf(account), edition: null };
}

function localeOf(
  call: [string, Record<string, unknown>, string] | undefined,
): string | null {
  if (!call || call[0] === "error") return null;
  const list = call[1]?.list;
  if (!Array.isArray(list) || !list.length) return null;
  return normalizeLocale((list[0] as { locale?: unknown } | undefined)?.locale);
}

/**
 * What `/api/account` reports about the authenticated account itself.
 *
 * Stalwart deliberately does not publish its version number to clients, but
 * 0.16 reports its edition here; and JMAP exposes no role or principal
 * attribute, so the same endpoint is also the one place a principal can read
 * its own resolved permission list (ADR 0001).
 */
export interface AccountIntrospection {
  /** "oss" | "community" | "enterprise", where the server reports it. */
  edition: string | null;
  /** The account's resolved permission list; empty when the server said none. */
  permissions: string[];
}

/**
 * Read the authenticated account's own `/api/account` introspection.
 *
 * Throws UpstreamError on any failure — a 401/403 means the credential was
 * refused, anything else non-ok is an upstream failure. Callers decide what
 * a refusal costs: the locale/edition path treats it as a nicety, the admin
 * paths (ADR 0001) fail closed on it.
 *
 * App-password credentials authenticate here exactly like a password
 * (live-verified 2026-09-09, Stalwart 0.16.21), so a session re-sealed onto
 * an app password by the 2FA switch-over still introspects as itself.
 */
export async function fetchAccountIntrospection(
  authorization: string,
  base: string = config.stalwartUrl,
): Promise<AccountIntrospection> {
  const res = await fetch(`${base}/api/account`, {
    headers: { authorization, accept: "application/json" },
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError("Invalid credentials", 401);
  }
  if (!res.ok) {
    throw new UpstreamError(`Account introspection failed (${res.status})`, 502);
  }
  const body = (await res.json()) as { edition?: unknown; permissions?: unknown };
  return {
    edition: typeof body.edition === "string" ? body.edition : null,
    permissions: Array.isArray(body.permissions)
      ? body.permissions.filter((p): p is string => typeof p === "string")
      : [],
  };
}

export async function getAccountInfo(
  sessionId: string,
  authorization: string,
  session: UpstreamSession,
): Promise<AccountInfo> {
  const cached = infoCache.get(sessionId);
  if (cached) {
    if (Date.now() - cached.fetchedAt >= CACHE_MAX_AGE_MS) {
      // Same absolute ceiling as the session cache: an entry this old can
      // only belong to a session that is gone; prune it on the way out.
      infoCache.delete(sessionId);
    } else if (Date.now() - cached.fetchedAt < INFO_CACHE_MS) {
      return cached.info;
    }
  }
  let info = EMPTY_INFO;
  try {
    info = await fetchAccountInfo(authorization, session);
    // Fault-isolate the edition read: the introspection throws on any
    // failure, and an /api/account hiccup must cost the edition alone, not
    // the locale the JMAP read just fetched. The throwing contract stays for
    // the admin paths, which want the failure (ADR 0001).
    info = {
      ...info,
      edition:
        (
          await fetchAccountIntrospection(authorization, session.baseUrl).catch(
            () => null,
          )
        )?.edition ?? null,
    };
  } catch {
    /* all of this is a nicety - never fail the session over it */
  }
  infoCache.set(sessionId, { info, fetchedAt: Date.now() });
  return info;
}

/**
 * Enumerate the individual accounts on this server (the admin Users
 * surface), when the server lets this session do it.
 *
 * The query is unfiltered, exactly the shape the web client already sends to
 * live servers (web/src/store/contacts.ts); individuals are then selected on
 * what Principal/get returns - `type: "individual"` is how Stalwart names a
 * user account (source-checked 2026-09-07, crates/jmap/src/principal/get.rs;
 * re-verify against a live server with a dated comment per repo convention).
 *
 * Directory queries are gated server-side by `allow_directory_query` or the
 * JmapPrincipalQuery permission (crates/jmap/src/principal/query.rs). A
 * Gilbert administrator who is not also a Stalwart system administrator hits
 * that gate - observed live 2026-09-07, where the filtered form was refused
 * and the whole query is refused when the gate is closed. That is not a
 * failure of this surface: enumeration is a capability the server grants,
 * and the client degrades to typing an address. Roles are deliberately not
 * consulted - Stalwart exposes roles only through its own administration
 * surfaces, never over JMAP.
 */
export async function fetchDirectoryPrincipals(
  authorization: string,
  session: UpstreamSession,
  kind: "individual" | "group",
): Promise<{ principals: Array<{ id: string; name: string }> } | { denied: string }> {
  // The account that owns the principals capability, picked the way the
  // client picks it: the personal account advertising it, then any account
  // that does.
  const PRINCIPALS = "urn:ietf:params:jmap:principals";
  const accounts = Object.entries(session.accounts ?? {});
  const withCap = accounts.filter(([, a]) => {
    const account = a as { accountCapabilities?: Record<string, unknown> };
    return !!account.accountCapabilities?.[PRINCIPALS];
  });
  const personal =
    withCap.find(([, a]) => (a as { isPersonal?: unknown }).isPersonal === true) ??
    withCap[0];
  const accountId = personal?.[0] ?? accounts[0]?.[0];
  if (!accountId) return { principals: [] };

  const post = async (
    methodCalls: unknown[][],
  ): Promise<[string, Record<string, unknown>][]> => {
    const res = await fetch(absoluteUpstream(session.apiUrl), {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:principals"],
        methodCalls,
      }),
      signal: AbortSignal.timeout(config.upstreamTimeout),
    });
    if (!res.ok) {
      // Stalwart answers 400/403 when the directory gate is closed for this
      // session; degrade instead of failing the whole Users surface. The
      // upstream body rides along so a request-shape bug is diagnosable from
      // the endpoint's message instead of a bare status.
      const detail = (await res.text()).slice(0, 300);
      const why = detail ? `: ${detail}` : "";
      if (res.status === 400 || res.status === 403)
        throw new DirectoryQueryDenied(`HTTP ${res.status}${why}`);
      throw new Error(`directory query failed (HTTP ${res.status})${why}`);
    }
    const body = (await res.json()) as {
      methodResponses?: [string, Record<string, unknown>][];
    };
    return body.methodResponses ?? [];
  };

  const method = async (
    methodCalls: unknown[][],
    expected: string,
  ): Promise<Record<string, unknown>> => {
    const [name, body] = (await post(methodCalls))[0] ?? ["", {}];
    if (name !== expected)
      throw new DirectoryQueryDenied(
        String(body.description ?? body.type ?? "directory query refused"),
      );
    return body;
  };

  try {
    const query = await method(
      [["Principal/query", { accountId, limit: 1000 }, "q"]],
      "Principal/query",
    );
    const ids = (query.ids as string[] | undefined) ?? [];
    if (!ids.length) return { principals: [] };
    const got = await method(
      [
        [
          "Principal/get",
          { accountId, ids, properties: ["id", "type", "name", "email"] },
          "g",
        ],
      ],
      "Principal/get",
    );
    const list =
      (got.list as
        | Array<{ id?: string; type?: unknown; name?: unknown; email?: unknown }>
        | undefined) ?? [];
    const principals = list
      .filter((p) => p.type === kind)
      .map((p) => {
        const name = String(p.email ?? p.name ?? "")
          .trim()
          .toLowerCase();
        return typeof p.id === "string" && name ? { id: p.id, name } : null;
      })
      .filter((p): p is { id: string; name: string } => p !== null);
    return { principals };
  } catch (err) {
    if (err instanceof DirectoryQueryDenied) return { denied: err.message };
    throw err;
  }
}

export async function fetchDirectoryUsers(
  authorization: string,
  session: UpstreamSession,
): Promise<{ users: Array<{ id: string; name: string }> } | { denied: string }> {
  const result = await fetchDirectoryPrincipals(authorization, session, "individual");
  return "denied" in result ? { denied: result.denied } : { users: result.principals };
}

/** Group mailboxes on this server (for the admin group-labels surface). */
export async function fetchDirectoryGroups(
  authorization: string,
  session: UpstreamSession,
): Promise<{ groups: Array<{ id: string; name: string }> } | { denied: string }> {
  const result = await fetchDirectoryPrincipals(authorization, session, "group");
  return "denied" in result ? { denied: result.denied } : { groups: result.principals };
}

/** The directory gate closed on this session (see fetchDirectoryUsers). */
export class DirectoryQueryDenied extends Error {}

/**
 * Rewrite the upstream session so the browser talks to our same-origin proxy
 * endpoints instead of Stalwart directly (no CORS, no credentials in browser).
 */
export function localizeSession(
  s: UpstreamSession,
  extras: Record<string, unknown>,
): Record<string, unknown> {
  const caps = { ...s.capabilities };
  // We proxy push as Server-Sent Events; hide the upstream websocket endpoint.
  delete caps["urn:ietf:params:jmap:websocket"];
  return {
    ...s,
    capabilities: caps,
    apiUrl: "/api/jmap",
    downloadUrl: "/api/blob/{accountId}/{blobId}/{name}?accept={type}",
    uploadUrl: "/api/upload/{accountId}",
    eventSourceUrl: "/api/events?types={types}&closeafter={closeafter}&ping={ping}",
    ...extras,
  };
}

/** Resolve a possibly-relative upstream URL template against STALWART_URL. */
/**
 * Resolve a URL Stalwart handed us against the server we were configured to
 * talk to.
 *
 * Stalwart advertises absolute URLs in its session -- apiUrl, eventSourceUrl
 * and the rest -- built from its public hostname, which is always https. A
 * proxy that follows them takes every upstream call, and every held push
 * stream, out through the public route even when STALWART_URL names a private
 * plain-HTTP hop on the same network. Measured, that TLS leg is ~80 KiB of
 * native OpenSSL state per signed-in tab: 60% of what a tab costs, and the
 * whole difference between 1,665 and 3,680 tabs in 256 MiB.
 *
 * So by default only the path and query are taken from the advertised URL;
 * scheme, host and port come from the configured base. That is what a proxy
 * should have done all along -- the operator named the route on purpose.
 * STALWART_FOLLOW_ADVERTISED_URLS=1 restores the old behaviour for a setup
 * that genuinely needs to reach Stalwart at a different origin than the one
 * it was given.
 */
export function absoluteUpstream(url: string, base: string = config.stalwartUrl): string {
  try {
    const resolved = new URL(url, base);
    if (config.followAdvertisedUrls) return resolved.toString();
    const pinned = new URL(base);
    pinned.pathname = resolved.pathname;
    pinned.search = resolved.search;
    pinned.hash = "";
    return pinned.toString();
  } catch {
    return url;
  }
}

export function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) =>
    encodeURIComponent(vars[k] ?? ""),
  );
}
