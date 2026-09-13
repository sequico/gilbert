import { unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, environmentConfiguration } from "./configuration.js";

export type { Config };

/**
 * The configuration this process runs on.
 *
 * It begins as the environment's, which is what an import with no boot gets — a
 * test, a tool, a development server — and a deployment replaces it once, at
 * boot, with what the installation's own document says (`useConfiguration`).
 * Every reader holds it through this binding, so the replacement is what they
 * see: there is one configuration in a process, and one place it comes from.
 */
export let config: Config = environmentConfiguration();

/**
 * Adopt the installation's own configuration, once the boot has read it.
 *
 * The immutable claim is probed here rather than where the value is read,
 * because this is the moment an installation states it: a container that says
 * it runs read-only has that claim checked against the filesystem it is really
 * on, and one that only meant to say it fails at boot instead of keeping what
 * the next image will not find.
 *
 * A configuration with no secret at all is refused here as well, because this
 * is the one door a configuration comes in by: every session this process
 * stores is sealed with that secret, so a served process running on an empty
 * one would sign everybody out at its next restart. Whether a secret that is
 * *there* is one that survives a restart is the deployment's question, asked
 * by `assertServable` where the deployment is known (`index.ts`).
 */
export function useConfiguration(next: Config): void {
  if (!next.appSecret.trim())
    throw new Error(
      "Refusing a configuration with no app secret: every session this process stores is sealed with it, so an " +
        "empty one would sign everybody out at the next restart. Set APP_SECRET in the deployment, or let the " +
        'installation\'s own document carry one in "secret" — the first boot writes a generated one.',
    );
  config = next;
  if (config.immutable) assertImmutable(fileURLToPath(new URL("../..", import.meta.url)));
}

/**
 * Refuse a configuration a served process cannot run on: a secret nothing will
 * find again.
 *
 * This is the refusal the resolver used to make at an import, before the boot
 * could read the installation's own document — where a deployment states the
 * secret now. It is made on data instead of on a string being empty, because an
 * ephemeral secret is exactly as long as a stated one: what matters is where it
 * came from (`appSecretSource`), and only production cares, since a development
 * server or a tool signs in again anyway.
 *
 * Called by `index.ts` after the boot has run, so the answer is the one a
 * deployment deserves: a boot failure, logged with everything else that stopped
 * the process, rather than a crash at the import of this module — which
 * refused exactly the deployments that state their secret in the document.
 */
export function assertServable(configuration: Config): void {
  if (configuration.production && !configuration.basePathStated)
    throw new Error(
      "This process would serve without knowing the prefix its bundle was built for: BASE_PATH is not set. " +
        "The web build bakes that prefix into its asset URLs, so a server on a different one serves a page " +
        'that cannot load its own scripts. Set BASE_PATH to the prefix the build used ("" is the domain root).',
    );
  if (configuration.production && configuration.appSecretSource === "ephemeral")
    throw new Error(
      "This process would serve production on an ephemeral secret: APP_SECRET is not set and the installation's " +
        "own document supplied none either, so no restart could read a session this one signed. Set APP_SECRET in " +
        'the deployment, or let the installation\'s own document carry one in "secret".',
    );
}

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
if (config.immutable) assertImmutable(fileURLToPath(new URL("../..", import.meta.url)));

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
