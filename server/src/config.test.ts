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
 * what (ADR 0001, ADR 0003).
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
 * policy, the lock and the agent's records are documents in Stalwart — so what
 * is left to check is the property itself.
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
 * The refusal used to be made at the import of `configuration.ts`, on the
 * string being empty — before the boot could read the installation's own
 * document, which is where a deployment states the secret now, so it refused
 * exactly the deployments this path exists for. It is made on data instead: an
 * ephemeral secret is exactly as long as a stated one, and what decides the
 * question is `appSecretSource`.
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
 * The operator's switch, which an installation may not grant itself.
 *
 * Whether the installation's model may sit inside the deployment's own network
 * is a security decision the deployment makes, so it is read from the
 * environment and never from the document. The document is a whole-JSON file an
 * administrator can hand-edit, and one that still carries the field — written
 * by a build that had it — is read as though it did not: unknown keys are
 * ignored by the validator rather than refused, so the retired key neither
 * decides anything nor keeps the installation from booting.
 */
test("a document that still carries the retired provider switch loads, and does not decide it", () => {
  const saysYes = documentFromJson({ agent: { allowPrivateProvider: true } });
  assert.equal(
    "allowPrivateProvider" in saysYes.agent,
    false,
    "the document has no such field: the switch is the operator's",
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
 * Two settings that stopped being the environment's: how much traffic one
 * session may make, and what the session cookie is called.
 *
 * Both are decisions of the installation — a name its own users' browsers
 * carry, and a budget on its own proxy — so both live in the document now, with
 * the names, defaults and notes they had as variables. The environment's read
 * stays what it always was for every other document field: the value a process
 * with no boot runs on.
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
      agent: { allowPrivateProvider: true, pages: 4 },
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
    configuration.agent.maxPages,
    4,
    "the agent's own fields are the document's too",
  );
  assert.equal(
    configuration.agent.allowPrivateProvider,
    false,
    "the retired key in that document grants nothing: the switch is the environment's",
  );
  assert.equal(configuration.appSecretSource, "document");
  assert.doesNotThrow(
    () => assertServable(configuration),
    "a document-supplied secret serves",
  );
});
