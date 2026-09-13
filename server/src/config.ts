import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBasePath } from "../../scripts/basePath.mjs";
import { resolveVersion } from "../../scripts/version.mjs";
import { AGENT_MAX_PAGES_DEFAULT } from "./agent/documents.js";

/** Minimal .env loader (no dependency): first match wins, never overrides real env. */
function loadDotEnv() {
  const candidates = [
    resolve(process.cwd(), ".env"),
    fileURLToPath(new URL("../../.env", import.meta.url)),
    fileURLToPath(new URL("../.env", import.meta.url)),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      let v = m[2]!;
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      )
        v = v.slice(1, -1);
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = v;
    }
    break;
  }
}
loadDotEnv();

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined)
      throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}: ${v}`);
  return n;
}

const isProd = process.env.NODE_ENV === "production";
let appSecret = process.env.APP_SECRET ?? "";
if (!appSecret || appSecret === "change-me") {
  if (isProd) {
    throw new Error("APP_SECRET must be set to a strong random value in production");
  }
  appSecret = randomBytes(32).toString("base64");
  console.warn(
    "[gilbert] APP_SECRET not set - using an ephemeral secret (persisted sessions will not survive restarts)",
  );
}

const stalwartUrl = env("STALWART_URL", "https://mail.example.com").replace(/\/+$/, "");

/**
 * Declares that this instance is running as an immutable container: read-only
 * root filesystem, nothing durable of its own, replaceable by its image.
 *
 * It is a claim the process checks rather than one it takes on trust, because
 * the failure it guards against is silent. Setting the variable while
 * forgetting `--read-only` is the easy mistake, and an instance that believed
 * it would look healthy while keeping whatever it wrote where the next image
 * will not find it. Nothing Gilbert holds durably lives on this filesystem any
 * more — the sessions, the policy, the lock and the agent's records are all
 * documents in Stalwart — so what is left to check is the property itself.
 */
const immutable = bool("IMMUTABLE", false);

/**
 * Refuse to run when the promise IMMUTABLE makes is not one this instance can
 * keep. Exported so it can be tested without a read-only filesystem to hand.
 */
export function assertImmutable(root: string): void {
  /*
   * The property itself, not the intention to have it: a probe written and
   * removed, because a variable set while `--read-only` was forgotten would
   * leave an instance claiming a guarantee it does not have.
   */
  const probe = resolve(root, ".immutable-probe");
  let writable = false;
  try {
    writeFileSync(probe, "");
    writable = true;
    unlinkSync(probe);
  } catch {
    /* EROFS, or EACCES on a root we do not own: either way, not writable by us */
  }
  if (writable) {
    throw new Error(
      `IMMUTABLE is set, but ${root} is writable. Run the container with --read-only (and --tmpfs /tmp), or unset IMMUTABLE.`,
    );
  }
}

if (immutable) assertImmutable(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Which Stalwart a domain signs in to.
 *
 * `STALWART_URL` stays required and stays the default; this only adds domains
 * that go somewhere else (#238). An installation that sets nothing behaves
 * exactly as it always has.
 *
 * Read once at boot and never written, so it mounts read-only and costs
 * nothing in immutability -- the same shape as the settings policy.
 *
 * Servers are deliberately **not** probed here. A mapping is a routing table,
 * not a health check, and refusing to boot because one of five customers is
 * having an outage would take the other four down with it. What happens when
 * one is unreachable is a sign-in question, answered in #239.
 */
function readStalwartServers(): Record<string, string> {
  const file = process.env.STALWART_SERVERS_FILE;
  if (!file) return {};
  if (!existsSync(file)) throw new Error(`STALWART_SERVERS_FILE does not exist: ${file}`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Invalid STALWART_SERVERS_FILE (${file}): ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Invalid STALWART_SERVERS_FILE (${file}): expected an object of domain to URL`,
    );
  }

  const out: Record<string, string> = {};
  for (const [rawDomain, rawUrl] of Object.entries(raw as Record<string, unknown>)) {
    /* Lower-cased and stripped of the root dot, because that is how a domain
       taken off a username will arrive and comparing them any other way means
       a mapping that silently never matches. */
    const domain = rawDomain.trim().toLowerCase().replace(/\.$/, "");
    if (!domain)
      throw new Error(`Invalid STALWART_SERVERS_FILE (${file}): a domain key is empty`);
    if (domain in out)
      throw new Error(
        `Invalid STALWART_SERVERS_FILE (${file}): "${domain}" appears twice once normalised`,
      );
    if (typeof rawUrl !== "string")
      throw new Error(
        `Invalid STALWART_SERVERS_FILE (${file}): "${domain}" is not a URL`,
      );
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(
        `Invalid STALWART_SERVERS_FILE (${file}): "${domain}" is not an absolute URL`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `Invalid STALWART_SERVERS_FILE (${file}): "${domain}" must be http or https`,
      );
    }
    out[domain] = rawUrl.replace(/\/+$/, "");
  }
  return out;
}

