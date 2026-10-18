/**
 * The installation's agent, as the administration reads it (ADR 0031, 0034,
 * 0036, 0037).
 *
 * Three readers and three writers for the routes under `/api/admin/agent`,
 * `/api/admin/memory` and `/api/admin/groups/<group>/runs`. The shapes are the
 * server's own documents — a claim, a run and a fact are stored contracts both
 * tiers read — imported from `@gilbert/shared`, so the surface draws what the
 * agent wrote rather than a second spelling of it.
 *
 * The two memory writes are here rather than in a store of the client's own: the
 * sheets live in the **Master's** app folder, which a browser may not write, and
 * every one of them goes through the server route. What a person writes is a
 * person's fact from the moment the route accepts it — the agent's own write is
 * refused against it — so nothing on this side has to decide it.
 */
import type { AgentStatus } from "@gilbert/shared/agent";
import type { FactDoc } from "@gilbert/shared/memory";
import type { RunListing } from "@gilbert/shared/run";
import { apiFetch } from "@/jmap/client";

export type { AgentStatus, FactDoc, RunListing };

/** Where the installation's agent is: the claim, and how often a pass is asked for. */
export async function fetchAgentStatus(): Promise<AgentStatus> {
  const res = await apiFetch<{ agent: AgentStatus }>("/api/admin/agent");
  return res.agent;
}

/** The runs a group has worked, each read or each said. */
export async function fetchGroupRuns(group: string): Promise<RunListing[]> {
  const res = await apiFetch<{ runs: RunListing[] }>(
    `/api/admin/groups/${encodeURIComponent(group)}/runs`,
  );
  return res.runs;
}

/** The installation's memory: every fact the agent reasons from. */
interface FactsReading {
  facts: FactDoc[];
  /** Sheets this build cannot read, each with its reason: said, never hidden. */
  problems: string[];
}

export async function fetchFacts(): Promise<FactsReading> {
  return await apiFetch<FactsReading>("/api/admin/memory");
}

/**
 * Correct a fact as this administrator, and get the sheet as it is now stored.
 *
 * The person is whoever the session is: the route stamps its own address on the
 * sheet, so a body cannot name a different one.
 */
export async function correctFact(
  id: string,
  edit: { subject: string; fact: string },
): Promise<FactDoc> {
  const res = await apiFetch<{ fact: FactDoc }>(
    `/api/admin/memory/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(edit),
    },
  );
  return res.fact;
}

/**
 * Dismiss the agent's proposal against a fact, and get the sheet as it now is.
 *
 * Accepting a proposal is the correction the surface already makes — the
 * proposal's words become the person's own correction, which is what puts them
 * in force (ADR 0037); dismissing is this, and it writes no sentence at all.
 */
export async function dismissProposal(id: string): Promise<FactDoc> {
  const res = await apiFetch<{ fact: FactDoc }>(
    `/api/admin/memory/${encodeURIComponent(id)}/proposal`,
    { method: "DELETE" },
  );
  return res.fact;
}

/** Remove a fact from the installation's memory. */
export async function forgetFact(id: string): Promise<void> {
  await apiFetch(`/api/admin/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
}
