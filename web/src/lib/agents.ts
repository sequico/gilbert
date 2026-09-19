/**
 * The agents' API, as the client calls it (ADR 0003).
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

import {
  AGENT_AREAS,
  type AgentArea,
  type AgentJob,
  type AgentNotebookFact,
  type AgentRule,
} from "@gilbert/agent/documents";
import type {
  AgentApprovalsView,
  AgentAuditExport,
  AgentGroupSurface,
  AgentProseView,
  AgentProvidersView,
  AgentReadingView,
  AgentStatus,
  GroupMembersView,
  GroupNotebookView,
  GroupPolicyView,
  MemberAgentView,
} from "@gilbert/agent/views";
import { apiFetch } from "@/jmap/client";
import { t } from "@/lib/i18n";

/*
 * Read here, declared there: every shape a route answers with, so a consumer of
 * this module names the same type the route builds.
 */
export type {
  AgentApprovalsView,
  AgentAuditExport,
  AgentAuditExportMonth,
  AgentGroupAnswer,
  AgentGroupDenied,
  AgentGroupSurface,
  AgentGroupView,
  AgentProseView,
  AgentProvidersView,
  AgentProviderView,
  AgentStatus,
  AgentStatusGroup,
  AgentStatusWorker,
  GroupMembersView,
  GroupNotebookView,
  GroupPolicyView,
  MemberAgentRule,
  MemberAgentView,
  PendingApproval,
} from "@gilbert/agent/views";

/* ------------------------------------------------------------------ */
/* Providers — the agent's own configuration                           */
/* ------------------------------------------------------------------ */

