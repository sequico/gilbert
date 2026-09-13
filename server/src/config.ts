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
 */
export function useConfiguration(next: Config): void {
  config = next;
  if (config.immutable) assertImmutable(fileURLToPath(new URL("../..", import.meta.url)));
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
