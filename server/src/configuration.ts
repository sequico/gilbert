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
import { GILBERT_SOURCE_URL } from "./shared/source.js";

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
  /*
   * The whole value has to be an integer: `Number.parseInt` stops at the first
   * character it cannot use, so it read `1e3` as 1 and `1200/min` as 1200.
   * A setting silently half its stated value is worse than a refused boot.
   */
  if (!/^-?\d+$/.test(v.trim())) throw new Error(`Invalid integer for ${name}: ${v}`);
  return Number.parseInt(v, 10);
}

/**
 * An integer with a floor, where a value below it is a refused boot.
 *
 * The installation's own document refuses a duration below its minimum rather
 * than flooring it (`readAtLeast`, `shared/installation.ts`), and the two paths
 * must not disagree: a stated zero or negative number is a typo, not a request
 * for a timer that fires a thousand times a second, and quieting it to one
 * millisecond would honour neither reading.
 */
function readIntAtLeast(
  environment: InstallationEnvironment,
  name: string,
  fallback: number,
  least: number,
): number {
  const value = readInt(environment, name, fallback);
  if (value < least)
    throw new Error(`Invalid value for ${name}: ${value} is below ${least}`);
  return value;
}

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { normalizeBasePath } from "../../scripts/basePath.mjs";
import { resolveVersion } from "../../scripts/version.mjs";
import { installationDefaults, PLACEHOLDER_APP_SECRET } from "./shared/installation.js";

/**
 * The app secret this process runs on, and where it came from.
 *
 * The secret is not this resolver's to demand. A process that boots takes it
 * from the installation's own document, which is where a deployment states it
 * now; one started without a boot has no document to read and mints an
 * ephemeral secret. Nothing is said here: an import cannot know whether a boot
 * is coming, every process that serves does boot, and a line at this point would
 * be about a value the boot is about to replace. The refusal a production
 * deployment needs is "this process serves on a secret that will not survive its
 * restart", and that belongs after the boot — `config.ts`'s `assertServable`,
 * called by `index.ts` where a refusal is a boot failure rather than an import
 * crash.
 * What is decidable here is where the value came from, which is what that
 * refusal reads: `"environment"` for a secret the deployment stated,
 * `"ephemeral"` for one minted here.
 *
 * Empty and the placeholder (`change-me`, `PLACEHOLDER_APP_SECRET`) count as
 * nothing stated, which is what this file has always meant by them — and the
 * reason they are decided in one place: a placeholder marked "environment"
 * would let a production process serve on a secret of exactly that name.
 */
function resolveAppSecret(environment: InstallationEnvironment): {
  appSecret: string;
  appSecretSource: AppSecretSource;
} {
  const stated = environment.APP_SECRET ?? "";
  if (stated && stated !== PLACEHOLDER_APP_SECRET)
    return { appSecret: stated, appSecretSource: "environment" };
  return {
    appSecret: randomBytes(32).toString("base64"),
    appSecretSource: "ephemeral",
  };
}

/**
 * The `/api/account` permission that marks a Stalwart admin (ADR 0001).
 *
 * Live-verified 2026-09-09 on Stalwart 0.16.21: `sysAccountCreate` appears
 * in a principal's resolved permission list exactly when the operator
 * grants the admin role, and `sysBootstrap*` never appears (the endpoint
 * always strips it), so it is the non-forgeable marker to test for.
 *
 * Exported as its own reader rather than only as a field of the configuration
 * because a second tier has to grant the marker this process is configured on:
 * the mock Stalwart puts it in the permission list it reports, and the server
 * compares against `config.adminPermissionMarker` (`isStalwartAdmin`,
 * `upstream.ts`). One name, one default, one reading of a stated-but-empty
 * value, so a mock and a server given the same environment agree.
 */
export function adminPermissionMarkerOf(
  environment: InstallationEnvironment = process.env,
): string {
  return readEnv(environment, "GILBERT_ADMIN_PERMISSION", "sysAccountCreate");
}

/**
 * The runtime configuration, resolved from the environment alone.
 *
 * The environment is read over the installation's own defaults, and those
 * defaults are the document's (`installationDefaults()`), not a second set of
 * literals kept in step by hand: a value the environment is silent about is the
 * value a fresh installation's document states, so a process that never boots
 * and an installation that just created itself agree. A default moved in the
 * document moves here with it, which is what a copy beside this file could not
 * promise.
 */
