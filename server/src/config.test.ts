import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootInstallation, configurationFrom, type Handshake } from "./bootstrap.js";
import {
  assertImmutable,
  assertServable,
  type Config,
  useConfiguration,
} from "./config.js";
import {
  configurationFromEnvironment,
  type InstallationEnvironment,
} from "./configuration.js";
import {
  type InstallationDocument,
  installationDefaults,
  parseInstallationDocumentDetailed,
} from "./shared/installation.js";

/**
 * The configuration this process runs on: the claims it makes, and who refuses
 * what (ADR 0001).
 *
 * `IMMUTABLE` is a claim about the filesystem the process is really on; the app
 * secret is a claim about where the installation's key material came from; the
 * provider switch and the two settings moved out of the environment are claims
 * about **who decides**, the installation's own document or the operator. Each
 * is a guarantee rather than a reassurance, so each has a test that fails when
 * the mechanism is removed.
 *
 * The shape a boot builds here — the environment's configuration first, the
 * document's over it, the agent merged field by field — is the one
 * `bootInstallation` builds and `useConfiguration` adopts, so what these tests
 * resolve is what a served process runs on.
 */

/** The three values that reach Stalwart: the handshake, as a deployment states it. */
const HANDSHAKE: Handshake = {
  stalwartUrl: "https://mail.example.com",
  masterAddress: "gilbert@example.com",
  masterPassword: "a-password",
};

const HANDSHAKE_ENV: InstallationEnvironment = {
  STALWART_URL: HANDSHAKE.stalwartUrl,
  GILBERT_AGENT_ADDRESS: HANDSHAKE.masterAddress,
  GILBERT_AGENT_PASSWORD: HANDSHAKE.masterPassword,
  /*
   * The prefix the bundle was built for is stated by every real deployment
   * (the image states it, from the build argument), so the configurations that
   * mean to serve here state it too: an empty value is the domain root.
   */
  BASE_PATH: "",
};

/** A secret long enough to be one, and never a literal this repository ships. */
const A_SECRET = "an-installation-secret-long-enough-to-seal-a-session-with";

/** The container's own facts, as the ordinary container states them. */
const CONTAINER = { immutable: false };

/** A document as a boot would read it: text the validator accepts, or a loud failure here. */
function documentFrom(text: string): InstallationDocument {
  const parsed = parseInstallationDocumentDetailed(text);
  if ("problem" in parsed)
    throw new Error(`the document under test is not readable: ${parsed.problem}`);
  return parsed.doc;
}

/** A document as its sections, with a secret, so what is parsed here is one a boot would read. */
function documentFromJson(parts: Record<string, unknown>): InstallationDocument {
  return documentFrom(JSON.stringify({ ...parts, secret: parts.secret ?? A_SECRET }));
}

/**
 * One real boot over a document held in memory: the sign-in is the only stub.
 *
 * This is the thread as a deployment gets it — validator, document resolution
 * and the spread over the environment in `bootInstallation` — rather than the
 * shape this file builds by hand.
 */
async function bootWith(env: InstallationEnvironment, document: string): Promise<Config> {
  const boot = await bootInstallation({
    env,
    log: () => {},
    signIn: (async (handshake: Handshake) => ({
      address: handshake.masterAddress,
      authorization: "Basic c3R1Yg==",
      session: {},
    })) as never,
    store: () =>
      ({
        accountId: "a1",
        read: async () => document,
        state: async () => "state-1",
        write: async () => {},
      }) as never,
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as never,
  });
  return boot.configuration;
}

/**
 * A configuration as a boot resolves one: the environment's own, the
 * installation document's over it, and the agent merged field by field — the
 * one section both paths own fields of.
 */
function servedConfiguration(
  env: InstallationEnvironment,
  document: InstallationDocument,
): Config {
  const fromEnvironment = configurationFromEnvironment(env);
  const installation = configurationFrom(document, CONTAINER, HANDSHAKE);
  return {
    ...fromEnvironment,
    ...installation,
    agent: { ...fromEnvironment.agent, ...installation.agent },
  };
}

