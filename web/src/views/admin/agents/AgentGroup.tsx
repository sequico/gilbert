import type { FactDoc } from "@/lib/agentAdmin";
import { GroupInstructionPanel } from "./GroupInstruction";
import { GroupRuns } from "./GroupRuns";

/** One group the agent is a member of: what it was told, and what it worked. */
export function AgentGroup({
  group,
  accountId,
  facts,
}: {
  group: string;
  accountId?: string;
  facts: readonly FactDoc[];
}) {
  return (
    <div>
      <GroupInstructionPanel group={group} />
      <div style={{ marginTop: 24 }}>
        <GroupRuns group={group} accountId={accountId} facts={facts} />
      </div>
    </div>
  );
}
