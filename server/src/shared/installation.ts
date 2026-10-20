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
 * Each default below names the variable it replaces, and they are not only the
 * document's: `configuration.ts` reads the environment *over* this object
 * (`installationDefaults()`), so a value the environment is silent about is the
 * one stated here. That is what keeps a process with no boot and an
 * installation that has just created its document describing the same
 * installation, and it is why these literals live here rather than in a copy
 * beside the environment's reader.
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

import { errorDetail } from "./errors.js";
import { isRecord } from "./json.js";

/** The document's name inside the Master account's `gilbert` app folder. */
export const INSTALLATION_FILE = "installation.json";

/** The schema this build writes and reads. A document of another version is refused. */
export const INSTALLATION_VERSION = 1;

/** The epoch a newly created document starts at. Every write takes the next one. */
export const INSTALLATION_EPOCH_START = 1;

/** Where the app tier answers. `host`/`port` are overridable by the container (see below). */
interface InstallationServer {
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
   * `ADMINISTRATION` (default `true`): whether this installation offers
   * administration to accounts whose Stalwart role allows it. Off means off --
   * no menu, and the JMAP proxy refuses registry methods beyond the account's
   * own (ADR 0015, `adminGate.ts`). Stalwart's own interface is unaffected
   * either way.
   */
  administration: boolean;
  /**
   * `ADMINISTRATION_NEEDS_OWN_DEVICE` (default `false`): whether administration
   * additionally requires the session to have been signed in on a device marked
   * as its owner's. Off, a session administers wherever it was opened, which is
   * what every installation did before this rule existed. Off by default
   * because the sign-in form's box is about how long a session lasts, and a
   * shorter session is not a less trusted one: an installation that wants the
   * rule states it.
   */
  administrationNeedsOwnDevice: boolean;
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
interface InstallationLimits {
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
interface InstallationSessions {
  /** `SESSION_TTL` (default `43200`, 12 h). */
  ttl: number;
  /** `SESSION_REMEMBER_TTL` (default `2592000`, 30 days). */
  rememberTtl: number;
}

/** How push reaches the browser. */
interface InstallationPush {
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
 * The one model an installation runs on (ADR 0027).
 *
 * Provider, model, an OpenAI-compatible base URL and a key. One model serves
 * the whole installation — which model a kind of work deserves is not a
 * question the administration is asked — and an installation with no provider
 * here has no agent. It is chosen in Administration and stored in the
 * installation's own document (ADR 0009), which is why it lives here rather
 * than in a second document of its own.
 *
 * The key is **write-only**: `apiKey` is stored so a call can carry it, and the
 * administration never reads it back (`installationAdmin.ts` masks it in what
 * the read returns, and a publish that states none keeps the stored one). An
 * empty key is a provider that needs none — a model on the deployment's own
 * network, say — and is not the same as no provider at all.
 *
 * A publish of the document states which of the three it means: an absent or
 * empty key says nothing about the stored one and keeps it, `null` asks for a
 * provider that needs none and the door stores it empty, and a value is the key
 * to write. A reader of the document is never handed the key.
 */
export interface InstallationModel {
  /** A free name for the surface: "openai", "openrouter", "ollama", … */
  provider: string;
  model: string;
  /** The OpenAI-compatible base URL the calls are posted to. */
  baseUrl: string;
  /** The key the calls carry; empty when the provider needs none. */
  apiKey: string;
}

/**
 * The agent's own section of the installation's document (ADR 0027).
 *
 * Two things live here: the model the installation runs on, and the line of
 * prose its agent carries into every call. The section is kept rather than
 * folded into `branding` because the record names it (ADR 0009) and because the
 * agent's configuration is its own subject.
 */
interface InstallationAgentSection {
  /** The installation's model, or absent when it has none and therefore no agent. */
  provider?: InstallationModel;
  /**
   * The installation's own line of prose, carried into every call (ADR 0031):
   * what whoever runs it wants its agent to work by, above every group's
   * standing instruction and every rule. Absent says nothing, and a level that
   * says nothing contributes nothing to the prompt.
   */
  instruction?: string;
}

/** What the installation calls itself. */
interface InstallationBranding {
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
  agent: InstallationAgentSection;
  branding: InstallationBranding;
  /** `APP_SECRET`. Generated on the first boot; see the note above. */
  secret: string;
}

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
      administration: true, // ADMINISTRATION (`"0"` turns it off)
      administrationNeedsOwnDevice: false, // ADMINISTRATION_NEEDS_OWN_DEVICE
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
    // No model: an installation that has chosen none has no agent (ADR 0027).
    // What a provider is, and that its key is write-only, is `InstallationModel`.
    agent: {},
    branding: {
      appName: "Gilbert", // APP_NAME
    },
    secret: "", // APP_SECRET — generated on the first boot, never a literal
  };
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
 * retired one -- decides nothing and does not refuse the document, so an
 * installation that still carries one keeps booting and a later publish drops
 * it. The operator's own switch over which model may be reached
 * (`GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER`) is absent here for that same reason
 * and one more: it is read from the environment and nowhere else, because an
 * installation must not grant itself the right to aim its model at the network
 * the deployment runs in (ADR 0009).
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
    const where = errorDetail(err);
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
  /** A whole number at least `min`; a value below it is refused, not kept. */
  const readAtLeast = (
    where: string,
    v: unknown,
    fallback: number,
    min: number,
  ): number => {
    const n = readInt(where, v, fallback);
    if (n < min) {
      problems.push(`"${where}" must be at least ${min}.`);
      return fallback;
    }
    return n;
  };

