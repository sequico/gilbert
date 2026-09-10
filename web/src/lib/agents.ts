/**
 * The agent worker fleet's API, as the client calls it (ADR 0003).
 *
 * One function per route in `server/src/app.ts`. The shapes those routes
 * answer with are declared once, in `@gilbert/agent/views`, and this module
 * reads and re-exports them: the routes build those answers and the client
 * reads the same declarations, because a field added on one side and
 * forgotten on the other compiles on both — and arrives as `undefined` on one.
 * That drift is what SSOT forbids, so the answer shapes have one home and it
 * is not this file.
 *
 * The stored documents come from `@gilbert/agent/documents`, the module the
 * server validates and stores with, so a rule, a job, a decision or an audit
 * entry cannot be spelled two ways either (both aliases are in
 * web/tsconfig.json and web/vite.config.ts).
 *
 * What is declared here of this layer's own is the request bodies the surface
 * writes: `AgentProviderInput` and `AgentProvidersInput` describe a write, and
 * no route hands them back.
 */

import type { AgentRule } from "@gilbert/agent/documents";
import type {
  AgentAppPasswordRotation,
  AgentAuditExport,
  AgentGroupSurface,
  AgentProvidersView,
  AgentStatus,
  GroupInstructionView,
  MemberAgentView,
  PendingApproval,
} from "@gilbert/agent/views";
import { apiFetch } from "@/jmap/client";

/*
 * Read here, declared there: every shape a route answers with, so a consumer of
 * this module names the same type the route builds.
 */
export type {
  AgentAuditExport,
  AgentAuditExportMonth,
  AgentGroupAnswer,
  AgentGroupDenied,
  AgentGroupSurface,
  AgentGroupView,
  AgentProvidersView,
  AgentProviderView,
  AgentStatus,
  AgentStatusGroup,
  AgentStatusWorker,
  GroupInstructionView,
  MemberAgentRule,
  MemberAgentView,
  PendingApproval,
} from "@gilbert/agent/views";

/* ------------------------------------------------------------------ */
/* Providers — the agent's own configuration                           */
/* ------------------------------------------------------------------ */

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

/**
 * `POST /api/admin/agent/app-password` — the agent's new secret, once.
 *
 * `alsoValid` is how many app passwords the agent already had and which the
 * rotation leaves working: the server mints the new credential and revokes
 * nothing, so this surface says what is still valid instead of implying that
 * the old ones stopped.
 */
export function rotateAgentAppPassword(): Promise<AgentAppPasswordRotation> {
  return apiFetch<AgentAppPasswordRotation>("/api/admin/agent/app-password", {
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

/** `GET /api/admin/groups/:name/agent/instruction` — the group's instruction. */
export async function fetchGroupInstruction(name: string): Promise<GroupInstructionView> {
  return apiFetch<GroupInstructionView>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/instruction`,
  );
}

/** `POST` the same route — replace it. An empty text removes it. */
export async function saveGroupInstruction(
  name: string,
  text: string,
): Promise<GroupInstructionView> {
  return apiFetch<GroupInstructionView>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/instruction`,
    { method: "POST", body: JSON.stringify({ text }) },
  );
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

/**
 * `GET /api/admin/groups/:name/agent/audit` — the group's audit trail, month
 * by month, as the copy an administrator keeps.
 *
 * The months are the retention's window, so what comes back is what is still
 * there: the same documents the group's own surface reads, and the ones the
 * prune would drop after they fall out of it.
 */
export function fetchAgentAuditExport(name: string): Promise<AgentAuditExport> {
  return apiFetch<AgentAuditExport>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/audit`,
  );
}

/* ------------------------------------------------------------------ */
/* The model tiers                                                     */
/* ------------------------------------------------------------------ */

/*
 * The tiers that call a model; T0 is deterministic and has no provider. Read
 * from the catalogue and passed on rather than written down again here: a
 * second copy is how this module and the server come to disagree about which
 * tiers exist, and the provider editor iterates this one.
 */
export { AGENT_MODEL_TIERS } from "@gilbert/agent/documents";
