/**
 * The agent worker fleet's API, as the client calls it (ADR 0003).
 *
 * One function per route in `server/src/app.ts`, and the response types
 * declared here — with one deliberate exception: the document shapes
 * themselves come from `@gilbert/agent/documents`, the same module the
 * server validates and stores with, so a rule, a job, a decision or an audit
 * entry cannot be spelled two ways (SSOT; the alias is in web/tsconfig.json
 * and web/vite.config.ts).
 *
 * The provider view is this layer's own shape, because it is not the stored
 * document: the server hands back `hasKey` and never the key, and that is the
 * whole point of it.
 */

import type {
  AgentArea,
  AgentAuditEntry,
  AgentDecision,
  AgentJob,
  AgentRule,
  AgentScheduleEntry,
  AgentTier,
} from "@gilbert/agent/documents";
import { apiFetch } from "@/jmap/client";

/* ------------------------------------------------------------------ */
/* The installation's fleet                                            */
/* ------------------------------------------------------------------ */

/** Whether the agent holds a group (ADR 0003: the grant is Stalwart's, read here). */
export interface AgentStatusGroup {
  name: string;
  granted: boolean;
}

/** One worker process, with freshness the server judged at read time. */
export interface AgentStatusWorker {
  id: string;
  address: string;
  areas: AgentArea[];
  heartbeatAt: string;
  version: string;
  /** Heartbeat younger than three intervals; a stale worker is not alive. */
  alive: boolean;
}

export interface AgentStatus {
  configured: boolean;
  /** The registered agent's address; empty when the installation has none. */
  address: string;
  groups: AgentStatusGroup[];
  workers: AgentStatusWorker[];
  /** Why the fleet cannot be read, when it cannot: no agent, or one out of reach. */
  reason?: string;
}

/**
 * A group's agent surface, in the one shape the route answers with.
 *
 * The documents are there when the admin may read the group and empty when
 * they may not, and `reason` says which and why — so a consumer renders one
 * thing and branches on `granted` alone.
 */
export interface AgentGroupSurface {
  group: string;
  granted: boolean;
  /** The registered agent's address; empty when the installation has none. */
  agentAddress: string;
  /** Present when the admin has no access to the group: why it is empty. */
  reason?: string;
  rules: AgentRule[];
  jobs: AgentJob[];
  decisions: AgentDecision[];
  audit: AgentAuditEntry[];
  schedule: AgentScheduleEntry[];
}

/** The surface for a group this admin can read. */
export type AgentGroupView = AgentGroupSurface & { granted: true };

/** The surface for a group this admin cannot reach: empty, with the reason. */
export type AgentGroupDenied = AgentGroupSurface & {
  granted: false;
  reason: string;
};

/* ------------------------------------------------------------------ */
/* Providers — the agent's own configuration                           */
/* ------------------------------------------------------------------ */

/** One tier's provider as the API reads it: `hasKey`, never the key. */
export interface AgentProviderView {
  provider: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
}

export interface AgentProvidersView {
  /** Empty when the installation has no agent registered. */
  address: string;
  providers: { T1?: AgentProviderView; T2?: AgentProviderView };
}

/** One tier as the editor sends it; `apiKey` absent keeps the stored one. */
export interface AgentProviderInput {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** An empty tier clears it; a tier the write omits is left alone. */
export interface AgentProvidersInput {
  T1?: AgentProviderInput | null;
  T2?: AgentProviderInput | null;
}

/* ------------------------------------------------------------------ */
/* Approvals and the member view                                       */
/* ------------------------------------------------------------------ */

/** One decision waiting on a person, in the group where it waits. */
export interface PendingApproval {
  group: string;
  decisionId: string;
  jobId: string;
  summary: string;
  confidence: number;
  createdAt: string;
}

/** The rules a member reads: what it is, where, which tier, on, woken by what. */
export type MemberAgentRule = Pick<
  AgentRule,
  "id" | "name" | "area" | "tier" | "enabled" | "trigger"
>;

export interface MemberAgentView {
  group: string;
  granted: boolean;
  /** The registered agent's address; empty when the installation has none. */
  agentAddress: string;
  rules: MemberAgentRule[];
  jobs: AgentJob[];
  audit: AgentAuditEntry[];
}

/* ------------------------------------------------------------------ */
/* The routes                                                          */
/* ------------------------------------------------------------------ */

/** `GET /api/admin/agents` — the installation's agent, its groups and workers. */
export function fetchAgentStatus(): Promise<AgentStatus> {
  return apiFetch<AgentStatus>("/api/admin/agents");
}

/** `GET /api/admin/groups/:name/agent` — a group's agent documents. */
export function fetchAgentGroup(name: string): Promise<AgentGroupSurface> {
  return apiFetch<AgentGroupSurface>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent`,
  );
}

/** `GET /api/admin/groups/:name/agent/rules` — the rules editor's document. */
export async function fetchAgentRules(name: string): Promise<AgentRule[]> {
  const res = await apiFetch<{ rules: AgentRule[] }>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/rules`,
  );
  return res.rules;
}

/** `POST /api/admin/groups/:name/agent/rules` — the saved rules, as stamped. */
export async function saveAgentRules(
  name: string,
  rules: AgentRule[],
): Promise<AgentRule[]> {
  const res = await apiFetch<{ ok: boolean; rules: AgentRule[] }>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/rules`,
    { method: "POST", body: JSON.stringify({ rules }) },
  );
  return res.rules;
}

/** `GET /api/admin/agent/providers` — which model serves each tier. */
export function fetchAgentProviders(): Promise<AgentProvidersView> {
  return apiFetch<AgentProvidersView>("/api/admin/agent/providers");
}

/** `POST /api/admin/agent/providers` — write the tiers the editor sent. */
export async function saveAgentProviders(providers: AgentProvidersInput): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/admin/agent/providers", {
    method: "POST",
    body: JSON.stringify({ providers }),
  });
}

/** `POST /api/admin/agent/app-password` — the agent's new secret, once. */
export function rotateAgentAppPassword(): Promise<{ secret: string }> {
  return apiFetch<{ secret: string }>("/api/admin/agent/app-password", {
    method: "POST",
  });
}

/** `POST /api/admin/groups/:name/agent/labels` — the `G-` keywords added. */
export async function addAgentLabels(name: string): Promise<string[]> {
  const res = await apiFetch<{ ok: boolean; added: string[] }>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/labels`,
    { method: "POST" },
  );
  return res.added;
}

/** `GET /api/admin/agent/approvals` — every pending decision, by group. */
export async function fetchPendingApprovals(): Promise<PendingApproval[]> {
  const res = await apiFetch<{ approvals: PendingApproval[] }>(
    "/api/admin/agent/approvals",
  );
  return res.approvals;
}

/** `GET /api/agent/group/:name` — the member's read-only view. */
export function fetchMemberAgentView(name: string): Promise<MemberAgentView> {
  return apiFetch<MemberAgentView>(`/api/agent/group/${encodeURIComponent(name)}`);
}

/** The tiers that call a model; T0 is deterministic and has no provider. */
export const PROVIDER_TIERS: ReadonlyArray<Extract<AgentTier, "T1" | "T2">> = [
  "T1",
  "T2",
];
