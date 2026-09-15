/**
 * The installation's own configuration, as one document.
 *
 * Today the installation is its environment: `config.ts` reads around
 * twenty-five variables and every one of them is lost when the container is
 * replaced. This module is the other half of the decision that a redeploy must
 * lose nothing — the installation's configuration is **one document in
 * Stalwart**, in the Master account's own `gilbert` app folder, written whole
 * and read at boot after the server has signed in as the Master.
 *
 * Three classes of value, and this document holds the third:
 *
 * - **The handshake** (`STALWART_URL`, `GILBERT_AGENT_ADDRESS`,
 *   `GILBERT_AGENT_PASSWORD`) has no default and cannot live here: it is how
 *   Stalwart is reached, and this document lives in Stalwart. See
 *   `bootstrap.ts`.
 * - **The container's own facts** (`HOST`, `PORT`, `IMMUTABLE`) describe the
 *   process that happens to be running rather than the installation: which
 *   interface to bind, which port the orchestrator mapped, whether the root
 *   filesystem is read-only. They stay in the environment, with defaults.
 * - **Everything else** is here, and is the majority.
 *
 * Each default below names the variable it replaces and the value that
 * variable falls back to today, so a reader can check the translation field by
 * field against `config.ts` rather than taking it on trust.
 *
 * The document carries a `version` (the schema this build writes) and an
 * `epoch` (bumped by every write, and the value a conditional write compares
 * against) because a whole-document write with no token is a lost update: two
 * administrators editing in two tabs would each write a document without the
 * other's change, and both would be told they saved.
 *
 * It is shared with the web tier (`@gilbert/shared/installation`), which reads
 * the same shape: one definition, so the surface that will edit this document
 * and the server that boots from it cannot drift into two ideas of what an
 * installation is.
 */

/** The document's name inside the Master account's `gilbert` app folder. */
export const INSTALLATION_FILE = "installation.json";

/** The schema this build writes and reads. A document of another version is refused. */
export const INSTALLATION_VERSION = 1;

/** The epoch a newly created document starts at. Every write takes the next one. */
export const INSTALLATION_EPOCH_START = 1;

/** Where the app tier answers. `host`/`port` are overridable by the container (see below). */
export interface InstallationServer {
  /** `HOST` (default `0.0.0.0`). */
  host: string;
  /** `PORT` (default `8080`). */
  port: number;
  /** `TRUST_PROXY` (default `true`). */
  trustProxy: boolean;
  /** `TRUSTED_PROXIES` (default `[]` = loopback and the private ranges). */
  trustedProxies: string[];
  /**
   * `SECURE_COOKIES` (default `"auto"`): `"auto"` = Secure when the request
   * arrived over https, `"1"`/`"true"` and `"0"`/`"false"` to force.
   */
  secureCookies: string;
  /** `COMPRESS_JMAP` (default `true`): whether JMAP responses are gzipped. */
  compressJmap: boolean;
  /**
   * `COOKIE_NAME` (default `"gilbert_session"`): the name of the session cookie.
   *
   * The installation decides it because it is a name this installation's own
   * users' browsers carry: a deployment sharing a host or a parent domain with
   * something else names it so the two cannot collide.
   */
  cookieName: string;
}

/** The bounds on what one request may cost. */
export interface InstallationLimits {
  /** `UPSTREAM_TIMEOUT` (default `30000`): ms before a Stalwart request is abandoned. */
  upstreamTimeout: number;
  /** `MAX_UPLOAD_BYTES` (default `52428800`, 50 MiB). */
  maxUploadBytes: number;
  /** `IMAGE_PROXY` (default `true`): whether the image proxy answers at all. */
  imageProxy: boolean;
  /** `LOGIN_RATE_LIMIT` (default `10`): sign-in attempts per window per client. */
  loginRateLimit: number;
  /**
   * `API_RATE_LIMIT` (default `1200`): requests per minute one session may make
   * on the data path -- JMAP, blobs, the image and calendar proxies. 0 disables
   * it. The proxy is one Node process, so without this a single signed-in user
   * can deny service to everyone else.
   */
  apiRateLimit: number;
}

