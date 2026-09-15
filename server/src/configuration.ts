/**
 * The installation's configuration, as this process comes to hold it.
 *
 * This module is the one that reads the environment, and it exists for the
 * process that has no boot: a test, a tool, a development server started
 * without a sign-in. A deployment does not stay here — the boot signs in as
 * the Master, reads the installation's own document out of that account's
 * `gilbert` app folder, and hands the result to `config.ts`'s
 * `useConfiguration`, which is what a served request then runs on. The names,
 * the defaults and the note beside each one are the same in both paths, so a
 * reader checking here is checking what a deployment gets.
 *
 * Nothing here touches the network or the disk: it is a function of the
 * environment it is handed, which is what makes it testable without a mail
 * server — and a reason to keep it that way.
 */

/** The environment a boot reads: the process's, unless a caller hands over its own. */
export type InstallationEnvironment = Record<string, string | undefined>;

/**
 * Where the app secret this process is running on came from.
 *
 * Carried rather than inferred from the string, because two of the three cases
 * produce a secret that is not empty and only one of them can seal a session
 * that survives a restart: a process that has not stated a secret anywhere
 * still serves (a development server, a test), and the refusal that belongs to
 * production is `config.ts`'s `assertServable`, made where the deployment is
 * known (`index.ts`, after the boot) rather than at an import.
 */
export type AppSecretSource = "document" | "environment" | "ephemeral";

