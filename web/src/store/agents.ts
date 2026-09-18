/**
 * The agents' client state (ADR 0003).
 *
 * Reads and writes go through `@/lib/agents`; this store is the UI's view of
 * them: the installation's fleet status, one group's documents at a time, the
 * installation's own model, the capability catalogue the rule schema publishes,
 * and the approval queue. Nothing secret is kept here: the provider view
 * carries `hasKey` and never a key, and no route this store touches mints a
 * credential or hands one back.
 *
 * A group is read through two doors, and they are not interchangeable. The
 * admin door (`groupViews`, `/api/admin/groups/:name/agent`) answers the whole
 * surface an administrator edits, and only a Stalwart administrator may open
 * it. The member door (`memberViews`, `/api/agent/group/:name`) answers what a
 * member of the group reads — the automations and the group's standing
 * instruction — with the member's own session, and it is the one the chat uses,
 * because the chat is open to every member (ADR 0003, "Members see, never
 * change").
 */

import type { AgentRule } from "@gilbert/agent/documents";
import { create } from "zustand";
import { push } from "@/jmap/push";
import {
  type AgentActionCatalogEntry,
  type AgentGroupSurface,
  type AgentProvidersInput,
  type AgentProvidersView,
  type AgentStatus,
  actionCatalog,
  fetchAgentGroup,
  fetchAgentProviders,
  fetchAgentRuleSchema,
  fetchAgentStatus,
  fetchGroupMembers,
  fetchMemberAgentView,
  fetchPendingApprovals,
  type MemberAgentView,
  type PendingApproval,
  saveAgentProviders,
  saveAgentRules,
} from "@/lib/agents";
import { useSession } from "@/store/session";
import { debouncedReload } from "@/lib/fileNodeReload";

/**
 * The key a group's agent view is held under.
 *
 * Group names are matched case-insensitively — the server lower-cases them — so
 * every read and every write of `groupViews` and `memberViews` goes through
 * this one function, whatever spelling of the name the caller happens to hold.
 */