  /** One required, non-empty text field of a nested object. */
  const readTextIn = (where: string, v: unknown): string => {
    if (typeof v !== "string" || !v.trim()) {
      problems.push(`"${where}" must be text.`);
      return "";
    }
    return v;
  };
  /**
   * The installation's model, or undefined when it has none.
   *
   * A provider that is there must name the three things a call needs — the
   * provider, the model and the base URL — and may carry a key or not, since a
   * model inside the deployment's own network needs none. Whether the address
   * may be used at all is the call's question and not this parser's: the test
   * is `net`'s (the agent's `assertUsableProvider`), and this module is also
   * read where `net` is not.
   */
  const readProvider = (v: unknown): InstallationModel | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!isRecord(v)) {
      problems.push(`"agent.provider" must be an object.`);
      return undefined;
    }
    const provider = readTextIn("agent.provider.provider", v.provider);
    const model = readTextIn("agent.provider.model", v.model);
    const baseUrl = readTextIn("agent.provider.baseUrl", v.baseUrl);
    const apiKey = v.apiKey === undefined || v.apiKey === null ? "" : v.apiKey;
    if (typeof apiKey !== "string") {
      problems.push(`"agent.provider.apiKey" must be a string.`);
      return undefined;
    }
    if (!provider || !model || !baseUrl) return undefined;
    return { provider, model, baseUrl, apiKey };
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

