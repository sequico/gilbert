/**
 * The agent worker fleet's client state (ADR 0003).
 *
 * Reads and writes go through `@/lib/agents`; this store is the UI's view of
 * them: the installation's fleet status, one group's documents at a time, the
 * per-tier providers and the approval queue. Nothing secret is kept here — the
 * provider view carries `hasKey` and never a key, and the rotated app-password
 * secret is handed straight back to whoever asked for it.
 */

import type { AgentRule } from "@gilbert/agent/documents";
import { create } from "zustand";
import { push } from "@/jmap/push";
import {
  type AgentGroupSurface,
  type AgentProvidersInput,
  type AgentProvidersView,
  type AgentStatus,
  fetchAgentGroup,
  fetchAgentProviders,
  fetchAgentStatus,
  fetchPendingApprovals,
  type PendingApproval,
  rotateAgentAppPassword,
  saveAgentProviders,
  saveAgentRules,
} from "@/lib/agents";
import { useSession } from "@/store/session";

/** Coalesce one burst of FileNode changes into a single group reload. */
const RELOAD_DEBOUNCE_MS = 400;

/**
 * The key a group's agent view is held under.
 *
 * Group names are matched case-insensitively — the server lower-cases them — so
 * every read and every write of `groupViews` goes through this one function,
 * whatever spelling of the name the caller happens to hold.
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
  approvals: PendingApproval[];
  /**
   * What is in flight and what failed, **per operation**.
   *
   * One shared pair was wrong in the way these surfaces are actually read: the
   * agent section runs several independent reads and writes at once, so a save
   * refused in one panel appeared as an error in another, and any unrelated
   * request in flight made a panel that had failed say "Loading…" instead of
   * what went wrong. Each operation has its own line, keyed by
   * `status`, `providers`, `approvals`, or `group:<name>`.
   */
  busy: Record<string, boolean>;
  problems: Record<string, string | null>;
  providers: AgentProvidersView | null;
  loadStatus: () => Promise<void>;
  loadGroup: (name: string) => Promise<void>;
  /** Rejects when the server refused the save; the editor reports the reason. */
  saveRules: (name: string, rules: AgentRule[]) => Promise<void>;
  loadProviders: () => Promise<void>;
  /** Rejects when the server refused the write; a key is never posted back. */
  saveProviders: (providers: AgentProvidersInput) => Promise<void>;
  /**
   * The new secret, for the caller to show exactly once. Rejects when the
   * rotation was refused — nothing is kept here, ever.
   */
  rotateAppPassword: () => Promise<string>;
  loadApprovals: () => Promise<void>;
  reset: () => void;
}

/** The key a group's own reads and writes are tracked under. */
export function groupOperation(name: string): string {
  return `group:${agentViewKey(name)}`;
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

export const useAgents = create<AgentsState>((set) => ({
  status: null,
  groupViews: {},
  approvals: [],
  busy: {},
  problems: {},
  providers: null,

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

  rotateAppPassword: async () => {
    set(markBusy("password", true));
    set(markProblem("password", null));
    try {
      return (await rotateAgentAppPassword()).secret;
    } catch (err) {
      set(markProblem("password", message(err)));
      throw err;
    } finally {
      set(markBusy("password", false));
    }
  },

  loadApprovals: async () => {
    set(markBusy("approvals", true));
    set(markProblem("approvals", null));
    try {
      set({ approvals: await fetchPendingApprovals() });
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
      approvals: [],
      busy: {},
      problems: {},
      providers: null,
    }),
}));

/** The group a FileNode change belongs to, when it is one this client knows. */
function groupNameForAccount(accountId: string): string | null {
  const accounts = useSession.getState().session?.accounts ?? {};
  const account = accounts[accountId];
  if (!account || account.isPersonal !== false) return null;
  return typeof account.name === "string" ? agentViewKey(account.name) : null;
}

const reloadTimers: Record<string, number> = {};

/*
 * A group's agent documents are FileNodes in the group's own account: when an
 * administrator saves rules, or a worker writes a job, the push rail reports a
 * StateChange for that account and the view re-reads it. A StateChange carries
 * only account and type — not which node changed — and chat messages ride the
 * same rail, so the re-read is debounced per group, like the label catalog.
 */
push.subscribe((accountId, type) => {
  if (type !== "FileNode") return;
  const name = groupNameForAccount(accountId);
  if (!name || !(name in useAgents.getState().groupViews)) return;
  if (reloadTimers[name]) clearTimeout(reloadTimers[name]);
  reloadTimers[name] = window.setTimeout(() => {
    delete reloadTimers[name];
    void useAgents.getState().loadGroup(name);
  }, RELOAD_DEBOUNCE_MS);
});
