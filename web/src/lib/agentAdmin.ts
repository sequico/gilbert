/**
 * The installation's agent, as the administration reads it (ADR 0031, 0034,
 * 0036, 0037).
 *
 * Three readers and three writers for the routes under `/api/admin/agent`,
 * `/api/admin/memory` and `/api/groups/<group>/runs`. The shapes are the
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

/**
 * The runs a group has worked, each read or each said.
 *
 * `state` narrows the answer on the server: `running` is what a live view polls,
 * so the history is fetched once rather than every few seconds.
 */
export async function fetchGroupRuns(
  group: string,
  state?: "running",
): Promise<RunListing[]> {
  const query = state ? `?state=${state}` : "";
  const res = await apiFetch<{ runs: RunListing[] }>(
    `/api/groups/${encodeURIComponent(group)}/runs${query}`,
  );
  return res.runs;
}

/** One month of a group's archived runs, read by the same record a run is. */
export async function fetchGroupArchive(
  group: string,
  month: string,
): Promise<RunListing[]> {
  const res = await apiFetch<{ runs: RunListing[] }>(
    `/api/groups/${encodeURIComponent(group)}/runs/archive?month=${encodeURIComponent(month)}`,
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

/** What the model connection check found: connected, or the first fault. */
export interface ModelCheck {
  ok: boolean;
  /** Who answered, when connected: the provider and the model it named. */
  identity?: string;
  reason?:
    | "no_model"
    | "bad_url"
    | "forbidden_target"
    | "unauthorized"
    | "not_found"
    | "rate_limited"
    | "provider_error"
    | "unreachable";
}

/** Ask the provider, with the credential the agent itself uses. */
export async function fetchModelCheck(): Promise<ModelCheck> {
  return await apiFetch<ModelCheck>("/api/admin/agent/model");
}

/** Whether the installation's agent is on, as the switch says. */
export interface AgentSwitch {
  enabled: boolean;
}

export async function fetchAgentSwitch(): Promise<AgentSwitch> {
  return await apiFetch<AgentSwitch>("/api/admin/agent/switch");
}

export async function setAgentSwitch(enabled: boolean): Promise<AgentSwitch> {
  return await apiFetch<AgentSwitch>("/api/admin/agent/switch", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

/** Stop a running run: end it as cancelled, as a member of the group. */
export async function stopRun(group: string, id: string): Promise<void> {
  await apiFetch(
    `/api/groups/${encodeURIComponent(group)}/runs/${encodeURIComponent(id)}/stop`,
    {
      method: "POST",
    },
  );
}
