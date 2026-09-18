/**
 * The boot's own rule: three classes of configuration, and the order they are
 * read in.
 *
 * 1. **The handshake** — `STALWART_URL`, `GILBERT_AGENT_ADDRESS`,
 *    `GILBERT_AGENT_PASSWORD`. No default, and a missing one is fatal with a
 *    message that names it. These three are how Stalwart is reached, so they
 *    cannot come from the document in Stalwart: reading that document is what
 *    needs them. `STALWART_URL` deliberately has **no** default here, unlike
 *    `config.ts`'s `https://mail.example.com`, which is a lie a container can
 *    silently talk to — and a container that talked to it would come up
 *    healthy while reading nothing of its own.
 * 2. **The container's own facts** — `HOST`, `PORT`, `IMMUTABLE`. They describe
 *    the process that happens to be running (which interface to bind, which
 *    port the orchestrator mapped, whether the root filesystem is read-only),
 *    not the installation, so they stay in the environment and take defaults.
 *    `HOST` and `PORT` *override* the document when the container states them;
 *    when it does not, the document's value is the one that counts.
 * 3. **Everything else** — the rest of the configuration, read from the
 *    installation document after signing in as the Master.
 *
 * The order is the point. The document that tunes the upstream timeout lives
 * in Stalwart, and the request that fetches it must not wait for a value that
 * has not been read yet: so the very first request is bounded by
 * `FIRST_REQUEST_TIMEOUT_MS`, a constant in this module rather than a variable
 * anybody can set.
 *
 * A failure anywhere in the middle is fatal, and it has no HTTP surface to
 * report through: there is no port yet, so one line on the log and a non-zero
 * exit code are the only channels there are.
 *
 * This module does not bind a port and does not serve anything. It returns the
 * configuration, and `index.ts` is where the listening starts.
 */

import type { Ctx } from "./appFolder.js";
import {
  appFolderInstallationStore,
  type InstallationStore,
  readInstallation,
} from "./installation.js";
import { sleep as defaultSleep } from "./shared/async.js";
import type { InstallationAgent, InstallationDocument } from "./shared/installation.js";
import type { UpstreamSession } from "./upstream.js";

/**
 * The environment, as this module reads it: the only place that does, apart
 * from the resolver in `configuration.ts` that this hands it to.
 */
export type { Config, InstallationEnvironment } from "./configuration.js";

import {
  type Config,
  environmentConfiguration,
  type InstallationEnvironment,
} from "./configuration.js";

/**
 * How long the first request of a boot may take.
 *
 * A constant rather than a variable, and deliberately so: the timeout an
 * operator would otherwise set (`UPSTREAM_TIMEOUT`) lives in the installation
 * document, and this is the request that fetches it. A boot that hung here
 * would hang before it could read the value that says how long it may hang.
 */
export const FIRST_REQUEST_TIMEOUT_MS = 30_000;

/** The three values that are how Stalwart is reached. */
export interface Handshake {
  /** `STALWART_URL`: the server this installation signs in to. */
  stalwartUrl: string;
  /** `GILBERT_AGENT_ADDRESS`: the Master's own address. */
  masterAddress: string;
  /** `GILBERT_AGENT_PASSWORD`: the credential the Master signs in with. */
  masterPassword: string;
}

/** What each handshake variable is for, in the words a refusal uses. */
const HANDSHAKE_PURPOSE = {
  STALWART_URL: "the address of the Stalwart this installation signs in to",
  GILBERT_AGENT_ADDRESS:
    "the installation's own account — the Master — whose `gilbert` app folder holds this installation's configuration",
  GILBERT_AGENT_PASSWORD: "the credential that account signs in with",
} as const;

type HandshakeName = keyof typeof HANDSHAKE_PURPOSE;

/** The refusal a missing handshake variable gets. */
function missingHandshake(name: HandshakeName): BootstrapError {
  return new BootstrapError(
    `${name} is not set. It is ${HANDSHAKE_PURPOSE[name]}, and it has no default: this deployment must state it. ` +
      "It cannot come from Stalwart — the installation's configuration is read from Stalwart, and these three are how Stalwart is reached. " +
      `Set ${name} in the environment of whatever starts this process.`,
  );
}

/** A boot that cannot go on, with a message meant for whoever reads the log. */
export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}

/**
 * The handshake, or a throw naming what is missing.
 *
 * Read once, at boot, from the environment and nowhere else: the three values
 * are what stands between a starting process and the document that holds
 * everything else.
 */