function readEnv(
  environment: InstallationEnvironment,
  name: string,
  fallback?: string,
): string {
  const v = environment[name];
  if (v === undefined || v === "") {
    if (fallback === undefined)
      throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}

function readBool(
  environment: InstallationEnvironment,
  name: string,
  fallback: boolean,
): boolean {
  const v = environment[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function readInt(
  environment: InstallationEnvironment,
  name: string,
  fallback: number,
): number {
  const v = environment[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}: ${v}`);
  return n;
}

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { normalizeBasePath } from "../../scripts/basePath.mjs";
import { resolveVersion } from "../../scripts/version.mjs";
import { AGENT_PAGES_DEFAULT, PLACEHOLDER_APP_SECRET } from "./shared/installation.js";

/**
 * The app secret this process runs on, and where it came from.
 *
 * The secret is not this resolver's to demand. A process that boots takes it
 * from the installation's own document, which is where a deployment states it
 * now; one started without a boot has no document to read and mints an
 * ephemeral secret, loudly. The refusal a production deployment needs is "this
 * process serves on a secret that will not survive its restart", and that is
 * not decidable here: an import cannot know whether a boot is coming, so the
 * refusal belongs after one — `config.ts`'s `assertServable`, called by
 * `index.ts` where a refusal is a boot failure rather than an import crash.
 * What is decidable here is where the value came from, which is what that
 * refusal reads: `"environment"` for a secret the deployment stated,
 * `"ephemeral"` for one minted here.
 *
 * Empty and the placeholder (`change-me`, `PLACEHOLDER_APP_SECRET`) count as
 * nothing stated, which is what this file has always meant by them — and the
 * reason they are decided in one place: a placeholder marked "environment"
 * would let a production process serve on a secret of exactly that name.
 */
function resolveAppSecret(
  environment: InstallationEnvironment,
  production: boolean,
): { appSecret: string; appSecretSource: AppSecretSource } {
  const stated = environment.APP_SECRET ?? "";
  if (stated && stated !== PLACEHOLDER_APP_SECRET)
    return { appSecret: stated, appSecretSource: "environment" };
  console.warn(
    production
      ? "[gilbert] APP_SECRET not set - using an ephemeral secret until the installation's own document supplies one"
      : "[gilbert] APP_SECRET not set - using an ephemeral secret (persisted sessions will not survive restarts)",
  );
  return {
    appSecret: randomBytes(32).toString("base64"),
    appSecretSource: "ephemeral",
  };
}

/**
 * The runtime configuration, resolved from the environment alone.
 *
 * Every default here is the value the code used before the installation's
 * document existed, so a process that never boots behaves as it always has.
 */
export function configurationFromEnvironment(environment: InstallationEnvironment) {
  /**
   * `NODE_ENV === "production"`: a fact about the process that happens to be
   * running rather than about the installation, so it stays the environment's
   * even when the document decides everything else. `assertServable` is what
   * reads it, to refuse production on a secret no restart would find again.
   */
  const production = environment.NODE_ENV === "production";
  const { appSecret, appSecretSource } = resolveAppSecret(environment, production);

  const stalwartUrl = readEnv(
    environment,
    "STALWART_URL",
    "https://mail.example.com",
  ).replace(/\/+$/, "");

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
  const immutable = readBool(environment, "IMMUTABLE", false);

  interface AgentBootstrap {
    address: string;
    /** The account password the worker signs in with. Empty = no agent named. */
    password: string;
  }

  function resolveAgentBootstrap(): AgentBootstrap {
    const address = (environment.GILBERT_AGENT_ADDRESS ?? "").trim().toLowerCase();
    const password = environment.GILBERT_AGENT_PASSWORD ?? "";
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
    pollMs: readInt(environment, "GILBERT_AGENT_POLL_MS", 60_000),
    /* How often a working worker says it is alive, in its claims and heartbeat. */
    heartbeatMs: readInt(environment, "GILBERT_AGENT_HEARTBEAT_MS", 30_000),
    /*
     * How long a claim may go un-renewed before another worker takes it over.
     * Longer than a few heartbeats on purpose: an agent's work can sit in a
     * model call or wait on a person, and a takeover that fires during a
     * legitimate pause would run the same job twice.
     */
    leaseMs: readInt(environment, "GILBERT_AGENT_LEASE_MS", 180_000),
    /*
     * Where the worker answers a health probe, or 0 for no endpoint at all.
     * A deployment with a restart policy wants this (ADR 0003 resolution 8);
     * a worker nobody asks anything needs no listening socket.
     */
    healthPort: readInt(environment, "GILBERT_AGENT_HEALTH_PORT", 0),
    /*
     * Whether the server starts a fleet of its own beside the web tier, which is
     * what makes `node server/dist/index.js` an installation that also works
     * (ADR 0003). A deployment that wants the fleet isolated — its own container,
     * its own restart policy — says `GILBERT_AGENT_INPROCESS=0` and runs
     * `node server/dist/agent/agent.js` itself.
     */
    inprocess: readBool(environment, "GILBERT_AGENT_INPROCESS", true),
    /*
     * Whether a run pays for the model's chain of thought. The provider reasons
     * by default; a run that wants a cheaper, faster answer says so here, and an
     * agent that wants the careful one keeps the default. It is a parameter of
     * the agent rather than of a rule because a group is held by one agent at a
     * time — and every run records the setting it used beside the tokens it
     * spent, so a behaviour that changed with the machine that ran it is
     * readable rather than inferred (ADR 0003).
     */
    thinking: readBool(environment, "GILBERT_AGENT_THINKING", true),
    /**
     * Whether this deployment may point the installation's model at an address
     * inside its own network — a model running on the same host, say.
     *
     * Off by default, and it is the **operator's** statement rather than the
     * installation's: the provider an installation writes is refused when it
     * names a private host (`assertUsableProvider`, ADR 0003), and this is what
     * says the deployment meant one. It is read here, from the environment, and
     * nowhere else — never from the installation's document, which an
     * installation could otherwise use to grant itself the right to aim its
     * model at the network the deployment runs in. The boot does not override
     * it either: the document's agent is spread beside the environment's in
     * `bootstrap.ts`, so this value is the one a served process runs on.
     */
    allowPrivateProvider: readBool(
      environment,
      "GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER",
      false,
    ),
    /**
     * Whether the installation's model can read an image.
     *
     * True is the common case and the default; a deployment running a
     * text-only model says so, and then a run handed a page with no text layer is
     * told that the page could not be read rather than being told an image was
     * handed over (ADR 0003).
     */
    vision: readBool(environment, "GILBERT_AGENT_VISION", true),
    /**
     * How many readings one installation may ask for in a month.
     *
     * A reading is a call the installation pays for and it is not a run, so no
     * job's ceiling bounds it: this is the bound, counted from the authoring
     * document of the month, and a reading past it is refused before it is made
     * (ADR 0003).
     */
    authoringMonthlyMax: readInt(
      environment,
      "GILBERT_AGENT_AUTHORING_MAX_PER_MONTH",
      200,
    ),
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
    maxPages: Math.max(
      1,
      readInt(environment, "GILBERT_AGENT_MAX_PAGES", AGENT_PAGES_DEFAULT),
    ),
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
    maxChainHops: Math.max(1, readInt(environment, "GILBERT_AGENT_MAX_CHAIN_HOPS", 5)),
  };

  /**
   * The installation's agent, as the running process holds it (ADR 0003).
   *
   * The environment cannot change under a running process, so this is resolved
   * once and never re-read: an operator who names a different agent, or gives it
   * a different secret, says so in the deployment and restarts it.
   */
  const agent = { ...resolveAgentBootstrap(), ...agentWorkerSettings };
  return {
    production,
    appName: readEnv(environment, "APP_NAME", "Gilbert"),
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
    sourceUrl: readEnv(environment, "SOURCE_URL", "https://github.com/sequico/gilbert"),
    host: readEnv(environment, "HOST", "0.0.0.0"),
    port: readInt(environment, "PORT", 8080),
    /**
     * The subpath this instance answers on: `/webmail` for a proxy that maps
     * `https://example.com/webmail/` here, and `""` for the root.
     *
     * This is a fact about the image rather than a decision of the
     * installation, and it is why it is read here and nowhere else: the web
     * build bakes the same variable into its asset URLs, so a server that
     * serves a different prefix than the bundle was built for serves an app
     * that cannot load its own scripts -- a blank page, with nothing in the
     * log to say why. A deployment states it (the image states it, from the
     * build argument), an empty value means the root, and a production process
     * that states nothing refuses to serve rather than guessing (see
     * `assertServable`).
     *
     * The prefix is expected to arrive intact: a proxy that strips it before
     * forwarding serves the root, so the deployment states `""` -- never
     * nothing, which a production process refuses (see `assertServable`). What
     * must agree is the build, not the deployment's routing.
     */
    basePath: normalizeBasePath(environment.BASE_PATH),
    /** Whether the deployment stated a prefix at all (an empty one is a statement). */
    basePathStated: environment.BASE_PATH !== undefined,
    stalwartUrl,
    /* The document carries this table; a process with no boot has none. */
    stalwartServers: {} as Record<string, string>,
    appSecret,
    /**
     * Where `appSecret` came from: the environment's own, the boot's document,
     * or a value minted because neither stated one. See `AppSecretSource`.
     */
    appSecretSource,
    trustProxy: readBool(environment, "TRUST_PROXY", true),
    /**
     * Peers whose X-Forwarded-* headers are believed. Empty falls back to
     * loopback and the private ranges, which covers the usual reverse proxy on
     * the same host or Docker network. A peer outside this is attributed by its
     * socket address whatever it claims.
     */
    trustedProxies: (environment.TRUSTED_PROXIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    /** "auto" = Secure when the request arrived over https; "1"/"0" to force. */
    secureCookies: (environment.SECURE_COOKIES ?? "auto").toLowerCase(),
    sessionTtl: readInt(environment, "SESSION_TTL", 12 * 60 * 60),
    sessionRememberTtl: readInt(environment, "SESSION_REMEMBER_TTL", 30 * 24 * 60 * 60),
    /** True when this instance has asserted, and verified, that it is immutable. */
    immutable,
    upstreamTimeout: readInt(environment, "UPSTREAM_TIMEOUT", 30_000),
    maxUploadBytes: readInt(environment, "MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
    imageProxy: readBool(environment, "IMAGE_PROXY", true),
    /**
     * The name of the session cookie. The installation decides it --
     * `server.cookieName` in the document — and this is the value a process
     * with no boot runs on.
     */
    cookieName: readEnv(environment, "COOKIE_NAME", "gilbert_session"),
    staticDir:
      environment.STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
    loginRateLimit: readInt(environment, "LOGIN_RATE_LIMIT", 10),
    /*
     * Requests per minute one session may make on the data path -- JMAP, blobs,
     * the image and calendar proxies. The proxy is one Node process and saturates
     * a core at roughly 2,000 operations a second, so without this a single
     * signed-in user can deny service to everyone else. 1,200 a minute is twenty
     * a second sustained: well above what a busy tab does, and an order of
     * magnitude below where one tab starts to hurt the rest. 0 disables it.
     *
     * The installation decides the number — `limits.apiRateLimit` in the
     * document — and this is the value a process with no boot runs on.
     */
    apiRateLimit: readInt(environment, "API_RATE_LIMIT", 1200),
    /* Whether JMAP responses are gzipped. Measured: see the bake-off rerun. */
    compressJmap: environment.COMPRESS_JMAP !== "0",
    /**
     * Whether this installation offers administration to accounts whose
     * Stalwart role allows it (ADR 0014). Off means off: the menu is not
     * drawn, and the JMAP proxy refuses registry methods beyond the account's
     * own, so an administrator cannot reach the registry from the browser
     * console of a deployment that said no. The installation decides it --
     * `server.administration` in the document.
     */
    administration: readBool(environment, "ADMINISTRATION", true),
    /**
     * The `/api/account` permission that marks a Stalwart admin (ADR 0001).
     *
     * Live-verified 2026-09-09 on Stalwart 0.16.21: `sysAccountCreate` appears
     * in a principal's resolved permission list exactly when the operator
     * grants the admin role, and `sysBootstrap*` never appears (the endpoint
     * always strips it), so it is the non-forgeable marker to test for.
     */
    adminPermissionMarker: readEnv(
      environment,
      "GILBERT_ADMIN_PERMISSION",
      "sysAccountCreate",
    ),
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
    pushMode: (environment.PUSH_MODE === "relay" ? "relay" : "subscribe") as
      | "relay"
      | "subscribe",
    /* See relayPushRaw(): pipe the push stream socket-to-socket instead of through fetch(). */
    rawPushRelay: environment.RAW_PUSH_RELAY !== "0",
    /* See absoluteUpstream(): follow Stalwart's advertised origin instead of pinning to ours. */
    followAdvertisedUrls: environment.STALWART_FOLLOW_ADVERTISED_URLS === "1",
  };
}

/**
 * The configuration this process runs on, as a type rather than as a second
 * declaration: whatever the function above returns is what a reader of it sees.
 */
export type Config = ReturnType<typeof configurationFromEnvironment>;

/**
 * The configuration a process reads from nothing but its own environment.
 *
 * This is the one place the process's environment is read — beside the
 * handshake in `bootstrap.ts` — and the only caller that passes nothing is a
 * process that boots: a deployment starts from here and then replaces it with
 * what the installation's own document says.
 */
export function environmentConfiguration(
  environment: InstallationEnvironment = process.env,
): Config {
  return configurationFromEnvironment(environment);
}