/**
 * The agent worker's bootstrap (ADR 0003, v1 scope).
 *
 * One structure agent per installation -- `gilbert` -- and one secret for it:
 * the agent's own app password, which reaches exactly the accounts the
 * operator granted it. Both arrive in the environment of whoever starts the
 * process, which is the only place a secret belongs: nothing mints one,
 * nothing writes one to a file, and a deployment that replaces its container
 * carries the same two variables back.
 *
 * Both halves or neither, and neither is a reason to refuse to start: an
 * installation that carries no address, or an address with no password behind
 * it, comes up and says so on the surface that names the agent. The
 * administration is where an operator reads what is wrong and fixes it.
 */

/** One agent's bootstrap entry, from the environment. */
export interface AgentBootstrap {
  address: string;
  /** The account password the worker signs in with. Empty = no agent named. */
  password: string;
}

function resolveAgentBootstrap(): AgentBootstrap {
  const address = (process.env.GILBERT_AGENT_ADDRESS ?? "").trim().toLowerCase();
  const password = process.env.GILBERT_AGENT_PASSWORD ?? "";
  return { address, password };
}

/**
 * The agent worker's timing and health: the environment is what carries them,
 * and the environment cannot change under a running process, so they are read
 * once.
 */
const agentWorkerSettings = {
  /*
   * How often a worker re-reads an account it could not be pushed about.
   * Push is the wake-up and polling is the fallback after a lost stream, so
   * this is deliberately unhurried: a minute of latency on a lost stream is
   * far cheaper than a minute of hammering Stalwart.
   */
  pollMs: int("GILBERT_AGENT_POLL_MS", 60_000),
  /* How often a working worker says it is alive, in its claims and heartbeat. */
  heartbeatMs: int("GILBERT_AGENT_HEARTBEAT_MS", 30_000),
  /*
   * How long a claim may go un-renewed before another worker takes it over.
   * Longer than a few heartbeats on purpose: an agent's work can sit in a
   * model call or wait on a person, and a takeover that fires during a
   * legitimate pause would run the same job twice.
   */
  leaseMs: int("GILBERT_AGENT_LEASE_MS", 180_000),
  /*
   * Where the worker answers a health probe, or 0 for no endpoint at all.
   * A deployment with a restart policy wants this (ADR 0003 resolution 8);
   * a worker nobody asks anything needs no listening socket.
   */
  healthPort: int("GILBERT_AGENT_HEALTH_PORT", 0),
  /*
   * Whether the server starts a fleet of its own beside the web tier, which is
   * what makes `node server/dist/index.js` an installation that also works
   * (ADR 0003). A deployment that wants the fleet isolated — its own container,
   * its own restart policy — says `GILBERT_AGENT_INPROCESS=0` and runs
   * `node server/dist/agent/agent.js` itself.
   */
  inprocess: bool("GILBERT_AGENT_INPROCESS", true),
  /*
   * Whether a run pays for the model's chain of thought. The provider reasons
   * by default; a run that wants a cheaper, faster answer says so here, and an
   * agent that wants the careful one keeps the default. It is a parameter of
   * the agent rather than of a rule because a group is held by one agent at a
   * time — and every run records the setting it used beside the tokens it
   * spent, so a behaviour that changed with the machine that ran it is
   * readable rather than inferred (ADR 0003).
   */
  thinking: bool("GILBERT_AGENT_THINKING", true),
  /**
   * Whether this deployment may point the installation's model at an address
   * inside its own network — a model running on the same host, say.
   *
   * Off by default, and it is the **operator's** statement rather than a
   * document's: the configuration an installation writes is refused when it
   * names a private host, and this is what says the deployment meant one
   * (ADR 0003).
   */
  allowPrivateProvider: bool("GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER", false),
  /**
   * Whether the installation's model can read an image.
   *
   * True is the common case and the default; a deployment running a
   * text-only model says so, and then a run handed a page with no text layer is
   * told that the page could not be read rather than being told an image was
   * handed over (ADR 0003).
   */
  vision: bool("GILBERT_AGENT_VISION", true),
  /**
   * How many readings one installation may ask for in a month.
   *
   * A reading is a call the installation pays for and it is not a run, so no
   * job's ceiling bounds it: this is the bound, counted from the authoring
   * document of the month, and a reading past it is refused before it is made
   * (ADR 0003).
   */
  authoringMonthlyMax: int("GILBERT_AGENT_AUTHORING_MAX_PER_MONTH", 200),
  /*
   * How many pages one run may hand the model as images (ADR 0003). A page
   * whose own text layer is empty is rasterised in the process and read by the
   * model, and a document is as long as whoever sent it made it — so the count
   * is a bound the installation sets rather than one the file decides. The run
   * is told the number in its own prompt.
   */
  // Floored at one the same way the installation's own stored bound is
  // (`isAgentBound`): a deployment that sets this to 0 or a negative number
  // must not have every run refused as though it were over its chain bound
  // instead of under its page one — the two validators disagreeing was a
  // business logic review finding.
  maxPages: Math.max(1, int("GILBERT_AGENT_MAX_PAGES", AGENT_MAX_PAGES_DEFAULT)),
  /*
   * How many hops a chain of automations runs before the next one is refused
   * (ADR 0003). Hop one is the trigger that wakes a rule by itself, and a run
   * woken by another run's effect is one more; a cycle of automations that wake
   * each other ends here. The number is carried in the installation's
   * configuration rather than compiled in, so a deployment with a legitimately
   * longer pipeline raises it instead of waiting for a release.
   */
  // Floored at one the same way the installation's own stored bound is: a
  // deployment that sets this to 0 or a negative number would otherwise
  // refuse every run, even an unchained hop-one trigger, as though it were a
  // runaway chain (a business logic review finding).
  maxChainHops: Math.max(1, int("GILBERT_AGENT_MAX_CHAIN_HOPS", 5)),
};