export function agentViewKey(name: string): string {
  return name.trim().toLowerCase();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface AgentsState {
  /** The installation's fleet, or null before the first read. */
  status: AgentStatus | null;
  /** One entry per group the surface has read, keyed by `agentViewKey(name)`. */
  groupViews: Record<string, AgentGroupSurface>;
  /**
   * One entry per group read through the member door, keyed the same way.
   *
   * Filled whatever the session's own privileges are: a Stalwart administrator
   * who is a member of the group reads the same documents every other member
   * reads, and one who is not a member is answered by the same door — no
   * impersonation, no group a person is not in.
   */
  memberViews: Record<string, MemberAgentView>;
  /**
   * One roster per group the surface has read, keyed the same way.
   *
   * `null` is a roster nobody could read, which is an answer and not a
   * failure: the transcript is what the `@` picker and the rendered mentions
   * fall back to. A group with no entry has not been asked about yet.
   */
  groupMembers: Record<string, string[] | null>;
  approvals: PendingApproval[];
  /**
   * What is in flight and what failed, **per operation**.
   *
   * One shared pair does not fit the way these surfaces are actually read: the
   * agent section runs several independent reads and writes at once, so a save
   * refused in one panel appears as an error in another, and any unrelated
   * request in flight makes a panel that has failed say "Loading…" instead of
   * what went wrong. Each operation has its own line, keyed by
   * `status`, `providers`, `catalogue`, `approvals`, `password`, or
   * `group:<name>`.
   */
  busy: Record<string, boolean>;
  problems: Record<string, string | null>;
  providers: AgentProvidersView | null;
  /** The catalogue the rule schema publishes; null until it is read. */
  catalogue: AgentActionCatalogEntry[] | null;
  loadStatus: () => Promise<void>;
  loadGroup: (name: string) => Promise<void>;
  /** The member door: the same documents, read with this session's own grant. */
  loadMemberView: (name: string) => Promise<void>;
  /**
   * Read a group's members once, and keep them: the picker and the rendered
   * mentions share the one answer. `refresh` is for a reconnect, where the copy
   * in hand is known to be old.
   */
  loadGroupMembers: (name: string, refresh?: boolean) => Promise<void>;
  /** Rejects when the server refused the save; the editor reports the reason. */
  saveRules: (name: string, rules: AgentRule[]) => Promise<void>;
  loadProviders: () => Promise<void>;
  /** Rejects when the server refused the write; a key is never posted back. */
  saveProviders: (providers: AgentProvidersInput) => Promise<void>;
  /** The capability catalogue, read from the rule schema the server publishes. */
  loadCatalogue: () => Promise<void>;
  loadApprovals: () => Promise<void>;
  reset: () => void;
}

/** The key a group's own reads and writes are tracked under. */
export function groupOperation(name: string): string {
  return `group:${agentViewKey(name)}`;
}

/**
 * The key the member-door read of a group is tracked under.
 *
 * Its own line, not `groupOperation`'s: the chat reads the member door while an
 * administrator may have the admin door open on the same group, and one shared
 * pair would show a member read in flight as an administrator save that failed.
 */
export function memberOperation(name: string): string {
  return `member:${agentViewKey(name)}`;
}

/**
 * The two lines an operation keeps: whether it is in flight, and why it failed.
 *
 * Written here rather than at each call site so the shape is one thing —
 * `{ ...s.busy, [op]: true }` spelled six times is six chances to key it
 * differently from the reader.
 */
function markBusy(op: string, busy: boolean) {
  return (s: { busy: Record<string, boolean> }) => ({ busy: { ...s.busy, [op]: busy } });
}

function markProblem(op: string, problem: string | null) {
  return (s: { problems: Record<string, string | null> }) => ({
    problems: { ...s.problems, [op]: problem },
  });
}

export const useAgents = create<AgentsState>((set, get) => ({
  status: null,
  groupViews: {},
  memberViews: {},
  groupMembers: {},
  approvals: [],
  busy: {},
  problems: {},
  providers: null,
  catalogue: null,

  loadStatus: async () => {
    set(markBusy("status", true));
    set(markProblem("status", null));
    try {
      set({ status: await fetchAgentStatus() });
    } catch (err) {
      set(markProblem("status", message(err)));
    } finally {
      set(markBusy("status", false));
    }
  },

  loadGroup: async (name) => {
    const key = agentViewKey(name);
    const op = groupOperation(name);
    set(markBusy(op, true));
    set(markProblem(op, null));
    try {
      const view = await fetchAgentGroup(name);
      set((s) => ({ groupViews: { ...s.groupViews, [key]: view } }));
    } catch (err) {
      set(markProblem(op, message(err)));
    } finally {
      set(markBusy(op, false));
    }
  },

  loadMemberView: async (name) => {
    const key = agentViewKey(name);
    const op = memberOperation(name);
    set(markBusy(op, true));
    set(markProblem(op, null));
    try {
      const view = await fetchMemberAgentView(name);
      set((s) => ({ memberViews: { ...s.memberViews, [key]: view } }));
    } catch (err) {
      set(markProblem(op, message(err)));
    } finally {
      set(markBusy(op, false));
    }
  },

  loadGroupMembers: async (name, refresh = false) => {
    const key = agentViewKey(name);
    // Asked once and kept: this is a directory read made for the whole
    // installation, and the picker and the rendered mentions read the same
    // answer. `refresh` is the reconnect's, where a tab knows its copy is old.
    // A refusal is remembered as the `null` it is rather than retried on every
    // conversation open.
    if (!refresh && key in get().groupMembers) return;
    try {
      const view = await fetchGroupMembers(name);
      set((s) => ({ groupMembers: { ...s.groupMembers, [key]: view.members } }));
    } catch {
      // A roster nobody could read costs the refinement, never the chat.
      set((s) => ({ groupMembers: { ...s.groupMembers, [key]: null } }));
    }
  },

  saveRules: async (name, rules) => {
    const key = agentViewKey(name);
    const op = groupOperation(name);
    set(markBusy(op, true));
    set(markProblem(op, null));
    try {
      // The server owns `version` and the stamps, so the saved document — not
      // the one that was sent — is what the view keeps.
      const saved = await saveAgentRules(name, rules);
      set((s) => {
        const view = s.groupViews[key];
        if (!view) return {};
        return { groupViews: { ...s.groupViews, [key]: { ...view, rules: saved } } };
      });
    } catch (err) {
      // Loud to both: the editor reports what the server refused, and a save
      // that failed quietly would look like one that worked.
      set(markProblem(op, message(err)));
      throw err;
    } finally {
      set(markBusy(op, false));
    }
  },

  loadProviders: async () => {
    set(markBusy("providers", true));
    set(markProblem("providers", null));
    try {
      set({ providers: await fetchAgentProviders() });
    } catch (err) {
      set(markProblem("providers", message(err)));
    } finally {
      set(markBusy("providers", false));
    }
  },

  loadCatalogue: async () => {
    set(markBusy("catalogue", true));
    set(markProblem("catalogue", null));
    try {
      set({ catalogue: actionCatalog(await fetchAgentRuleSchema()) });
    } catch (err) {
      set(markProblem("catalogue", message(err)));
    } finally {
      set(markBusy("catalogue", false));
    }
  },

  saveProviders: async (providers) => {
    set(markBusy("providers", true));
    set(markProblem("providers", null));
    try {
      await saveAgentProviders(providers);
      // A key the write did not carry is kept by the server, so what is stored
      // is read back rather than assumed from what was posted.
      set({ providers: await fetchAgentProviders() });
    } catch (err) {
      set(markProblem("providers", message(err)));
      throw err;
    } finally {
      set(markBusy("providers", false));
    }
  },

  loadApprovals: async () => {
    set(markBusy("approvals", true));
    set(markProblem("approvals", null));
    try {
      const view = await fetchPendingApprovals();
      set({ approvals: view.approvals });
    } catch (err) {
      set(markProblem("approvals", message(err)));
    } finally {
      set(markBusy("approvals", false));
    }
  },

  reset: () =>
    set({
      status: null,
      groupViews: {},
      memberViews: {},
      groupMembers: {},
      approvals: [],
      busy: {},
      problems: {},
      providers: null,
      catalogue: null,
    }),
}));

/** The group a FileNode change belongs to, when it is one this client knows. */
function groupNameForAccount(accountId: string): string | null {
  const accounts = useSession.getState().session?.accounts ?? {};
  const account = accounts[accountId];
  if (account?.isPersonal !== false) return null;
  return typeof account.name === "string" ? agentViewKey(account.name) : null;
}

const reloads = debouncedReload();

/*
 * A group's agent documents are FileNodes in the group's own account: when an
 * administrator saves rules or the standing instruction, or a worker writes a
 * job, the push rail reports a StateChange for that account and the view
 * re-reads it. A StateChange carries only account and type — not which node
 * changed — and chat messages ride the same rail, so the re-read goes through
 * the one per-key debounce (`lib/fileNodeReload`). Both doors are re-read, each
 * only for the groups already open through it.
 */
push.subscribe((accountId, type) => {
  if (type !== "FileNode") return;
  const name = groupNameForAccount(accountId);
  if (!name) return;
  const open = useAgents.getState();
  if (!(name in open.groupViews) && !(name in open.memberViews)) return;
  reloads.schedule(name, () => {
    const now = useAgents.getState();
    if (name in now.groupViews) void now.loadGroup(name);
    if (name in now.memberViews) void now.loadMemberView(name);
  });
});

// Push replays nothing to a tab that was away, so a view already open is
// re-read when the connection comes back. The debounce above is for a burst
// of live events; this is one pass, and the views it reads are only the ones
// already on screen.
push.onReconnect(() => {
  const now = useAgents.getState();
  for (const name of Object.keys(now.groupViews)) void now.loadGroup(name);
  for (const name of Object.keys(now.memberViews)) void now.loadMemberView(name);
  // A roster is a directory fact and nothing pushes it, so a reconnect is the
  // one moment a tab can be sure its copy is old: the groups already asked
  // about are asked again rather than left to age.
  for (const name of Object.keys(now.groupMembers)) void now.loadGroupMembers(name, true);
});
