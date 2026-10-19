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
import type { RunMetrics } from "@gilbert/shared/agentMetrics";
import type { FactDoc } from "@gilbert/shared/memory";
import type { RunListing, RunSummary } from "@gilbert/shared/run";
import { apiFetch } from "@/jmap/client";

export type { AgentStatus, FactDoc, RunListing, RunMetrics, RunSummary };

/** Where the installation's agent is: the claim, and how often a pass is asked for. */
export async function fetchAgentStatus(): Promise<AgentStatus> {
  const res = await apiFetch<{ agent: AgentStatus }>("/api/admin/agent");
  return res.agent;
}

/**
 * What the groups' runs spent, over the reader's window.
 *
 * `since` is computed in the reader's own clock; the server tallies the runs it
 * holds. The answer is a few numbers per group, not the runs themselves.
 */
export async function fetchAgentMetrics(
  groups: readonly string[],
  since?: string,
): Promise<{ groups: Array<{ name: string; metrics: RunMetrics }>; total: RunMetrics }> {
  const query = new URLSearchParams();
  if (since) query.set("since", since);
  if (groups.length) query.set("groups", groups.join(","));
  const suffix = query.toString();
  return await apiFetch<{
    groups: Array<{ name: string; metrics: RunMetrics }>;
    total: RunMetrics;
  }>(`/api/admin/agent/metrics${suffix ? `?${suffix}` : ""}`);
}

/**
 * One page of a group's runs, each read or each said.
 *
 * `state` narrows the answer on the server: `running` is what a live view polls,
 * so the history is fetched once rather than every few seconds. `offset` and
 * `limit` are the page the panel draws; `more` says another follows.
 */
export async function fetchGroupRunsPage(
  group: string,
  opts: { state?: "running"; offset?: number; limit?: number } = {},
): Promise<{ runs: RunSummary[]; more: boolean }> {
  const query = new URLSearchParams();
  if (opts.state) query.set("state", opts.state);
  if (opts.offset) query.set("offset", String(opts.offset));
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  const suffix = query.toString();
  const res = await apiFetch<{ runs: RunSummary[]; more: boolean }>(
    `/api/groups/${encodeURIComponent(group)}/runs${suffix ? `?${suffix}` : ""}`,
  );
  return { runs: res.runs, more: res.more };
}

/** Every run a group holds, for a reader that needs the whole set. */
export async function fetchGroupRuns(
  group: string,
  state?: "running",
): Promise<RunSummary[]> {
  const page = await fetchGroupRunsPage(group, {
    ...(state ? { state } : {}),
    limit: 1000,
  });
  return page.runs;
}

/**
 * One month of a group's archived runs, read by the same record a run is.
 *
 * `after` is the cursor the previous answer ended at (`when|id`), not an
 * offset: the drawer is filled while a person reads it, and an offset over a
 * mutating list repeats or skips a row at the boundary.
 */
export async function fetchGroupArchive(
  group: string,
  month: string,
  after?: string | null,
): Promise<{ runs: RunSummary[]; more: boolean; after: string | null }> {
  const query = new URLSearchParams({ month });
  if (after) query.set("after", after);
  const res = await apiFetch<{
    runs: RunSummary[];
    more: boolean;
    after: string | null;
  }>(`/api/groups/${encodeURIComponent(group)}/runs/archive?${query.toString()}`);
  return { runs: res.runs, more: res.more, after: res.after };
}

/** One run whole, read when its row opens; `month` names an archived drawer. */
export async function fetchRun(
  group: string,
  id: string,
  month?: string,
): Promise<RunListing> {
  const query = month ? `?month=${encodeURIComponent(month)}` : "";
  const res = await apiFetch<{ run: RunListing["run"] }>(
    `/api/groups/${encodeURIComponent(group)}/runs/${encodeURIComponent(id)}${query}`,
  );
  return { id, run: res.run, problem: null };
}

/** One page of the installation's memory, and how much the store holds. */
export interface FactsReading {
  facts: FactDoc[];
  /** Sheets this build cannot read, each with its reason: said, never hidden. */
  problems: string[];
  /** Every sheet the memory holds, not only this page. */
  total: number;
  /** Whether another page follows the last id of this one. */
  more: boolean;
}

/** The memory, a page at a time: `after` is the last id the reader has. */
export async function fetchFacts(after?: string, limit?: number): Promise<FactsReading> {
  const query = new URLSearchParams();
  if (after) query.set("after", after);
  if (limit !== undefined) query.set("limit", String(limit));
  const suffix = query.toString();
  return await apiFetch<FactsReading>(`/api/admin/memory${suffix ? `?${suffix}` : ""}`);
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
