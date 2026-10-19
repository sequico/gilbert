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

/** Where the switch lives, under the app folder. */
export const AGENT_SWITCH_FILE = "agent/switch.json";

export interface AgentSwitch {
  enabled: boolean;
}

export async function readAgentSwitch(ctx: Ctx, accountId: string): Promise<AgentSwitch> {
  try {
    const found = await readAppFileAt(ctx, accountId, AGENT_SWITCH_FILE);
    if (!found) return { enabled: true };
    const doc = JSON.parse(found.text) as { enabled?: unknown };
    return { enabled: doc.enabled !== false };
  } catch {
    return { enabled: true };
  }
}

export async function writeAgentSwitch(
  ctx: Ctx,
  accountId: string,
  enabled: boolean,
): Promise<void> {
  await writeAppFileAt(ctx, accountId, AGENT_SWITCH_FILE, { v: 1, enabled });
}
