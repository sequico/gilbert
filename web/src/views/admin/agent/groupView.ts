/**
 * The group's agent documents, read once for the admin tabs that show them.
 *
 * `GroupAudit` and `GroupKnowledge` read the same granted view, in the same
 * order, with the same busy/problem state and the same automation-name lookup.
 * One reader, so "what this group's agent did" cannot be ordered or named two
 * ways depending on which tab is open.
 */
import { useEffect } from "react";
import { agentViewKey, groupOperation, useAgents } from "@/store/agents";
import { automationText } from "@/views/agent/agentText";

export function useGroupView(group: string, known: boolean) {
  const groupViews = useAgents((s) => s.groupViews);
  const busyReads = useAgents((s) => s.busy);
  const problems = useAgents((s) => s.problems);
  const loadGroup = useAgents((s) => s.loadGroup);

  const op = group ? groupOperation(group) : "";
  const view = group ? groupViews[agentViewKey(group)] : undefined;
  const loading = op ? busyReads[op] === true : false;
  const problem = op ? (problems[op] ?? null) : null;

  useEffect(() => {
    if (group && known) void loadGroup(group);
  }, [group, known, loadGroup]);

  // Newest first: the same order the member panel reads its own window in.
  const entries = view?.granted
    ? [...view.audit].sort((a, b) => (a.at < b.at ? 1 : -1))
    : [];
  // The name of the automation a line belongs to: derived from the trigger the
  // rule carries, or from the entry's own detail when the rule is gone (the
  // trail already names what it was).
  const nameOf = (ruleId: string): string =>
    view?.granted
      ? automationText(view.rules.find((r) => r.id === ruleId) ?? { trigger: undefined })
      : "";

  return { view, loading, problem, entries, nameOf };
}