  const provider = readProvider(agent.provider);
  if (agent.instruction !== undefined && typeof agent.instruction !== "string")
    problems.push(`"agent.instruction" must be text.`);
  const instruction =
    typeof agent.instruction === "string" ? agent.instruction.trim() : "";
  const doc: InstallationDocument = {
    version,
    epoch: readAtLeast("epoch", whole.epoch, defaults.epoch, 1),
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
      administration: readBool(
        "server.administration",
        server.administration,
        defaults.server.administration,
      ),
      administrationNeedsOwnDevice: readBool(
        "server.administrationNeedsOwnDevice",
        server.administrationNeedsOwnDevice,
        defaults.server.administrationNeedsOwnDevice,
      ),
      cookieName,
    },
    limits: {
      upstreamTimeout: readAtLeast(
        "limits.upstreamTimeout",
        limits.upstreamTimeout,
        defaults.limits.upstreamTimeout,
        1,
      ),
      maxUploadBytes: readAtLeast(
        "limits.maxUploadBytes",
        limits.maxUploadBytes,
        defaults.limits.maxUploadBytes,
        1,
      ),
      imageProxy: readBool(
        "limits.imageProxy",
        limits.imageProxy,
        defaults.limits.imageProxy,
      ),
      loginRateLimit: readAtLeast(
        "limits.loginRateLimit",
        limits.loginRateLimit,
        defaults.limits.loginRateLimit,
        1,
      ),
      apiRateLimit: readAtLeast(
        "limits.apiRateLimit",
        limits.apiRateLimit,
        defaults.limits.apiRateLimit,
        0,
      ),
    },
    sessions: {
      ttl: readAtLeast("sessions.ttl", sessions.ttl, defaults.sessions.ttl, 1),
      rememberTtl: readAtLeast(
        "sessions.rememberTtl",
        sessions.rememberTtl,
        defaults.sessions.rememberTtl,
        1,
      ),
    },
    push: {
      mode: mode === "relay" ? "relay" : "subscribe",
      rawRelay: readBool("push.rawRelay", push.rawRelay, defaults.push.rawRelay),
    },
    upstreams: readUpstreams("upstreams", whole.upstreams, defaults.upstreams, problems),
    // A provider that is there is kept whole, and so is a line of prose; a
    // section with neither drops the key rather than carrying an `undefined`
    // one, so a document read and written back is the same document.
    agent: {
      ...(provider ? { provider } : {}),
      ...(instruction ? { instruction } : {}),
    },
    branding: { appName },
    secret: readText("secret", whole.secret, defaults.secret),
  };

  if (problems.length) return { problem: problems.join(" ") };
  return { doc };
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

/**
 * What the administration's read answers (`routes/installation.ts`).
 *
 * The route and its client are one contract, so the shape lives here, beside the
 * document it describes, rather than being written once on each side.
 */
export interface InstallationView {
  /** Whether the account holds a document at all. */
  present: boolean;
  /**
   * The document as it is stored, or null when there is none — with the model's
   * key **taken out** of every document this module can read as JSON
   * (`withoutProviderKey`), because the key is write-only: it is stored so a
   * call can carry it, and no read hands it back. A document that is not JSON is
   * the exception, handed back byte for byte so a person can repair it. A
   * publish that says nothing about the key — the field absent or empty — is
   * what keeps the stored one, which is why the field is absent here rather than
   * empty: a text handed back as it was read states nothing about the key.
   */
  document: string | null;
  /**
   * Why a boot would refuse the stored document, or null when it would not.
   *
   * The judgement is the boot's own (`installation.ts`'s reader): the text is
   * not a document, or it carries no app secret. The text is still handed back
   * with it — a document that cannot be read is exactly the one a person has
   * to repair, and hiding it would leave the editor as the only place it
   * exists.
   */
  problem: string | null;
  /** The Files account whose app folder holds it — the Master's own, reached by impersonation. */
  account: string;
  /** The address that account belongs to: the Master whose own document a boot reads. */
  master: string;
  /** Where it is, in words: `gilbert/installation.json in account …`. */
  location: string;
}

/** What a publish wrote, and when it applies. */
export interface InstallationPublished {
  /** The Files account whose app folder now holds the document. */
  account: string;
  /** The address that account belongs to: the Master whose own document a boot reads. */
  master: string;
  /** Where that is, in words. */
  location: string;
  /** The document as it is now stored: byte for byte what the next read returns. */
  document: string;
  /** The epoch the stored document carries. Every write takes the next one. */
  epoch: number;
  /**
   * When it takes effect: the document is read at boot, so a publish is never
   * live in the process that made it.
   */
  applies: "next-boot";
  /** The same answer as one sentence, for the surface to show as it is. */
  message: string;
}