export function readHandshake(env: InstallationEnvironment = process.env): Handshake {
  const required = (name: HandshakeName): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") throw missingHandshake(name);
    return value;
  };
  return {
    // Trailing slashes stripped the way `config.ts` stripped them: every URL
    // built from this is `${stalwartUrl}/…`.
    stalwartUrl: required("STALWART_URL").trim().replace(/\/+$/, ""),
    // Lower-cased because that is how a principal's address compares, and this
    // one is used both to sign in and to name itself afterwards.
    masterAddress: required("GILBERT_AGENT_ADDRESS").trim().toLowerCase(),
    masterPassword: required("GILBERT_AGENT_PASSWORD"),
  };
}

/**
 * What the container says about itself.
 *
 * `host` and `port` are optional on purpose: a container that states neither
 * is the ordinary case, and then the installation document decides. `immutable`
 * is a claim the container makes (`config.ts`'s `assertImmutable` is what
 * checks it) and belongs nowhere else.
 */
export interface ContainerFacts {
  /** `HOST`, when the container states one. */
  host?: string;
  /** `PORT`, when the container states one. */
  port?: number;
  /** `IMMUTABLE`: this instance claims a read-only filesystem and no durable state of its own. */
  immutable: boolean;
}

/** The defaults the container's own facts take. */
export const CONTAINER_DEFAULTS = Object.freeze({
  host: "0.0.0.0",
  port: 8080,
  immutable: false,
});

/** Read the container's own facts, with their defaults. */
export function readContainerFacts(
  env: InstallationEnvironment = process.env,
): ContainerFacts {
  const host = env.HOST?.trim();
  const rawPort = env.PORT?.trim();
  let port: number | undefined;
  if (rawPort) {
    port = Number.parseInt(rawPort, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535)
      throw new BootstrapError(
        `PORT is "${rawPort}", which is not a port number. It is the port this instance binds inside its container; ` +
          "leave it unset to take the installation's own value.",
      );
  }
  return {
    ...(host ? { host } : {}),
    ...(port === undefined ? {} : { port }),
    immutable: ["1", "true", "yes", "on"].includes((env.IMMUTABLE ?? "").toLowerCase()),
  };
}

/** The Master's own session, opened once, at the start of the boot. */
export interface MasterLogin {
  /** The address the handshake named, normalised. */
  address: string;
  /** The Basic header every later call to Stalwart carries. */
  authorization: string;
  /** The JMAP session resource Stalwart answered with. */
  session: UpstreamSession;
}

/** The Basic header for a principal's own credential. */
export function basicAuthorization(address: string, password: string): string {
  return `Basic ${Buffer.from(`${address}:${password}`, "utf8").toString("base64")}`;
}

/**
 * Sign in as the Master: the first request of the boot, and the only one.
 *
 * Written here rather than borrowed from `upstream.ts` for one reason: the
 * timeout is `FIRST_REQUEST_TIMEOUT_MS`, this module's constant, because the
 * request that reads the installation document cannot be governed by a value
 * from that document. Everything else — the `/.well-known/jmap` shape,
 * `baseUrl`, the 401 — is the same as any other sign-in, and a session fetched
 * here is the same object `appFolder.ts` and the rest of the server take.
 */
