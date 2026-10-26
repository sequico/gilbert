/**
 * The installation's agent, as the administration reads it (ADR 0027, 0030,
 * 0032, 0033).
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
import { emptyMetrics, type RunMetrics } from "@gilbert/shared/agentMetrics";
import type { FactView } from "@gilbert/shared/memory";
import type { RunListing, RunSummary } from "@gilbert/shared/run";
import { apiFetch } from "@/jmap/client";

export type { AgentStatus, FactView, RunListing, RunMetrics, RunSummary };

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
  const res = await apiFetch<{
    groups?: Array<{ name: string; metrics: RunMetrics }>;
    total?: RunMetrics;
  }>(`/api/admin/agent/metrics${suffix ? `?${suffix}` : ""}`);
  return {
    groups: res.groups ?? [],
    total: res.total ?? emptyMetrics(),
  };
}

/**
 * One page of a group's runs, each read or each said, newest first.
 *
 * `state` narrows the answer on the server: `running` is what a live view polls,
 * so the history is fetched once rather than every few seconds. `after` is the
 * cursor the previous page ended at (`when|id`), not an offset: a run ends while a
 * person reads the list, and an offset over a mutating list repeats or skips a row
 * at the boundary. `more` says another page follows.
 */
export async function fetchGroupRunsPage(
  group: string,
  opts: {
    state?: "running" | "live";
    after?: string | null;
    limit?: number;
    /** Ask for the plan with each run; false for a surface that only reads headers. */
    plan?: boolean;
  } = {},
): Promise<{ runs: RunSummary[]; more: boolean; after: string | null }> {
  const query = new URLSearchParams();
  if (opts.state) query.set("state", opts.state);
  if (opts.after) query.set("after", opts.after);
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  if (opts.plan === false) query.set("plan", "0");
  const suffix = query.toString();
  const res = await apiFetch<{
    runs?: RunSummary[];
    more?: boolean;
    after?: string | null;
  }>(`/api/groups/${encodeURIComponent(group)}/runs${suffix ? `?${suffix}` : ""}`);
  return {
    runs: res.runs ?? [],
    more: res.more === true,
    after: typeof res.after === "string" ? res.after : null,
  };
}

/** Every run a group holds, for a reader that needs the whole set. */
export async function fetchGroupRuns(
  group: string,
  state?: "running" | "live",
  opts: { plan?: boolean } = {},
): Promise<RunSummary[]> {
  const page = await fetchGroupRunsPage(group, {
    ...(state ? { state } : {}),
    ...opts,
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
    runs?: RunSummary[];
    more?: boolean;
    after?: string | null;
  }>(`/api/groups/${encodeURIComponent(group)}/runs/archive?${query.toString()}`);
  return {
    runs: res.runs ?? [],
    more: res.more === true,
    after: typeof res.after === "string" ? res.after : null,
  };
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
  facts: FactView[];
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
  const res = await apiFetch<{
    facts?: FactView[];
    problems?: string[];
    total?: number;
    more?: boolean;
  }>(`/api/admin/memory${suffix ? `?${suffix}` : ""}`);
  return {
    facts: res.facts ?? [],
    problems: res.problems ?? [],
    total: res.total ?? res.facts?.length ?? 0,
    more: res.more === true,
  };
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
): Promise<FactView> {
  const res = await apiFetch<{ fact: FactView }>(
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
 * in force (ADR 0033); dismissing is this, and it writes no sentence at all.
 */
export async function dismissProposal(id: string): Promise<FactView> {
  const res = await apiFetch<{ fact: FactView }>(
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

/** The listeners a switch written from this client tells (the chat header). */
const switchListeners = new Set<(state: AgentSwitch) => void>();

export function onAgentSwitch(listener: (state: AgentSwitch) => void): () => void {
  switchListeners.add(listener);
  return () => {
    switchListeners.delete(listener);
  };
}

export async function setAgentSwitch(enabled: boolean): Promise<AgentSwitch> {
  const state = await apiFetch<AgentSwitch>("/api/admin/agent/switch", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
  // A surface that names the state (the chat header) hears the answer at once
  // instead of waiting for its next beat.
  for (const listener of switchListeners) listener(state);
  return state;
}

/**
 * Whether the installation's agent is on, as a member of the group reads it.
 *
 * The chat names the state in its header for everybody in the group, not only
 * for an administrator, so it asks the group's own surface. `fresh` is for a
 * reader an event just told about the file: the server answers from the value
 * its pass already holds otherwise.
 */
export async function fetchGroupAgent(
  group: string,
  fresh = false,
): Promise<AgentSwitch> {
  return await apiFetch<AgentSwitch>(
    `/api/groups/${encodeURIComponent(group)}/agent${fresh ? "?fresh=1" : ""}`,
  );
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

/**
 * What a group-wide stop did, as the server answered it: the runs it closed by
 * id, how many that was, and how many were still moving when it finished — a
 * sweep has a ceiling and a run can move under it, so the answer is a count of
 * what happened rather than a promise that nothing is left.
 */
export interface StopAllAnswer {
  stopped: number;
  runs: string[];
  left: number;
  /** The most runs one press closes, which is what the ceiling is measured by. */
  max: number;
  /** In flight when the press began, but past what one press closes. */
  beyondCeiling: number;
  /** Runs the press tried to close and could not: another write kept winning. */
  moved: string[];
  /** Runs whose stop failed, with the reason the server gave. */
  failed: Array<{ id: string; problem: string }>;
  /** Documents the server holds and cannot read: possibly runs in flight. */
  unreadable: Array<{ id: string; problem: string }>;
}

/**
 * Stop every run in flight in a group — the ones working and the ones waiting on
 * a person — and answer what it did.
 *
 * The answer is **checked**, not defaulted: a field this build draws is the
 * server's fact, and a 200 of another shape is a defect to show rather than a
 * count to invent (`left: 0` from a missing field is the very sentence "nothing
 * is moving" for a group that never answered).
 */
export async function stopAllRuns(group: string): Promise<StopAllAnswer> {
  const answer = await apiFetch<unknown>(
    `/api/groups/${encodeURIComponent(group)}/runs/stop`,
    { method: "POST" },
  );
  const held = answer as Partial<StopAllAnswer> | null;
  const problems = (value: unknown): Array<{ id: string; problem: string }> =>
    Array.isArray(value)
      ? value.flatMap((one) => {
          const row = one as { id?: unknown; problem?: unknown };
          return typeof row?.id === "string" && typeof row?.problem === "string"
            ? [{ id: row.id, problem: row.problem }]
            : [];
        })
      : [];
  const ids = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  if (
    !held ||
    typeof held.stopped !== "number" ||
    !Array.isArray(held.runs) ||
    typeof held.left !== "number" ||
    typeof held.max !== "number" ||
    typeof held.beyondCeiling !== "number"
  )
    throw new Error("The stop answer was not one this build can read.");
  return {
    stopped: held.stopped,
    runs: ids(held.runs),
    left: held.left,
    max: held.max,
    beyondCeiling: held.beyondCeiling,
    moved: ids(held.moved),
    failed: problems(held.failed),
    unreadable: problems(held.unreadable),
  };
}
