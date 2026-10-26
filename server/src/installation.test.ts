import assert from "node:assert/strict";
import { test } from "node:test";
import type { InstallationStore } from "./installation.js";
import {
  INSTALLATION_EPOCH_START,
  type InstallationDocument,
  installationDefaults,
} from "./shared/installation.js";

process.env.STALWART_URL = "http://127.0.0.1:1";
const { readInstallation } = await import("./installation.js");

/**
 * The first boot of an installation.
 *
 * The document's secret is what every stored session is sealed with, so the one
 * thing a first boot must never do is believe it wrote a secret another boot
 * overwrote: two boots starting at once (a rolling deploy) both find no
 * document, and the one that ends up stored decides the secret. These tests
 * drive that race through the store seam, with no server involved.
 */

/** The document another boot wrote, distinguishable by its secret. */
function otherBootDocument(secret: string): string {
  return JSON.stringify({ ...installationDefaults(), secret });
}

/** A store whose answers the test controls, and which records what was written. */
function fakeStore(overrides: Partial<InstallationStore> = {}): InstallationStore & {
  writes: Array<{ document: InstallationDocument; ifInState?: string }>;
} {
  const writes: Array<{ document: InstallationDocument; ifInState?: string }> = [];
  return {
    accountId: "a1",
    read: async () => null,
    state: async () => "state-1",
    write: async (document, opts) => {
      writes.push({ document, ifInState: opts?.ifInState });
    },
    ...overrides,
    writes,
  };
}

test("the first boot creates the document, conditionally on the account's state", async () => {
  let stored: string | null = null;
  const store = fakeStore({
    read: async () => stored,
    write: async (document, opts) => {
      store.writes.push({ document, ifInState: opts?.ifInState });
      stored = JSON.stringify(document);
    },
  });

  const loaded = await readInstallation(store);

  assert.equal(loaded.created, true);
  assert.equal(loaded.document.epoch, INSTALLATION_EPOCH_START);
  assert.equal(store.writes.length, 1, "one write: the document itself");
  assert.equal(
    store.writes[0]?.ifInState,
    "state-1",
    "the create carries the state it read, so a later writer loses the race rather than being overwritten",
  );
});

test("a run's step limit is read from the document, and its absence the default", async () => {
  const defaults = installationDefaults();
  const { maxRunSteps: _held, ...withoutSteps } = defaults.limits;
  const sized = {
    ...defaults,
    secret: "a-secret-long-enough-to-seal-a-session",
    limits: { ...defaults.limits, maxRunSteps: 2 },
  };
  const loaded = await readInstallation(
    fakeStore({ read: async () => JSON.stringify(sized) }),
  );
  assert.equal(
    loaded.document.limits.maxRunSteps,
    2,
    "the document's value is what the run records",
  );

  const inherited = await readInstallation(
    fakeStore({
      read: async () =>
        JSON.stringify({
          ...defaults,
          secret: "a-secret-long-enough-to-seal-a-session",
          limits: withoutSteps,
        }),
    }),
  );
  assert.equal(
    inherited.document.limits.maxRunSteps,
    defaults.limits.maxRunSteps,
    "a document that names no step limit keeps the default",
  );
});

test("a document that is already there is adopted, not replaced", async () => {
  const store = fakeStore({
    read: async () => otherBootDocument("somebody-elses-secret"),
  });

  const loaded = await readInstallation(store);

  assert.equal(loaded.created, false);
  assert.equal(loaded.document.secret, "somebody-elses-secret");
  assert.equal(store.writes.length, 0, "an existing document is never written over");
});

test("a first-boot create that loses the compare-and-set adopts the boot that won", async () => {
  // The first conditional write is refused as a lost race -- the app folder
  // being created moves the state, or another boot wrote -- and the document
  // the next read finds is the one whose secret must be signed with.
  let stored: string | null = null;
  let writes = 0;
  const store = fakeStore({
    state: async () => "state-1",
    read: async () => stored,
    write: async (document, opts) => {
      writes++;
      store.writes.push({ document, ifInState: opts?.ifInState });
      if (writes === 1) {
        stored = otherBootDocument("the-winner");
        throw Object.assign(new Error("stale state"), { type: "stateMismatch" });
      }
      stored = JSON.stringify(document);
    },
  });

  const loaded = await readInstallation(store);

  assert.equal(loaded.created, false, "this boot did not create it");
  assert.equal(
    loaded.document.secret,
    "the-winner",
    "the stored secret is the one to sign with, not this boot's generated one",
  );
  assert.equal(writes, 1, "the losing write is not retried once the winner is read back");
});

test("a create that reports success without a node is retried, then refused", async () => {
  // A create that lost a name race can answer success with no node: the write
  // resolves, nothing is stored, and the read is what says so. Without the
  // retry the boot would return a secret nothing else holds.
  let writes = 0;
  const store = fakeStore({
    read: async () => null,
    write: async () => {
      writes++;
    },
  });

  await assert.rejects(() => readInstallation(store), /kept winning the race/);
  assert.ok(writes > 1, "the failed create was retried, not accepted");
});

test("an account that will not state its Files refuses the first boot rather than racing", async () => {
  let wrote = false;
  const store = fakeStore({
    state: async () => "",
    write: async () => {
      wrote = true;
    },
  });

  await assert.rejects(
    () => readInstallation(store),
    /would not state the state of its Files/,
  );
  assert.equal(wrote, false, "an unconditional create is exactly the race this prevents");
});