export async function signInAsMaster(handshake: Handshake): Promise<MasterLogin> {
  const authorization = basicAuthorization(
    handshake.masterAddress,
    handshake.masterPassword,
  );
  let res: Response;
  try {
    res = await fetch(`${handshake.stalwartUrl}/.well-known/jmap`, {
      headers: { authorization, accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(FIRST_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new BootstrapError(
      `The Master's sign-in at ${handshake.stalwartUrl} did not answer within ` +
        `${FIRST_REQUEST_TIMEOUT_MS} ms: ${err instanceof Error ? err.message : String(err)}. ` +
        "Nothing else can be read until this works, so the boot stops here.",
    );
  }
  if (res.status === 401 || res.status === 403)
    throw new BootstrapError(
      `Stalwart at ${handshake.stalwartUrl} refused ${handshake.masterAddress} (${res.status}). ` +
        "The address and the password are the installation's own account and its app password; check them, " +
        "and check that the account is not required to use two-factor sign-in.",
    );
  if (!res.ok)
    throw new BootstrapError(
      `Stalwart at ${handshake.stalwartUrl} answered ${res.status} for the Master's session.`,
    );
  const session = (await res.json()) as UpstreamSession;
  if (!session.apiUrl)
    throw new BootstrapError(
      `Stalwart at ${handshake.stalwartUrl} answered with something that is not a JMAP session.`,
    );
  return {
    address: handshake.masterAddress,
    authorization,
    session: { ...session, baseUrl: handshake.stalwartUrl },
  };
}

/**
 * The agent worker's configuration, in the names `config.ts` already uses.
 *
 * The address and the password are the handshake's: the installation's own
 * account **is** the agent (ADR 0003 — one structure agent per installation),
 * so the Master's credential is the fleet's credential and there is no second
 * secret to keep in step.
 *
 * The one agent field this deliberately does not carry is
 * `allowPrivateProvider`: whether the installation's model may sit inside the
 * deployment's own network is the **operator's** statement, read from the
 * environment (`configuration.ts`), and an installation must not grant itself
 * that right. The boot therefore merges this over the environment's agent
 * rather than replacing it, which is what leaves that switch where it belongs.
 */
export interface InstallationAgentConfiguration {
  address: string;
  password: string;
  pollMs: number;
  heartbeatMs: number;
  leaseMs: number;
  maxChainHops: number;
  maxPages: number;
  thinking: boolean;
  vision: boolean;
  authoringMonthlyMax: number;
  healthPort: number;
  inprocess: boolean;
}

/**
 * The installation's configuration, resolved — the shape `config.ts` holds.
 *
 * Every name here is a name `config.ts` already uses for the same value, so
 * the wiring is a translation and not a redesign: `config.agent.pollMs` is
 * `agent.poll` in the document, `config.sessionTtl` is `sessions.ttl`, and so
 * on. Three things are not the document's: `host` and `port` come from the
 * container when it states them (`ContainerFacts`) and from the document
 * otherwise, and the agent's `allowPrivateProvider` is the operator's, so it is
 * not here at all and the environment's value is the one a served process runs
 * on (see `bootInstallation`).
 */
export interface InstallationConfiguration {
  appName: string;
  appSecret: string;
  /**
   * The document is where a deployment states the app secret, so a served
   * process is never on an ephemeral one: this says where the value in
   * `appSecret` came from (`AppSecretSource`).
   */
  appSecretSource: "document";
  host: string;
  port: number;
  immutable: boolean;
  trustProxy: boolean;
  trustedProxies: string[];
  secureCookies: string;
  /** The session cookie's name, `server.cookieName` in the document. */
  cookieName: string;
  compressJmap: boolean;
  upstreamTimeout: number;
  maxUploadBytes: number;
  imageProxy: boolean;
  loginRateLimit: number;
  /** The data path's per-session budget, `limits.apiRateLimit` in the document. */
  apiRateLimit: number;
  sessionTtl: number;
  sessionRememberTtl: number;
  pushMode: "relay" | "subscribe";
  rawPushRelay: boolean;
  stalwartUrl: string;
  stalwartServers: Record<string, string>;
  agent: InstallationAgentConfiguration;
}

/**
 * Resolve the document and the container's own facts into one configuration.
 *
 * Pure, so it can be tested without a Stalwart and without an environment: the
 * document says what the installation is and the facts say what this container
 * is, and the two overrides are the whole of the interplay.
 */
export function configurationFrom(
  document: InstallationDocument,
  facts: ContainerFacts,
  handshake: Handshake,
): InstallationConfiguration {
  const agent: InstallationAgent = document.agent;
  return {
    appName: document.branding.appName,
    appSecret: document.secret,
    appSecretSource: "document",
    // The container's own facts win when it states them: it is the process
    // that knows which interface and port it was given.
    host: facts.host ?? document.server.host,
    port: facts.port ?? document.server.port,
    immutable: facts.immutable,
    trustProxy: document.server.trustProxy,
    trustedProxies: document.server.trustedProxies,
    secureCookies: document.server.secureCookies,
    cookieName: document.server.cookieName,
    compressJmap: document.server.compressJmap,
    upstreamTimeout: document.limits.upstreamTimeout,
    maxUploadBytes: document.limits.maxUploadBytes,
    imageProxy: document.limits.imageProxy,
    loginRateLimit: document.limits.loginRateLimit,
    apiRateLimit: document.limits.apiRateLimit,
    sessionTtl: document.sessions.ttl,
    sessionRememberTtl: document.sessions.rememberTtl,
    pushMode: document.push.mode,
    rawPushRelay: document.push.rawRelay,
    stalwartUrl: handshake.stalwartUrl,
    stalwartServers: document.upstreams,
    agent: {
      address: handshake.masterAddress,
      password: handshake.masterPassword,
      pollMs: agent.poll,
      heartbeatMs: agent.heartbeat,
      leaseMs: agent.lease,
      maxChainHops: agent.chainHops,
      maxPages: agent.pages,
      thinking: agent.thinking,
      vision: agent.vision,
      authoringMonthlyMax: agent.authoringMaxPerMonth,
      healthPort: agent.healthPort,
      inprocess: agent.inProcess,
    },
  };
}

/** Everything the boot hands the caller. */
export interface BootConfiguration {
  /** The document exactly as it is stored, which is what a later edit must write back. */
  installation: InstallationDocument;
  /** The installation's configuration, resolved. */
  configuration: Config;
  /** The Master's own session and credential, so the boot signs in once. */
  master: MasterLogin;
  /** The account the document lives in. */
  accountId: string;
  /** True when this boot created the document. */
  created: boolean;
  /** The address the handshake named, stripped of any trailing slash. */
  stalwartUrl: string;
}

/** What the boot reads the world through; every one of them has a real default. */
export interface BootDeps {
  /** The environment. `process.env` unless a test hands over its own. */
  env?: InstallationEnvironment;
  /** One line per event worth reading. */
  log?: (line: string) => void;
  /** Sign in as the Master. `signInAsMaster` unless a test hands over a stub. */
  signIn?: (handshake: Handshake) => Promise<MasterLogin>;
  /** The document's store, given the Master's session. */
  store?: (login: MasterLogin) => InstallationStore;
  /** How a failed boot ends the process. `process.exit` unless a test says otherwise. */
  exit?: (code: number) => never;
  /**
   * How many times the Master's sign-in is tried before the boot gives up.
   *
   * More than one because the mail server may be a container starting beside
   * this one: "nothing is listening yet" is not a configuration error, and a
   * boot that gave up on it would turn a race into an outage.
   */
  signInAttempts?: number;
  /** How long to wait between those attempts. */
  signInRetryMs?: number;
  /** The wait itself, so a test does not spend the seconds it names. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Boot: the handshake, the sign-in, the document, the configuration.
 *
 * The order is the rule, and each step is here because it cannot be anywhere
 * else:
 *
 * 1. the class-1 environment, because nothing can be reached without it;
 * 2. the Master's sign-in, because the document is in that account;
 * 3. the document — read, or created with the defaults and a generated app
 *    secret on the very first boot;
 * 4. the configuration, resolved against the container's own facts.
 *
 * A failure at any point is fatal, and reported the only ways a process with
 * no port has: one line, and a non-zero exit code. It never returns a partial
 * configuration, and it never binds anything.
 */
export async function bootInstallation(deps: BootDeps = {}): Promise<BootConfiguration> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const signIn = deps.signIn ?? signInAsMaster;
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const attempts = deps.signInAttempts ?? 10;
  const retryMs = deps.signInRetryMs ?? 1000;
  const wait = deps.sleep ?? defaultSleep;
  const openStore =
    deps.store ??
    ((login: MasterLogin) => {
      const ctx: Ctx = {
        authorization: login.authorization,
        session: login.session,
        username: login.address,
      };
      return appFolderInstallationStore(ctx);
    });

  try {
    const handshake = readHandshake(env);
    const facts = readContainerFacts(env);
    /*
     * The sign-in is the one step that is retried, and only it: a mail server
     * that is not listening yet is a container starting beside this one, while
     * a missing handshake variable and a document that cannot be read are
     * things no amount of waiting fixes. Every retry says so, so a process that
     * is waiting is not mistaken for one that is stuck.
     */
    const login = await signInWithRetries(handshake);
    const loaded = await readInstallation(openStore(login), { log });
    const fromEnvironment = environmentConfiguration(env);
    const installation = configurationFrom(loaded.document, facts, handshake);
    return {
      installation: loaded.document,
      /*
       * The document decides what the installation decides; what it does not
       * carry — the version this build calls itself, where its source is, the
       * admin marker, and the operator's own provider switch — stays as the
       * environment stated it, which is the merge this spread is.
       */
      configuration: {
        ...fromEnvironment,
        ...installation,
        /*
         * The agent is the one section both paths own fields of, so it is
         * merged field by field rather than replaced: the document's timers and
         * bounds, and `allowPrivateProvider`, which a document may not decide
         * (see `InstallationAgentConfiguration`).
         */
        agent: { ...fromEnvironment.agent, ...installation.agent },
      },
      master: login,
      accountId: loaded.accountId,
      created: loaded.created,
      stalwartUrl: handshake.stalwartUrl,
    };
  } catch (err) {
    log(`[gilbert] fatal: ${err instanceof Error ? err.message : String(err)}`);
    /*
     * The only channel a process with no port has left. `exit` never returns,
     * and saying so here is what tells the compiler this function cannot fall
     * out of the end: a boot that failed must not hand back a configuration.
     */
    return exit(1);
  }

  /** The Master's sign-in, asked again while the mail server is still coming up. */
  async function signInWithRetries(handshake: Handshake): Promise<MasterLogin> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await signIn(handshake);
      } catch (err) {
        if (attempt >= attempts) throw err;
        log(
          `[gilbert] ${handshake.stalwartUrl} did not answer (${err instanceof Error ? err.message : String(err)}) — trying again (${attempt}/${attempts})`,
        );
        await wait(retryMs);
      }
    }
  }
}