/** The installation's model as the editor sends it; `apiKey` absent keeps the stored one. */
export interface AgentProviderInput {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * The write body: the installation's model, and the bounds it sets for itself.
 *
 * One document, one write: the model and every bound on what it may cost or
 * reach travel together, because they are statements about the same call. A
 * field the write omits is left as it is; `null` clears one back to what the
 * deployment's environment declares.
 */
export interface AgentProvidersInput {
  provider?: AgentProviderInput | null;
  /** The ceiling on one answer, in tokens. */
  maxOutputTokens?: number | null;
  /** How many hops a chain of automations may run. */
  maxChainHops?: number | null;
  /** How many pages one run may hand the model as images. */
  maxPages?: number | null;
}

/* ------------------------------------------------------------------ */
/* The routes                                                          */
/* ------------------------------------------------------------------ */

/** `GET /api/admin/agents` — the Master, its groups and agents. */
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

/** `GET /api/admin/agent/providers` — the installation's one model. */
export function fetchAgentProviders(): Promise<AgentProvidersView> {
  return apiFetch<AgentProvidersView>("/api/admin/agent/providers");
}

/** `POST /api/admin/agent/providers` — write the model the editor sent. */
export async function saveAgentProviders(input: AgentProvidersInput): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/admin/agent/providers", {
    method: "POST",
    body: JSON.stringify(input),
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

/**
 * One document of prose an agent carries, as the two surfaces reach it.
 *
 * The installation's own rules and a group's standing instruction are one
 * document type at two reaches, so they are one pair of calls with the scope
 * passed in: the empty scope is the installation's own route in Master, and a
 * group name is that group's route. A third scope would add a route, not a
 * second client function.
 */
function proseRoute(scope: string): string {
  return scope
    ? `/api/admin/groups/${encodeURIComponent(scope)}/agent/instruction`
    : "/api/admin/agent/instruction";
}

export function fetchAgentProse(scope = ""): Promise<AgentProseView> {
  return apiFetch<AgentProseView>(proseRoute(scope));
}

/** The same route, written. An empty text removes the document. */
export function saveAgentProse(scope: string, text: string): Promise<AgentProseView> {
  return apiFetch<AgentProseView>(proseRoute(scope), {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

/** `GET /api/admin/groups/:name/agent/policy` — who the group's runs stop for. */
export function fetchGroupPolicy(name: string): Promise<GroupPolicyView> {
  return apiFetch<GroupPolicyView>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/policy`,
  );
}

/** `POST` the same route — replace the group's policy. */
export function saveGroupPolicy(
  name: string,
  policy: Pick<GroupPolicyView, "review" | "allowExternal">,
): Promise<GroupPolicyView> {
  return apiFetch<GroupPolicyView>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/policy`,
    { method: "POST", body: JSON.stringify(policy) },
  );
}

/**
 * The author's reading (ADR 0003): the draft and what it is about go to the
 * installation's model, which reads them beside the group's instruction and its
 * notebook and answers in words about the gaps.
 *
 * It is not a run — nothing is compiled, nothing is stored, and the answer is
 * prose shown as prose. Its refusals travel as codes like any other, so the
 * sentence a person reads is composed from the catalogue in force.
 */
export async function readDraft(
  name: string,
  draft: string,
  about: string,
): Promise<AgentReadingView> {
  return apiFetch<AgentReadingView>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/reading`,
    { method: "POST", body: JSON.stringify({ draft, about }) },
  );
}

/**
 * The line beside a reading the month's authoring document did not take.
 *
 * An answer's tokens are spent whether or not the count of them lands, so a
 * failed count costs the installation's tally and never the words: the surface
 * shows what came back and says here that the month did not record it. Both
 * surfaces that show a reading say it, so the sentence is written once.
 */
export function readingNotCountedNote(): string {
  return t("This reading was not counted toward this month's authoring.");
}

/** `GET /api/admin/agent/approvals` — every pending decision, by group. */
export function fetchPendingApprovals(): Promise<AgentApprovalsView> {
  return apiFetch<AgentApprovalsView>("/api/admin/agent/approvals");
}

/** `GET /api/agent/group/:name` — the member's read-only view. */
export function fetchMemberAgentView(name: string): Promise<MemberAgentView> {
  return apiFetch<MemberAgentView>(`/api/agent/group/${encodeURIComponent(name)}`);
}

/**
 * `GET /api/agent/group/:name/members` — the group's members, as the
 * installation reads them (ADR 0005).
 *
 * Its own route, asked once per conversation and kept: the `@` picker offers
 * only the members, and the transcript greys a mention of somebody who is no
 * longer one. `members` is null when nobody could read the roster — a Master
 * without `sysAccountGet`/`sysAccountQuery`, or a directory that refused — and
 * the surface falls back to the transcript it already has.
 */
export function fetchGroupMembers(name: string): Promise<GroupMembersView> {
  return apiFetch<GroupMembersView>(
    `/api/agent/group/${encodeURIComponent(name)}/members`,
  );
}

/**
 * `POST /api/admin/groups/:name/agent/run` — ask for one automation, now.
 *
 * What comes back is the job the ask created: the worker holding the group's
 * claim picks it up, so the surface says the ask landed and the run's own
 * record says what came of it. A refusal of the ask itself comes back as the
 * error `apiFetch` composes the sentence for.
 */
export async function runAgentRule(
  name: string,
  ask: { ruleId: string; emailId?: string },
): Promise<AgentJob> {
  const res = await apiFetch<{ ok: boolean; job: AgentJob }>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/run`,
    { method: "POST", body: JSON.stringify(ask) },
  );
  return res.job;
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
/* The areas an author grants                                          */
/* ------------------------------------------------------------------ */

/**
 * One area, as the rule schema publishes it: its name, its English label and
 * the actions it grants.
 *
 * The catalogue is the server's — `agentRuleJsonSchema()` derives `x-areas` and
 * `x-actions` from `AGENT_ACTION_SPECS` — so the editor offers exactly the
 * grants the executor would honour. In particular the exclusion of anything
 * that leaves the group or cannot be undone is the server's own rule
 * (`areaActions`), computed from the catalogue's flags, rather than a second
 * list kept here in step.
 */
export interface AgentAreaCatalogEntry {
  area: AgentArea;
  label: string;
  actions: string[];
}

/**
 * One action that stands beside the areas rather than inside one, as the schema
 * publishes it: sending, which `areaActions` excludes from the area it belongs
 * to, and doing nothing, which is not a behaviour at all.
 *
 * It is derived, not listed: the editor reads `x-actions` and takes whatever no
 * area grants, so a catalogue that grows a new flagged action offers it here
 * without this module changing.
 */
export interface AgentStandaloneCatalogEntry {
  name: string;
  label: string;
  description: string;
  external: boolean;
  irreversible: boolean;
}

/** The grant the editor offers, as the rule schema publishes it. */
export interface AgentGrantCatalog {
  areas: AgentAreaCatalogEntry[];
  /** In catalogue order, which is also the order a grant is written in. */
  standalone: AgentStandaloneCatalogEntry[];
  /** Every action name the catalogue has, in catalogue order. */
  order: string[];
}

/** `GET /api/admin/agent/rule-schema` — the published schema, as it is served. */
export function fetchAgentRuleSchema(): Promise<Record<string, unknown>> {
  return apiFetch<Record<string, unknown>>("/api/admin/agent/rule-schema");
}

/** Whether a value names an area this build knows. */
function isAgentArea(x: unknown): x is AgentArea {
  return typeof x === "string" && (AGENT_AREAS as ReadonlyArray<string>).includes(x);
}

function actionNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * The grant a schema publishes: the areas, and whatever stands beside them.
 *
 * One reader of the published catalogue, so the editor's three areas, its
 * sending entry and the order a grant is written in all come from the same
 * place — and an empty catalogue (a schema read before the server answered) is
 * an empty grant rather than a guess.
 */
export function grantCatalog(schema: Record<string, unknown>): AgentGrantCatalog {
  const areas: AgentAreaCatalogEntry[] = [];
  const rawAreas = schema["x-areas"];
  if (Array.isArray(rawAreas)) {
    for (const entry of rawAreas) {
      if (!entry || typeof entry !== "object") continue;
      const area = entry as { area?: unknown; label?: unknown; actions?: unknown };
      if (!isAgentArea(area.area)) continue;
      areas.push({
        area: area.area,
        label: typeof area.label === "string" ? area.label : area.area,
        actions: actionNames(area.actions),
      });
    }
  }
  const order: string[] = [];
  const standalone: AgentStandaloneCatalogEntry[] = [];
  const inAreas = new Set(areas.flatMap((entry) => entry.actions));
  const rawActions = schema["x-actions"];
  if (Array.isArray(rawActions)) {
    for (const entry of rawActions) {
      if (!entry || typeof entry !== "object") continue;
      const action = entry as Record<string, unknown>;
      const name = typeof action.name === "string" ? action.name : "";
      if (!name) continue;
      order.push(name);
      if (inAreas.has(name)) continue;
      standalone.push({
        name,
        label: typeof action.label === "string" ? action.label : name,
        description: typeof action.description === "string" ? action.description : "",
        external: action.external === true,
        irreversible: action.irreversible === true,
      });
    }
  }
  return { areas, standalone, order };
}

/* ------------------------------------------------------------------ */
/* The group's notebook — what memory means for a group                */
/* ------------------------------------------------------------------ */

/** `GET /api/admin/groups/:name/agent/notebook` — the facts its agent holds. */
export function fetchGroupNotebook(name: string): Promise<GroupNotebookView> {
  return apiFetch<GroupNotebookView>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/notebook`,
  );
}

/**
 * `POST /api/admin/groups/:name/agent/notebook` — replace the facts.
 *
 * The whole list goes at once, which is what the document holds: the surface
 * reads the facts, changes one, and writes them back. An id the surface keeps
 * is the fact it edits; one it leaves out is a fact the server gives an id to.
 */
export async function saveAgentNotebook(
  name: string,
  facts: ReadonlyArray<Pick<AgentNotebookFact, "id" | "text">>,
): Promise<GroupNotebookView> {
  return apiFetch<GroupNotebookView>(
    `/api/admin/groups/${encodeURIComponent(name)}/agent/notebook`,
    { method: "POST", body: JSON.stringify({ facts }) },
  );
}
