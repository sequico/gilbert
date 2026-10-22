/**
 * Whether the installation's agent works at all.
 *
 * One document in the Master's app folder, beside the runs it governs: a person
 * turns the agent off from Administration and every process reads it on the next
 * pass. Absent means on — a deployment that never chose has an agent, which is
 * what the product shipped. A document that is **there and unreadable** is not
 * absent: it stops the pass rather than being read as on (which would re-enable
 * an agent somebody turned off) or as off (which would disable one silently).
 */

import { type Ctx, readAppFileAt, writeAppFileAt } from "../appFolder.js";
import { errorMessage } from "../shared/errors.js";

/** Where the switch lives, under the app folder. */
export const AGENT_SWITCH_FILE = "agent/switch.json";

export interface AgentSwitch {
  enabled: boolean;
}

/**
 * The last value this process read or wrote.
 *
 * A surface that names the switch (the chat's header, for every member) would
 * otherwise cost a session of the Master per reader: the pass refreshes this on
 * every run — even one with no model, so a member's net is answered while the
 * agent is idle — a write updates it, and a reader told that the file changed
 * asks for a fresh read instead. One installation per process: every reader
 * names the same account.
 */
let lastKnown: AgentSwitch | null = null;

/** The switch as this process last read or wrote it, or null before any read. */
export function rememberedAgentSwitch(): AgentSwitch | null {
  return lastKnown;
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
    // An unreadable document is not a value: the last good one must not answer
    // for it, or an agent that refuses to act would read as on (or off).
    lastKnown = null;
    throw new Error(
      `The agent's switch is there and cannot be read, so the agent does not act: ${errorMessage(err)}`,
    );
  }
  if (!found) {
    lastKnown = { enabled: true };
    return lastKnown;
  }
  try {
    const doc = JSON.parse(found.text) as { enabled?: unknown };
    lastKnown = { enabled: doc.enabled !== false };
    return lastKnown;
  } catch {
    lastKnown = null;
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
  lastKnown = { enabled };
}
