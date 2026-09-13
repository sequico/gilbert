import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BootConfiguration,
  bootInstallation,
  type Handshake,
  type InstallationEnvironment,
  readHandshake,
} from "./bootstrap.js";
import { INSTALLATION_VERSION } from "./shared/installation.js";

/**
 * The boot: the handshake, the sign-in, the installation's own document
 * (ADR 0001, ADR 0003).
 *
 * Three values come from the environment and nothing else, because they are
 * how Stalwart is reached at all; everything the installation decides lives in
 * one document in the Master account's own `gilbert` app folder, written on
 * the first boot and read back on every later one. This is the check that the
 * boundary holds: a missing handshake names itself, a document that is absent
 * is created once and kept, a value changed in it changes what this process
 * runs on, and a document that is there but unreadable is refused rather than
 * quietly replaced by the defaults.
 */

const ENV: InstallationEnvironment = {
  STALWART_URL: "https://mail.example.com/",
  GILBERT_AGENT_ADDRESS: "Gilbert@Example.com",
  GILBERT_AGENT_PASSWORD: "a-password",
};

/** The Master's sign-in, stubbed: nothing in these tests talks to a server. */
const signIn = async (handshake: Handshake) =>
  ({
    address: handshake.masterAddress,
    authorization: "Basic c3R1Yg==",
    session: {},
  }) as never;

/** The account's own document, in memory: read, state, write, and nothing else. */
function memoryStore(initial: string | null = null) {
  let text = initial;
  let writes = 0;
  return {
    accountId: "a1",
    read: async (): Promise<string | null> => text,
    state: async (): Promise<string> => "state-1",
    write: async (doc: unknown): Promise<void> => {
      text = JSON.stringify(doc);
      writes++;
    },
    text: (): string | null => text,
    set: (value: unknown): void => {
      text = JSON.stringify(value);
    },
    writes: (): number => writes,
  };
}

async function boot(
  store: ReturnType<typeof memoryStore>,
  logs: string[] = [],
  env: InstallationEnvironment = ENV,
): Promise<BootConfiguration> {
  return bootInstallation({
    env,
    log: (line) => logs.push(line),
    signIn,
    store: () => store as never,
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as never,
  });
}

test("a missing handshake variable is named, and is not looked for in Stalwart", () => {
  assert.throws(
    () => readHandshake({}),
    (err: Error) =>
      err.message.includes("STALWART_URL is not set") &&
      err.message.includes("cannot come from Stalwart"),
  );
  assert.throws(
    () => readHandshake({ STALWART_URL: "https://mail.example.com" }),
    /GILBERT_AGENT_ADDRESS is not set/,
  );
  assert.throws(
    () => readHandshake({ ...ENV, GILBERT_AGENT_PASSWORD: "   " }),
    /GILBERT_AGENT_PASSWORD is not set/,
  );
});

test("the handshake is normalised the way the rest of the code compares it", () => {
  const handshake = readHandshake(ENV);
  assert.equal(handshake.stalwartUrl, "https://mail.example.com");
  assert.equal(handshake.masterAddress, "gilbert@example.com");
  assert.equal(handshake.masterPassword, "a-password");
});

test("the first boot writes the document, and the next one reads the same document", async () => {
  const store = memoryStore();
  const logs: string[] = [];
  const first = await boot(store, logs);
  assert.equal(first.created, true);
  assert.equal(first.installation.version, INSTALLATION_VERSION);
  assert.equal(store.writes(), 1, "one write: the document itself");
  assert.match(logs.join("\n"), /created/);

  const second = await boot(store, []);
  assert.equal(second.created, false);
  assert.deepEqual(second.installation, first.installation);
  assert.equal(second.accountId, first.accountId);
});

test("a value changed in the document changes what this process runs on", async () => {
  const store = memoryStore();
  const first = await boot(store);
  assert.equal(first.configuration.agent.pollMs, first.installation.agent.poll);
  assert.equal(first.configuration.port, first.installation.server.port);

  const edited = structuredClone(first.installation);
  edited.agent.poll = 9000;
  edited.server.port = 9090;
  store.set(edited);

  const after = await boot(store);
  assert.equal(after.configuration.agent.pollMs, 9000);
  assert.equal(
    after.configuration.port,
    9090,
    "the document decides when the container is silent",
  );
  assert.equal(after.created, false, "and an edited document is still a document");
});

test("the container's own facts win over the document", async () => {
  const store = memoryStore();
  const first = await boot(store);
  const edited = structuredClone(first.installation);
  edited.server.port = 9090;
  store.set(edited);

  const after = await boot(store, [], { ...ENV, PORT: "7777" });
  assert.equal(
    after.configuration.port,
    7777,
    "a container does not choose its own port",
  );
});

test("a document that is there but unreadable is refused, and left alone", async () => {
  const store = memoryStore("{ this is not the document");
  const logs: string[] = [];
  await assert.rejects(() => boot(store, logs), /exit 1/);
  assert.equal(store.text(), "{ this is not the document", "nothing was written over it");
  assert.equal(store.writes(), 0);
  assert.match(logs.join("\n"), /fatal/);
});

test("the app secret is generated once and is nobody's literal", async () => {
  const store = memoryStore();
  const logs: string[] = [];
  const first = await boot(store, logs);
  const secret = first.configuration.appSecret;
  assert.ok(secret.length >= 32, "a secret long enough to sign with");
  assert.notEqual(secret, "change-me");
  assert.ok(!logs.join("\n").includes(secret), "and it is never written to the log");

  const second = await boot(store);
  assert.equal(
    second.configuration.appSecret,
    secret,
    "a redeploy does not sign everyone out",
  );
});