/** How long a sealed session lives. */
export interface InstallationSessions {
  /** `SESSION_TTL` (default `43200`, 12 h). */
  ttl: number;
  /** `SESSION_REMEMBER_TTL` (default `2592000`, 30 days). */
  rememberTtl: number;
}

/** How push reaches the browser. */
export interface InstallationPush {
  /**
   * `PUSH_MODE` (default `"subscribe"`): `"subscribe"` registers one JMAP
   * PushSubscription per account and fans Stalwart's POSTs out to that
   * account's tabs; `"relay"` holds one upstream stream per tab.
   */
  mode: "relay" | "subscribe";
  /** `RAW_PUSH_RELAY` (default `true`): pipe the relay socket-to-socket. */
  rawRelay: boolean;
}

/**
 * The agent worker (ADR 0003): the installation's own fleet.
 *
 * One switch that would fit here is deliberately not here: whether the model
 * may sit inside the deployment's own network.
 * `GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER` is the **operator's** statement, read
 * from the environment in `configuration.ts` and nowhere else, because an
 * installation must not grant itself the right to aim its model at the network
 * the deployment runs in. A document that still carries
 * `agent.allowPrivateProvider` is read as though it did not -- see
 * `parseInstallationDocumentDetailed` -- so the retired key neither decides
 * anything nor makes the document unreadable.
 */
export interface InstallationAgent {
  /** `GILBERT_AGENT_POLL_MS` (default `60000`): the fallback after a lost push stream. */
  poll: number;
  /** `GILBERT_AGENT_HEARTBEAT_MS` (default `30000`). */
  heartbeat: number;
  /** `GILBERT_AGENT_LEASE_MS` (default `180000`): how long a claim may go un-renewed. */
  lease: number;
  /** `GILBERT_AGENT_MAX_CHAIN_HOPS` (default `5`): hops before an automation chain is refused. */
  chainHops: number;
  /** `GILBERT_AGENT_MAX_PAGES` (default `8`, `AGENT_MAX_PAGES_DEFAULT`). */
  pages: number;
  /** `GILBERT_AGENT_THINKING` (default `true`): whether a run pays for the model's reasoning. */
  thinking: boolean;
  /** `GILBERT_AGENT_VISION` (default `true`): whether the installation's model reads images. */
  vision: boolean;
  /** `GILBERT_AGENT_AUTHORING_MAX_PER_MONTH` (default `200`) readings a month. */
  authoringMaxPerMonth: number;
  /** `GILBERT_AGENT_HEALTH_PORT` (default `0` = no endpoint). */
  healthPort: number;
  /** `GILBERT_AGENT_INPROCESS` (default `true`): whether the server starts the fleet itself. */
  inProcess: boolean;
}

/** What the installation calls itself. */
export interface InstallationBranding {
  /** `APP_NAME` (default `"Gilbert"`). */
  appName: string;
}

/**
 * The installation's configuration, one document.
 *
 * `secret` is the app secret (`APP_SECRET`): the key sealed sessions and
 * derived keys are built from. It is **generated** on the first boot and
 * written here, because a secret on the container is a secret a redeploy
 * loses, and sessions that cannot be read after a redeploy are the very thing
 * this document exists to prevent. Nothing in this repository carries a
 * literal value for it: an empty or placeholder secret is refused rather than
 * used.
 */
export interface InstallationDocument {
  /** The schema version; `INSTALLATION_VERSION` today. */
  version: number;
  /** Bumped by every write. A writer compares the epoch it read against this. */
  epoch: number;
  server: InstallationServer;
  limits: InstallationLimits;
  sessions: InstallationSessions;
  push: InstallationPush;
  /**
   * Which Stalwart a domain signs in to: domain (lower-cased, no root dot) to
   * base URL. Empty means one server, `STALWART_URL`.
   */
  upstreams: Record<string, string>;
  agent: InstallationAgent;
  branding: InstallationBranding;
  /** `APP_SECRET`. Generated on the first boot; see the note above. */
  secret: string;
}

/**
 * How many pages of a rasterised document one run may read, by default: the one
 * definition, used by the document's own defaults and by
 * `AGENT_MAX_PAGES_DEFAULT` in `server/src/agent/documents.ts`.
 */