export function configurationFromEnvironment(environment: InstallationEnvironment) {
  const defaults = installationDefaults();
  /**
   * `NODE_ENV === "production"`: a fact about the process that happens to be
   * running rather than about the installation, so it stays the environment's
   * even when the document decides everything else. `assertServable` is what
   * reads it, to refuse production on a secret no restart would find again.
   */
  const production = environment.NODE_ENV === "production";
  const { appSecret, appSecretSource } = resolveAppSecret(environment);

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
   * more — the sessions, the policy and the lock are all documents in Stalwart
   * — so what is left to check is the property itself.
   */
  const immutable = readBool(environment, "IMMUTABLE", false);

  interface AgentBootstrap {
    address: string;
    /** The account password the Master signs in with. Empty = no Master named. */
    password: string;
  }

  function resolveAgentBootstrap(): AgentBootstrap {
    const address = (environment.GILBERT_AGENT_ADDRESS ?? "").trim().toLowerCase();
    const password = environment.GILBERT_AGENT_PASSWORD ?? "";
    return { address, password };
  }

  /**
   * The installation's own account — the Master — plus the operator's own
   * switch. Both are read-only configuration: the environment cannot change
   * under a running process, so they are resolved once and never re-read.
   */
  const agent = {
    ...resolveAgentBootstrap(),
    /**
     * Whether this deployment may point the installation's model at an address
     * inside its own network — a model running on the same host, say.
     *
     * Off by default, and it is the **operator's** statement rather than the
     * installation's: the provider an installation writes is refused when it
     * names a private host (`assertUsableProvider`), and this is what says the
     * deployment meant one. It is read here, from the environment, and nowhere
     * else — never from the installation's document, which an installation
     * could otherwise use to grant itself the right to aim its model at the
     * network the deployment runs in. The boot does not override it either:
     * `bootstrap.ts` merges this over the environment's own, so this value is
     * the one a served process runs on.
     */
    allowPrivateProvider: readBool(
      environment,
      "GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER",
      false,
    ),
  };
  return {
    production,
    appName: readEnv(environment, "APP_NAME", defaults.branding.appName),
    /**
     * What this build calls itself -- `2026.8.30+pr129`. Set by the image build from
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
    sourceUrl: readEnv(environment, "SOURCE_URL", GILBERT_SOURCE_URL),
    host: readEnv(environment, "HOST", defaults.server.host),
    port: readInt(environment, "PORT", defaults.server.port),
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
    trustProxy: readBool(environment, "TRUST_PROXY", defaults.server.trustProxy),
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
    secureCookies: (
      environment.SECURE_COOKIES ?? defaults.server.secureCookies
    ).toLowerCase(),
    sessionTtl: readIntAtLeast(environment, "SESSION_TTL", defaults.sessions.ttl, 1),
    sessionRememberTtl: readIntAtLeast(
      environment,
      "SESSION_REMEMBER_TTL",
      defaults.sessions.rememberTtl,
      1,
    ),
    /** True when this instance has asserted, and verified, that it is immutable. */
    immutable,
    upstreamTimeout: readInt(
      environment,
      "UPSTREAM_TIMEOUT",
      defaults.limits.upstreamTimeout,
    ),
    maxUploadBytes: readInt(
      environment,
      "MAX_UPLOAD_BYTES",
      defaults.limits.maxUploadBytes,
    ),
    imageProxy: readBool(environment, "IMAGE_PROXY", defaults.limits.imageProxy),
    /**
     * The name of the session cookie. The installation decides it --
     * `server.cookieName` in the document — and this is the value a process
     * with no boot runs on.
     */
    cookieName: readEnv(environment, "COOKIE_NAME", defaults.server.cookieName),
    staticDir:
      environment.STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
    loginRateLimit: readInt(
      environment,
      "LOGIN_RATE_LIMIT",
      defaults.limits.loginRateLimit,
    ),
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
    apiRateLimit: readInt(environment, "API_RATE_LIMIT", defaults.limits.apiRateLimit),
    /* Whether JMAP responses are gzipped. Measured: see the bake-off rerun. */
    compressJmap:
      environment.COMPRESS_JMAP === "0" ? false : defaults.server.compressJmap,
    /**
     * Whether this installation offers administration to accounts whose
     * Stalwart role allows it (ADR 0015). Off means off: the menu is not
     * drawn, and the JMAP proxy refuses registry methods beyond the account's
     * own, so an administrator cannot reach the registry from the browser
     * console of a deployment that said no. The installation decides it --
     * `server.administration` in the document.
     */
    administration: readBool(environment, "ADMINISTRATION", true),
    /**
     * Whether administration additionally requires the session to have been
     * signed in on a device marked as its owner's (ADR 0015). Off by default:
     * the sign-in form's box is about how long a session lasts, and keying a
     * restriction on it is a deployment's choice rather than this product's.
     * `server.administrationNeedsOwnDevice` in the document.
     */
    administrationNeedsOwnDevice: readBool(
      environment,
      "ADMINISTRATION_NEEDS_OWN_DEVICE",
      false,
    ),
    /** The marker a permission list is read for; see `adminPermissionMarkerOf`. */
    adminPermissionMarker: adminPermissionMarkerOf(environment),
    /*
     * How push reaches the browser. "relay" holds one upstream stream per tab.
     * "subscribe" registers one JMAP PushSubscription per account and fans
     * Stalwart's POSTs out to that account's tabs, holding no upstream connection
     * at all -- see push.ts. The origin Stalwart POSTs back to is derived from the
     * request (see pushOrigin in routes/shared.ts); an account we cannot state one for
     * stays on the relay.
     */
    /*
     * The installation's own account — the Master — and the operator's switch
     * over which model may be reached. Read-only configuration, resolved once.
     */
    agent,
    pushMode: (environment.PUSH_MODE === "relay" ? "relay" : defaults.push.mode) as
      | "relay"
      | "subscribe",
    /* See relayPushRaw(): pipe the push stream socket-to-socket instead of through fetch(). */
    rawPushRelay: environment.RAW_PUSH_RELAY === "0" ? false : defaults.push.rawRelay,
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