/**
 * `IMMUTABLE`, and what it is a claim about (ADR 0001).
 *
 * It says the container is read-only and keeps nothing durable of its own. It
 * is checked rather than taken on trust, because setting the variable while
 * forgetting `--read-only` is the easy mistake and an instance that believed
 * it would look healthy while writing where the next image will not look.
 * Nothing Gilbert holds durably is on this filesystem any more — sessions, the
 * policy and the lock are documents in Stalwart — so what is left to check is
 * the property itself.
 */

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "gilbert-immutable-"));
}

test("IMMUTABLE refuses a writable root, and leaves no probe behind", () => {
  const root = tempRoot();
  try {
    assert.throws(() => assertImmutable(root), /is writable/);
    assert.equal(existsSync(join(root, ".immutable-probe")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IMMUTABLE accepts a root it cannot write to", () => {
  const root = tempRoot();
  try {
    chmodSync(root, 0o555);
    assert.doesNotThrow(() => assertImmutable(root));
  } finally {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Where the app secret came from, and the one deployment that cannot run on it
 * (`assertServable`).
 *
 * The refusal is made on data, not on an import seeing an empty string: an
 * ephemeral secret is exactly as long as a stated one, and what decides the
 * question is `appSecretSource`. Running it after the boot has read the
 * installation's own document is what makes it refuse the right deployments.
 */
test("production cannot serve on an ephemeral secret, and can on one the installation's document supplies", () => {
  const production: InstallationEnvironment = {
    ...HANDSHAKE_ENV,
    NODE_ENV: "production",
  };

  const bootless = configurationFromEnvironment(production);
  assert.equal(bootless.production, true, "the resolver computes it from NODE_ENV");
  assert.equal(bootless.appSecretSource, "ephemeral", "nothing stated a secret");
  assert.ok(
    bootless.appSecret.length >= 32,
    "an ephemeral secret is a real secret, not an empty string: that is why the refusal is about its source",
  );
  assert.throws(() => assertServable(bootless), /ephemeral secret/);

  const inTheDocument = {
    ...installationDefaults(),
    secret: A_SECRET,
  };
  const served = servedConfiguration(production, inTheDocument);
  assert.equal(served.appSecret, A_SECRET, "the document decides the secret");
  assert.equal(served.appSecretSource, "document");
  assert.doesNotThrow(() => assertServable(served));

  const stated = configurationFromEnvironment({
    ...production,
    APP_SECRET: "a-secret-this-deployment-stated-itself-32-bytes",
  });
  assert.equal(stated.appSecretSource, "environment");
  assert.doesNotThrow(() => assertServable(stated));
});

test("the placeholder is not a secret any more than an empty value is", () => {
  const placeholder = configurationFromEnvironment({
    ...HANDSHAKE_ENV,
    NODE_ENV: "production",
    APP_SECRET: "change-me",
  });
  assert.equal(placeholder.appSecretSource, "ephemeral");
  assert.notEqual(placeholder.appSecret, "change-me");
  assert.throws(() => assertServable(placeholder), /ephemeral secret/);
});

test("production without a secret anywhere is not refused where nobody serves it", () => {
  assert.doesNotThrow(() =>
    assertServable(
      configurationFromEnvironment({ ...HANDSHAKE_ENV, NODE_ENV: "development" }),
    ),
  );
});

test("adopting a configuration with no app secret at all is refused", () => {
  const empty = { ...configurationFromEnvironment(HANDSHAKE_ENV), appSecret: "" };
  assert.throws(() => useConfiguration(empty), /no app secret/);
});

/**
 * The model the installation chose, and the switch it may not choose.
 *
 * The document's `agent` section is where the installation's one model lives
 * (ADR 0009, 0038): an installation that has chosen none has no agent. What the
 * document may **not** decide is whether that model may sit inside the
 * deployment's own network — that is a security decision the deployment makes,
 * so it is read from the environment and never from the document. The document
 * is a whole-JSON file an administrator can hand-edit, and one that carries an
 * `allowPrivateProvider` under `agent` is read with that key ignored: unknown
 * keys are dropped by the validator rather than refused, so it neither decides
 * anything nor keeps the installation from booting.
 */
test("the model is the document's, and the switch over where it may sit is not", () => {
  const chosen = documentFromJson({
    agent: {
      provider: {
        provider: "ollama",
        model: "a-small-model",
        baseUrl: "https://models.example.com/v1",
        apiKey: "sk-a-key-the-surface-never-reads-back",
      },
    },
  });
  assert.deepEqual(
    chosen.agent.provider,
    {
      provider: "ollama",
      model: "a-small-model",
      baseUrl: "https://models.example.com/v1",
      apiKey: "sk-a-key-the-surface-never-reads-back",
    },
    "the installation's model is chosen in the document",
  );
  const none = documentFromJson({});
  assert.equal(
    none.agent.provider,
    undefined,
    "and an installation that has chosen none has no agent",
  );

  const saysYes = documentFromJson({ agent: { allowPrivateProvider: true } });
  assert.equal(
    saysYes.agent.provider,
    undefined,
    "a document cannot grant the installation a model by stating the switch",
  );

  const served = servedConfiguration(HANDSHAKE_ENV, saysYes);
  assert.equal(
    served.agent.allowPrivateProvider,
    false,
    "a document cannot grant the installation the right to aim its model inside the network",
  );

  const operatorSaysYes: InstallationEnvironment = {
    ...HANDSHAKE_ENV,
    GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER: "1",
  };
  assert.equal(
    servedConfiguration(operatorSaysYes, saysYes).agent.allowPrivateProvider,
    true,
    "the environment's value is the one that counts",
  );
  const saysNo = documentFromJson({ agent: { allowPrivateProvider: false } });
  assert.equal(
    servedConfiguration(operatorSaysYes, saysNo).agent.allowPrivateProvider,
    true,
    "and a document that says no does not veto what the operator stated",
  );
});

/**
 * Two settings that are the installation's rather than the environment's: how
 * much traffic one session may make, and what the session cookie is called.
 *
 * Both are decisions of the installation — a name its own users' browsers
 * carry, and a budget on its own proxy — so both are fields of its document,
 * under the names, defaults and notes the environment variables had. The
 * environment's read stays what it is for every other document field: the value
 * a process with no boot runs on.
 */
test("the data-path rate limit and the cookie name come from the document, and from the environment without a boot", () => {
  const env: InstallationEnvironment = {
    ...HANDSHAKE_ENV,
    API_RATE_LIMIT: "7",
    COOKIE_NAME: "deployment_session",
  };
  const bootless = configurationFromEnvironment(env);
  assert.equal(
    bootless.apiRateLimit,
    7,
    "a process with no boot runs on the environment's copy",
  );
  assert.equal(bootless.cookieName, "deployment_session");

  const document = documentFromJson({
    server: { cookieName: "gilbert_session" },
    limits: { apiRateLimit: 321 },
  });
  const served = servedConfiguration(env, document);
  assert.equal(
    served.apiRateLimit,
    321,
    "the document decides, not the environment beside it",
  );
  assert.equal(served.cookieName, "gilbert_session");
});

test("a document that states neither takes the values a bootless process runs on", () => {
  const bootless = configurationFromEnvironment({
    ...HANDSHAKE_ENV,
    APP_SECRET: A_SECRET,
  });
  const defaults = installationDefaults();
  assert.equal(defaults.limits.apiRateLimit, bootless.apiRateLimit);
  assert.equal(defaults.server.cookieName, bootless.cookieName);
});

/*
 * A setting that is half a number is not a number.
 *
 * `Number.parseInt` reads up to the first character it cannot use, so an
 * operator's `SESSION_TTL="1e3"` became a 1-second TTL and `1200/min` became
 * 1200 -- a value silently other than the one stated, in a budget or a TTL
 * where the difference is the whole point. The whole value has to be an
 * integer or the boot is refused.
 */
test("an integer setting with trailing characters is refused, not truncated", () => {
  for (const [name, v] of [
    ["SESSION_TTL", "1e3"],
    ["API_RATE_LIMIT", "1200/min"],
    ["UPSTREAM_TIMEOUT", "30s"],
  ] as const) {
    assert.throws(
      () => configurationFromEnvironment({ ...HANDSHAKE_ENV, [name]: v }),
      new RegExp(`Invalid integer for ${name}`),
      `${name}=${v} is not an integer`,
    );
  }
  assert.equal(
    configurationFromEnvironment({ ...HANDSHAKE_ENV, SESSION_TTL: "3600" }).sessionTtl,
    3600,
    "a plain integer is still read",
  );
});

/*
 * A session TTL below one is a typo, not a request for a session that expires
 * before it is read.
 *
 * The record would be written already stale, so sign-in looks successful and
 * the very next request is a 401 with nothing naming the cause. The
 * installation's own document refuses a duration below its minimum rather than
 * flooring it (`readAtLeast`, `shared/installation.ts`), and this path must not
 * disagree.
 */
test("a session TTL below one is refused, not accepted", () => {
  for (const name of ["SESSION_TTL", "SESSION_REMEMBER_TTL"] as const) {
    for (const v of ["0", "-1"]) {
      assert.throws(
        () => configurationFromEnvironment({ ...HANDSHAKE_ENV, [name]: v }),
        new RegExp(`Invalid value for ${name}: ${v} is below 1`),
        `${name}=${v} would expire a session the moment it is written`,
      );
    }
  }
});

test("a boot runs on the document's values, and never on the document's provider switch", async () => {
  const env: InstallationEnvironment = {
    ...HANDSHAKE_ENV,
    NODE_ENV: "production",
    COOKIE_NAME: "deployment_session",
    API_RATE_LIMIT: "7",
  };
  const configuration = await bootWith(
    env,
    JSON.stringify({
      server: { cookieName: "gilbert_session" },
      limits: { apiRateLimit: 321 },
      agent: { allowPrivateProvider: true },
      secret: A_SECRET,
    }),
  );

  assert.equal(
    configuration.cookieName,
    "gilbert_session",
    "the document decides the name",
  );
  assert.equal(configuration.apiRateLimit, 321, "and the budget");
  assert.equal(
    configuration.agent.allowPrivateProvider,
    false,
    "the allowPrivateProvider key in that document grants nothing: the switch is the environment's",
  );
  assert.equal(configuration.appSecretSource, "document");
  assert.doesNotThrow(
    () => assertServable(configuration),
    "a document-supplied secret serves",
  );
});

/*
 * A field that is present and wrong is a problem, not a silent fallback (see
 * the parser's own doc). An absent duration or limit takes its default; a
 * negative one is not a duration at all -- it would make `AbortSignal.timeout`
 * throw, or a rate limiter refuse every request, the moment a boot read the
 * document.
 */
test("a duration or limit that is present and negative is refused", () => {
  for (const parts of [
    { epoch: -1 },
    { limits: { upstreamTimeout: -1 } },
    { limits: { maxUploadBytes: -1 } },
    { limits: { loginRateLimit: -1 } },
    { limits: { apiRateLimit: -1 } },
    { sessions: { ttl: -1 } },
    { sessions: { rememberTtl: -1 } },
  ]) {
    const parsed = parseInstallationDocumentDetailed(
      JSON.stringify({ ...parts, secret: A_SECRET }),
    );
    assert.ok("problem" in parsed, `${JSON.stringify(parts)} is refused`);
  }
});

test("zero is a statement where it is one, and a port stays in range", () => {
  // The data path's rate limiter reads 0 as "off", and that zero is kept, not
  // floored; a port in the document is held to its range.
  const off = documentFromJson({
    limits: { apiRateLimit: 0 },
  });
  assert.equal(off.limits.apiRateLimit, 0);

  const tooHigh = parseInstallationDocumentDetailed(
    JSON.stringify({ server: { port: 70000 }, secret: A_SECRET }),
  );
  assert.ok("problem" in tooHigh, "a port above 65535 is not a port");
});

/*
 * The prefix the bundle was built for is a fact about the image, not a
 * decision of the installation: the web build bakes it into its asset URLs, so
 * a server on another prefix serves a page that cannot load its own scripts.
 */
test("a document cannot move the prefix the build was made for", async () => {
  const booted = await bootWith(
    { ...HANDSHAKE_ENV, BASE_PATH: "/webmail" },
    JSON.stringify({ server: { basePath: "" }, secret: A_SECRET }),
  );
  assert.equal(
    booted.basePath,
    "/webmail",
    "the environment's prefix survives a document that says otherwise",
  );
  assert.equal(booted.basePathStated, true);
});

/*
 * One set of defaults, not two.
 *
 * The environment is read *over* the installation's own defaults, and those
 * defaults are the document's -- `installationDefaults()` is what a fresh
 * installation writes and what its administration shows. So a process with no
 * environment and an installation that has just created its document describe
 * the same installation, field for field. Nothing compared the two while the
 * literals stood in both places, which is how a default moved in one and not
 * in the other left an installation depending on how it was started.
 *
 * The fields listed are exactly the ones both sides carry: the container's own
 * facts (`HOST`, `PORT`, `IMMUTABLE`, `BASE_PATH`, `STATIC_DIR`) are the
 * process's and are no part of a document, and the handshake has no default at
 * all.
 */
test("a silent environment resolves to the document's own defaults", () => {
  const c = configurationFromEnvironment({});
  const d = installationDefaults();
  assert.equal(c.appName, d.branding.appName);
  assert.equal(c.host, d.server.host);
  assert.equal(c.port, d.server.port);
  assert.equal(c.trustProxy, d.server.trustProxy);
  assert.equal(c.secureCookies, d.server.secureCookies);
  assert.equal(c.compressJmap, d.server.compressJmap);
  assert.equal(c.cookieName, d.server.cookieName);
  assert.equal(c.sessionTtl, d.sessions.ttl);
  assert.equal(c.sessionRememberTtl, d.sessions.rememberTtl);
  assert.equal(c.upstreamTimeout, d.limits.upstreamTimeout);
  assert.equal(c.maxUploadBytes, d.limits.maxUploadBytes);
  assert.equal(c.imageProxy, d.limits.imageProxy);
  assert.equal(c.loginRateLimit, d.limits.loginRateLimit);
  assert.equal(c.apiRateLimit, d.limits.apiRateLimit);
  assert.equal(c.pushMode, d.push.mode);
  assert.equal(c.rawPushRelay, d.push.rawRelay);
});

test("a production process refuses to serve a prefix nobody stated", () => {
  /* A secret of its own, so the only thing in question here is the prefix. */
  const { BASE_PATH: _stated, ...rest } = HANDSHAKE_ENV;
  const env: Record<string, string | undefined> = {
    ...rest,
    NODE_ENV: "production",
    APP_SECRET: A_SECRET,
  };
  assert.throws(
    () => assertServable(configurationFromEnvironment(env)),
    /BASE_PATH is not set/,
    "nothing in the environment tells this process what prefix its bundle asks for",
  );
  assert.doesNotThrow(
    () => assertServable(configurationFromEnvironment({ ...env, BASE_PATH: "" })),
    "an empty prefix is a statement: the domain root",
  );
});