export const AGENT_PAGES_DEFAULT = 8;

/**
 * The defaults: the values the code uses today, and the variable each replaces.
 *
 * A fresh copy every call, so a caller that edits the document it is about to
 * write cannot edit every later reader's idea of the defaults.
 */
export function installationDefaults(): InstallationDocument {
  return {
    version: INSTALLATION_VERSION,
    epoch: INSTALLATION_EPOCH_START,
    server: {
      // HOST's default in `config.ts`; the container's own fact, so the
      // environment still overrides this when it is set (see bootstrap.ts).
      host: "0.0.0.0",
      port: 8080, // PORT
      trustProxy: true, // TRUST_PROXY
      trustedProxies: [], // TRUSTED_PROXIES ("" = loopback and the private ranges)
      secureCookies: "auto", // SECURE_COOKIES
      compressJmap: true, // COMPRESS_JMAP (`"0"` turned it off)
      cookieName: "gilbert_session", // COOKIE_NAME
    },
    limits: {
      upstreamTimeout: 30_000, // UPSTREAM_TIMEOUT
      maxUploadBytes: 50 * 1024 * 1024, // MAX_UPLOAD_BYTES
      imageProxy: true, // IMAGE_PROXY
      loginRateLimit: 10, // LOGIN_RATE_LIMIT
      apiRateLimit: 1200, // API_RATE_LIMIT (0 turns the limiter off)
    },
    sessions: {
      ttl: 12 * 60 * 60, // SESSION_TTL
      rememberTtl: 30 * 24 * 60 * 60, // SESSION_REMEMBER_TTL
    },
    push: {
      mode: "subscribe", // PUSH_MODE (only an explicit "relay" used the relay)
      rawRelay: true, // RAW_PUSH_RELAY (`"0"` turned it off)
    },
    upstreams: {},
    agent: {
      poll: 60_000, // GILBERT_AGENT_POLL_MS
      heartbeat: 30_000, // GILBERT_AGENT_HEARTBEAT_MS
      lease: 180_000, // GILBERT_AGENT_LEASE_MS
      chainHops: 5, // GILBERT_AGENT_MAX_CHAIN_HOPS (floored at 1)
      pages: AGENT_PAGES_DEFAULT, // GILBERT_AGENT_MAX_PAGES (floored at 1)
      thinking: true, // GILBERT_AGENT_THINKING
      vision: true, // GILBERT_AGENT_VISION
      authoringMaxPerMonth: 200, // GILBERT_AGENT_AUTHORING_MAX_PER_MONTH
      healthPort: 0, // GILBERT_AGENT_HEALTH_PORT
      inProcess: true, // GILBERT_AGENT_INPROCESS
    },
    branding: {
      appName: "Gilbert", // APP_NAME
    },
    secret: "", // APP_SECRET — generated on the first boot, never a literal
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The domains and URLs of the routing table, checked the way `config.ts` checked them. */
function readUpstreams(
  where: string,
  v: unknown,
  fallback: Record<string, string>,
  problems: string[],
): Record<string, string> {
  if (v === undefined || v === null) return fallback;
  if (!isRecord(v)) {
    problems.push(`"${where}" must be an object of domain to URL.`);
    return fallback;
  }
  const out: Record<string, string> = {};
  for (const [rawDomain, rawUrl] of Object.entries(v)) {
    // Lower-cased and stripped of the root dot, because that is how a domain
    // taken off a username arrives and comparing them any other way means a
    // mapping that silently never matches.
    const domain = rawDomain.trim().toLowerCase().replace(/\.$/, "");
    if (!domain) {
      problems.push(`"${where}" has an empty domain key.`);
      continue;
    }
    if (domain in out) {
      problems.push(`"${where}.${domain}" appears twice once normalised.`);
      continue;
    }
    if (typeof rawUrl !== "string") {
      problems.push(`"${where}.${domain}" is not a URL.`);
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      problems.push(`"${where}.${domain}" is not an absolute URL.`);
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      problems.push(`"${where}.${domain}" must be http or https.`);
      continue;
    }
    out[domain] = rawUrl.replace(/\/+$/, "");
  }
  return out;
}

/**
 * Parse one installation document.
 *
 * Strict JSON; an object at the top; every declared field checked where it is
 * present. A field that is **absent** takes the default — a document written by
 * an older build, or edited by hand to state only what the operator cares
 * about, is a document rather than a fault. A field that is **present and
 * wrong** is a problem, never a silent fallback: a typo'd `port` that quietly
 * became 8080 is how an installation ends up answering somewhere nobody
 * expects. Unknown keys are ignored, as every other document reader here
 * ignores them: a key this build does not know -- one a newer build added, or a
 * retired one such as `agent.allowPrivateProvider`, which is the operator's and
 * is read from the environment -- decides nothing and does not refuse the
 * document, so an installation that still carries one keeps booting and a later
 * publish drops it.
 *
 * A `version` this build does not know is refused. That is what the field is
 * for: a document written by a newer Gilbert may carry a field whose meaning
 * changed, and reading it as though it had not is worse than not starting.
 */
export function parseInstallationDocumentDetailed(
  raw: string,
): { doc: InstallationDocument } | { problem: string } {
  let whole: unknown;
  try {
    whole = JSON.parse(raw);
  } catch (err) {
    const where = err instanceof Error ? ` (${err.message})` : "";
    return { problem: `Not valid JSON${where}.` };
  }
  if (!isRecord(whole)) return { problem: "The document must be a JSON object." };

  const defaults = installationDefaults();
  const problems: string[] = [];

  const readInt = (where: string, v: unknown, fallback: number): number => {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      problems.push(`"${where}" must be an integer.`);
      return fallback;
    }
    return v;
  };
  const readBool = (where: string, v: unknown, fallback: boolean): boolean => {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "boolean") {
      problems.push(`"${where}" must be true or false.`);
      return fallback;
    }
    return v;
  };
  const readText = (where: string, v: unknown, fallback: string): string => {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "string") {
      problems.push(`"${where}" must be a string.`);
      return fallback;
    }
    return v;
  };
  /** A section that is there, but not an object: the whole section is refused. */
  const readSection = (where: string, v: unknown): Record<string, unknown> => {
    if (v === undefined || v === null) return {};
    if (!isRecord(v)) {
      problems.push(`"${where}" must be an object.`);
      return {};
    }
    return v;
  };
  /** A bound floored at 1: a document that says 0 says nothing useful. */
  const readBound = (where: string, v: unknown, fallback: number): number => {
    const n = readInt(where, v, fallback);
    if (n < 1) {
      problems.push(`"${where}" must be at least 1.`);
      return fallback;
    }
    return n;
  };

  const server = readSection("server", whole.server);
  const limits = readSection("limits", whole.limits);
  const sessions = readSection("sessions", whole.sessions);
  const push = readSection("push", whole.push);
  const agent = readSection("agent", whole.agent);
  const branding = readSection("branding", whole.branding);

  const version = readInt("version", whole.version, INSTALLATION_VERSION);
  if (version !== INSTALLATION_VERSION)
    problems.push(
      `"version" is ${version}; this build reads version ${INSTALLATION_VERSION}.`,
    );
  const port = readInt("server.port", server.port, defaults.server.port);
  if (port < 1 || port > 65535)
    problems.push(`"server.port" must be between 1 and 65535 (it is ${port}).`);
  const mode = readText("push.mode", push.mode, defaults.push.mode);
  if (mode !== "relay" && mode !== "subscribe")
    problems.push(`"push.mode" must be "relay" or "subscribe".`);
  const appName = readText(
    "branding.appName",
    branding.appName,
    defaults.branding.appName,
  );
  if (!appName.trim()) problems.push(`"branding.appName" must not be empty.`);
  const trustedProxies = server.trustedProxies;
  if (
    trustedProxies !== undefined &&
    trustedProxies !== null &&
    (!Array.isArray(trustedProxies) || trustedProxies.some((p) => typeof p !== "string"))
  )
    problems.push(`"server.trustedProxies" must be a list of addresses.`);
  const cookieName = readText(
    "server.cookieName",
    server.cookieName,
    defaults.server.cookieName,
  );
  if (!cookieName.trim())
    problems.push(
      `"server.cookieName" must not be empty: sessions are held in that cookie, so a nameless one would sign nobody in.`,
    );

  const doc: InstallationDocument = {
    version,
    epoch: readInt("epoch", whole.epoch, defaults.epoch),
    server: {
      host: readText("server.host", server.host, defaults.server.host),
      port,
      trustProxy: readBool(
        "server.trustProxy",
        server.trustProxy,
        defaults.server.trustProxy,
      ),
      trustedProxies: Array.isArray(trustedProxies)
        ? trustedProxies
            .filter((p): p is string => typeof p === "string")
            .map((p) => p.trim())
        : defaults.server.trustedProxies,
      secureCookies: readText(
        "server.secureCookies",
        server.secureCookies,
        defaults.server.secureCookies,
      ),
      compressJmap: readBool(
        "server.compressJmap",
        server.compressJmap,
        defaults.server.compressJmap,
      ),
      cookieName,
    },
    limits: {
      upstreamTimeout: readInt(
        "limits.upstreamTimeout",
        limits.upstreamTimeout,
        defaults.limits.upstreamTimeout,
      ),
      maxUploadBytes: readInt(
        "limits.maxUploadBytes",
        limits.maxUploadBytes,
        defaults.limits.maxUploadBytes,
      ),
      imageProxy: readBool(
        "limits.imageProxy",
        limits.imageProxy,
        defaults.limits.imageProxy,
      ),
      loginRateLimit: readInt(
        "limits.loginRateLimit",
        limits.loginRateLimit,
        defaults.limits.loginRateLimit,
      ),
      apiRateLimit: readInt(
        "limits.apiRateLimit",
        limits.apiRateLimit,
        defaults.limits.apiRateLimit,
      ),
    },
    sessions: {
      ttl: readInt("sessions.ttl", sessions.ttl, defaults.sessions.ttl),
      rememberTtl: readInt(
        "sessions.rememberTtl",
        sessions.rememberTtl,
        defaults.sessions.rememberTtl,
      ),
    },
    push: {
      mode: mode === "relay" ? "relay" : "subscribe",
      rawRelay: readBool("push.rawRelay", push.rawRelay, defaults.push.rawRelay),
    },
    upstreams: readUpstreams("upstreams", whole.upstreams, defaults.upstreams, problems),
    agent: {
      poll: readInt("agent.poll", agent.poll, defaults.agent.poll),
      heartbeat: readInt("agent.heartbeat", agent.heartbeat, defaults.agent.heartbeat),
      lease: readInt("agent.lease", agent.lease, defaults.agent.lease),
      chainHops: readBound("agent.chainHops", agent.chainHops, defaults.agent.chainHops),
      pages: readBound("agent.pages", agent.pages, defaults.agent.pages),
      thinking: readBool("agent.thinking", agent.thinking, defaults.agent.thinking),
      vision: readBool("agent.vision", agent.vision, defaults.agent.vision),
      authoringMaxPerMonth: readInt(
        "agent.authoringMaxPerMonth",
        agent.authoringMaxPerMonth,
        defaults.agent.authoringMaxPerMonth,
      ),
      healthPort: readInt(
        "agent.healthPort",
        agent.healthPort,
        defaults.agent.healthPort,
      ),
      inProcess: readBool("agent.inProcess", agent.inProcess, defaults.agent.inProcess),
    },
    branding: { appName },
    secret: readText("secret", whole.secret, defaults.secret),
  };

  if (problems.length) return { problem: problems.join(" ") };
  return { doc };
}

/** The parsed document, or null when it is not one. */
export function parseInstallationDocument(raw: string): InstallationDocument | null {
  const result = parseInstallationDocumentDetailed(raw);
  return "problem" in result ? null : result.doc;
}

/**
 * The value a secret may not be.
 *
 * `"change-me"` is the placeholder `config.ts` treats as "not set", and the
 * reason it is named here is that a document is hand-editable: a copy of an
 * example file that still says `change-me` must be refused, not signed with.
 * Empty is the same thing said by absence.
 */
export const PLACEHOLDER_APP_SECRET = "change-me";

/** Whether a stored secret can be a key at all. */
export function isUsableAppSecret(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value !== PLACEHOLDER_APP_SECRET;
}