/**
 * The installation's agent, as the running process holds it (ADR 0003).
 *
 * The environment cannot change under a running process, so this is resolved
 * once and never re-read: an operator who names a different agent, or gives it
 * a different secret, says so in the deployment and restarts it.
 */
const agent = { ...resolveAgentBootstrap(), ...agentWorkerSettings };

export const config = {
  isProd,
  appName: env("APP_NAME", "Gilbert"),
  /**
   * What this build calls itself: `2.16.57`. Set by the image build from
   * `--build-arg GILBERT_VERSION`, since `.dockerignore` keeps `.git` out of
   * the build context and nothing in there could work it out. A dev checkout
   * has git, so it falls back to asking; see `scripts/version.mjs`.
   */
  version: resolveVersion(),
  /**
   * Where this instance's source can be had, shown to everyone who reaches it.
   *
   * The AGPL asks whoever *runs* a modified version to offer that version's
   * source, not the one it was forked from -- so anyone deploying a patched
   * Gilbert should point this at their own tree.
   */
  sourceUrl: env("SOURCE_URL", "https://github.com/sequico/gilbert"),
  host: env("HOST", "0.0.0.0"),
  port: int("PORT", 8080),
  /**
   * The subpath this instance answers on: `/mail` for a proxy that maps
   * `https://example.com/mail/` here, and `""` -- the default -- for the root.
   *
   * The prefix is expected to arrive intact: a proxy that strips it before
   * forwarding should leave BASE_PATH unset, because then as far as this
   * process is concerned it *is* at the root. What must match is the web
   * build, which bakes the same variable into its asset URLs; a server that
   * strips a prefix the bundle still asks for serves an app that cannot load
   * its own scripts. `staticHandler` says so at the first request rather than
   * leaving a blank page to explain itself.
   */
  basePath: normalizeBasePath(process.env.BASE_PATH),
  stalwartUrl,
  stalwartServers: readStalwartServers(),
  appSecret,
  trustProxy: bool("TRUST_PROXY", true),
  /**
   * Peers whose X-Forwarded-* headers are believed. Empty falls back to
   * loopback and the private ranges, which covers the usual reverse proxy on
   * the same host or Docker network. A peer outside this is attributed by its
   * socket address whatever it claims.
   */
  trustedProxies: (process.env.TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** "auto" = Secure when the request arrived over https; "1"/"0" to force. */
  secureCookies: (process.env.SECURE_COOKIES ?? "auto").toLowerCase(),
  sessionTtl: int("SESSION_TTL", 12 * 60 * 60),
  sessionRememberTtl: int("SESSION_REMEMBER_TTL", 30 * 24 * 60 * 60),
  /** True when this instance has asserted, and verified, that it is immutable. */
  immutable,
  upstreamTimeout: int("UPSTREAM_TIMEOUT", 30_000),
  maxUploadBytes: int("MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
  imageProxy: bool("IMAGE_PROXY", true),
  cookieName: env("COOKIE_NAME", "ihm_session"),
  staticDir:
    process.env.STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
  loginRateLimit: int("LOGIN_RATE_LIMIT", 10),
  /*
   * Requests per minute one session may make on the data path -- JMAP, blobs,
   * the image and calendar proxies. The proxy is one Node process and saturates
   * a core at roughly 2,000 operations a second, so without this a single
   * signed-in user can deny service to everyone else. 1,200 a minute is twenty
   * a second sustained: well above what a busy tab does, and an order of
   * magnitude below where one tab starts to hurt the rest. 0 disables it.
   */
  apiRateLimit: int("API_RATE_LIMIT", 1200),
  /* Whether JMAP responses are gzipped. Measured: see the bake-off rerun. */
  compressJmap: process.env.COMPRESS_JMAP !== "0",
  /**
   * The `/api/account` permission that marks a Stalwart admin (ADR 0001).
   *
   * Live-verified 2026-09-09 on Stalwart 0.16.21: `sysAccountCreate` appears
   * in a principal's resolved permission list exactly when the operator
   * grants the admin role, and `sysBootstrap*` never appears (the endpoint
   * always strips it), so it is the non-forgeable marker to test for.
   */
  adminPermissionMarker: env("GILBERT_ADMIN_PERMISSION", "sysAccountCreate"),
  /*
   * How push reaches the browser. "relay" holds one upstream stream per tab.
   * "subscribe" registers one JMAP PushSubscription per account and fans
   * Stalwart's POSTs out to that account's tabs, holding no upstream connection
   * at all -- see push.ts. The origin Stalwart POSTs back to is derived from the
   * request (see pushOrigin in app.ts); an account we cannot state one for
   * stays on the relay.
   */
  /*
   * The agent worker (ADR 0003). Everything here is read-only configuration:
   * the documents the fleet works from live in Stalwart, in the agent's own
   * account and in each group's.
   */
  agent,
  pushMode: (process.env.PUSH_MODE === "relay" ? "relay" : "subscribe") as
    | "relay"
    | "subscribe",
  /* See relayPushRaw(): pipe the push stream socket-to-socket instead of through fetch(). */
  rawPushRelay: process.env.RAW_PUSH_RELAY !== "0",
  /* See absoluteUpstream(): follow Stalwart's advertised origin instead of pinning to ours. */
  followAdvertisedUrls: process.env.STALWART_FOLLOW_ADVERTISED_URLS === "1",
};

export type Config = typeof config;

/**
 * The address this installation's agent is known by (ADR 0003).
 *
 * The deployment names it — `GILBERT_AGENT_ADDRESS`, beside the password that
 * account signs in with, in the environment of whoever starts the server and
 * the worker. Nothing in the product names it and nothing falls back to
 * anything else: one place names the agent, and every surface reads it here.
 */

export function agentAddress(): string {
  return config.agent.address.trim().toLowerCase();
}
