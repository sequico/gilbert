/**
 * Whether the installation's agent works at all.
 *
 * One document in the Master's app folder, beside the runs it governs: a person
 * turns the agent off from Administration and every process reads it on the next
 * pass. Absent means on — a deployment that never chose has an agent, which is
 * what the product shipped — and a document that cannot be read is on for the
 * same reason: a broken switch must not silently disable the feature.
 */

import { type Ctx, readAppFileAt, writeAppFileAt } from "../appFolder.js";
import { errorMessage } from "../shared/errors.js";

/** Where the switch lives, under the app folder. */
export const AGENT_SWITCH_FILE = "agent/switch.json";

export interface AgentSwitch {
  enabled: boolean;
}

export async function readAgentSwitch(ctx: Ctx, accountId: string): Promise<AgentSwitch> {
  /*
   * Absent is on — a deployment that never chose has the agent it shipped —
   * but a switch that is **there and unreadable** is not absent: reading it as
   * on would re-enable an agent somebody turned off, which is the one direction
   * of this failure that acts. It stops the pass instead, and the reason is the
   * pass's gap.
   */
  let found: Awaited<ReturnType<typeof readAppFileAt>>;
  try {
    found = await readAppFileAt(ctx, accountId, AGENT_SWITCH_FILE);
  } catch (err) {
    throw new Error(
      `The agent's switch is there and cannot be read, so the agent does not act: ${errorMessage(err)}`,
    );
  }
  if (!found) return { enabled: true };
  try {
    const doc = JSON.parse(found.text) as { enabled?: unknown };
    return { enabled: doc.enabled !== false };
  } catch {
    throw new Error(
      "The agent's switch is not a document this build can read, so the agent does not act; it has been left exactly as it is.",
    );
  }
}

export async function writeAgentSwitch(
  ctx: Ctx,
  accountId: string,
  enabled: boolean,
): Promise<void> {
  await writeAppFileAt(ctx, accountId, AGENT_SWITCH_FILE, { v: 1, enabled });
}
