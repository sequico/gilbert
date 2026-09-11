/**
 * The worker: the agent's own process (ADR 0003 §2, v1 scope).
 *
 * Same codebase, second entrypoint. It authenticates as the one structure agent
 * the installation registered, claims the `account × area` units it will serve,
 * and holds the agent's event stream when it wins that claim. Nothing durable
 * lives in it: the claims, the jobs and the decisions are documents, so a
 * restart re-derives the session, re-claims what is free and carries on from
 * the state the last worker recorded. A second worker on the same installation
 * keeps the claims it can and polls for the rest — which is why the default
 * deployment is one.
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { type Ctx, filesAccountId, readAppJsonAt, writeAppFileAt } from "../appFolder.js";
import { agentGroupAreas, config } from "../config.js";
import { JmapClient, serverNow } from "../jmap.js";
import {
  fetchUpstreamSession,
  UpstreamError,
  type UpstreamSession,
  upstreamFor,
} from "../upstream.js";
import { readChat } from "./chat.js";
import {
  AGENT_AREAS,
  type AgentArea,
  type AgentClaim,
  type AgentStreamClaim,
  type AgentWorkerRecord,
} from "./documents.js";
import {
  AUDIT_RETENTION_MS,
  type ChangeType,
  DOCUMENT_RETENTION_MS,
  Executor,
} from "./executor.js";
import {
  type ClaimRefusal,
  claimArea,
  claimStream,
  releaseClaim,
  releaseStreamClaim,
  workerId as workerIdOf,
} from "./lease.js";
import { AgentStore } from "./store.js";
import { type AgentWithdrawal, WITHDRAWALS_PATH } from "./views.js";
import { openEventStream, pollLoop } from "./wake.js";

/** How many areas one account's pass reconciles per JMAP type. */
const TYPES_BY_AREA: Readonly<Record<AgentArea, ReadonlyArray<ChangeType>>> = {
  mail: ["Email"],
  files: ["FileNode"],
  tasks: [],
  calendars: [],
  contacts: [],
};

export interface WorkerDeps {
  /** The agent's own session context, derived from its app password. */
  ctx: Ctx;
  /** The agent's address: the identity of everything it writes. */
  address: string;
  /** The areas this deployment declares for the worker. */
  areas: ReadonlyArray<AgentArea>;
  /** Defaults to a `[gilbert]`-prefixed console line. */
  log?: (line: string) => void;
  /** Defaults to an id derived from the address and this process. */
  workerId?: string;
  now?: () => Date;
  pollMs?: number;
  heartbeatMs?: number;
  leaseMs?: number;
  /**
   * False in a test: the handle then runs only what `pass()` drives, instead of
   * keeping the process alive with timers and a stream.
   */
  timers?: boolean;
}

export interface WorkerHandle {
  /** One pass: claim, reconcile, retry, answer, prune. Returns the accounts served. */
  pass(): Promise<ReadonlyArray<string>>;
  /** The accounts this worker holds a claim on. */
  served(): ReadonlyArray<string>;
  /** What a health endpoint and an operator read: this worker, right now. */
  health(): WorkerHealth;
  /** Release everything and stop: the stream claim first, so a peer can take it. */
  stop(): Promise<void>;
}

/**
 * What a running worker reports about itself.
 *
 * Deployment's restart policy needs one thing to ask: is this process serving
 * what it claimed (ADR 0003 resolution 8). What it does *not* report is
 * whether the agent's work is going well — a failed job is a document in the
 * group's account and belongs in the audit, not in a liveness probe that a
 * restart would answer by starting the work over.
 */
export interface WorkerHealth {
  status: "ok";
  worker: string;
  address: string;
  areas: ReadonlyArray<AgentArea>;
  /** The accounts the worker holds a claim on right now. */
  accounts: ReadonlyArray<string>;
  /** Whether this worker holds the agent's event stream. */
  streaming: boolean;
  startedAt: string;
  uptimeSeconds: number;
}

/** The accounts a v1 worker may serve: group mailboxes, and nothing personal. */
export function candidateAccounts(session: UpstreamSession): string[] {
  const out: string[] = [];
  for (const [id, account] of Object.entries(session.accounts ?? {})) {
    const info = account as { isPersonal?: unknown; name?: unknown };
    // v1 is group agents only (ADR resolution 4): a person's own mailbox is not
    // this worker's work, whatever the principal can reach.
    if (info.isPersonal !== false) continue;
    const name = typeof info.name === "string" ? info.name : "";
    if (!name.includes("@")) continue;
    out.push(id);
  }
  return out;
}

/** The Authorization header a plain principal authenticates with. */
export function basicAuth(address: string, password: string): string {
  return `Basic ${Buffer.from(`${address}:${password}`, "utf8").toString("base64")}`;
}

/**
 * The areas a group is served with: the deployment's list, narrowed by the
 * installation's own record for that group (ADR 0009).
 *
 * Nothing widens here. An installation can take work away from a group — a
 * document cannot hand it work the operator did not open — and a group the
 * record does not name is served exactly as the deployment says. This is the
 * whole of the intersection, in one place.
 */
export function servedAreasFor(
  deployment: ReadonlyArray<AgentArea>,
  narrowed: ReadonlyArray<AgentArea> | null,
): AgentArea[] {
  if (!narrowed?.length) return [...deployment];
  return deployment.filter((area) => narrowed.includes(area));
}

/** The areas this worker serves for one account, by its name in the session. */
export function areasFor(
  session: UpstreamSession,
  accountId: string,
  deployment: ReadonlyArray<AgentArea>,
): AgentArea[] {
  const name = groupNameOf(session, accountId);
  return servedAreasFor(deployment, name ? agentGroupAreas(name) : null);
}

/**
 * The accounts the session listed and no longer does, with the names they had.
 *
 * A grant withdrawn in Stalwart's own administration removes the group from the
 * agent's session — that is what a grant *is* — so the accounts the worker was
 * serving and the accounts the session still lists are the whole of the
 * detection. The names travel with it because the session is exactly what stops
 * carrying them: after the withdrawal there is nowhere left to ask.
 *
 * Pure, and the reason it is: the pass does the reading and the reporting, and
 * this is the judgement, worth a test of its own.
 */
export function withdrawnAccounts(
  before: ReadonlyMap<string, string>,
  after: ReadonlyArray<string>,
): Array<{ account: string; name: string }> {
  const still = new Set(after);
  const gone: Array<{ account: string; name: string }> = [];
  for (const [account, name] of before) {
    if (!still.has(account)) gone.push({ account, name });
  }
  return gone;
}

/** The group name the session gives one account, or empty when it gives none. */
export function groupNameOf(session: UpstreamSession, accountId: string): string {
  const account = session.accounts?.[accountId] as { name?: unknown } | undefined;
  return typeof account?.name === "string" ? account.name.trim().toLowerCase() : "";
}

/**
 * Start serving. The handle is the seam a test drives: `pass()` runs one full
 * round, `stop()` releases the claims and the stream.
 */
export async function startWorker(deps: WorkerDeps): Promise<WorkerHandle> {
  const log = deps.log ?? ((line: string) => console.log(`[gilbert] ${line}`));
  // The clock the fleet agrees on: the mail server's own, as its responses
  // report it (`serverNow`). A lease is about whether another process is still
  // alive, and two processes comparing their own clocks is how one of them
  // concludes the other is dead. A test injects its own.
  const now = deps.now ?? serverNow;
  const pollMs = deps.pollMs ?? config.agent.pollMs;
  const heartbeatMs = deps.heartbeatMs ?? config.agent.heartbeatMs;
  const leaseMs = deps.leaseMs ?? config.agent.leaseMs;
  const id = deps.workerId ?? workerIdOf(deps.address);
  const timers = deps.timers !== false;

  const client = new JmapClient(deps.ctx);
  const executor = new Executor({
    ctx: deps.ctx,
    client,
    address: deps.address,
    workerId: id,
    now,
    log,
  });
  const agentStore = new AgentStore(deps.ctx, filesAccountId(deps.ctx));
  const startedAt = now().toISOString();

  const servedAreas = new Map<string, Set<AgentArea>>();
  /** The accounts the session listed when the pass last looked, by name. */
  let knownAccounts = new Map<string, string>();
  /** When the session was last re-read: never more often than the poll interval. */
  let refreshedAt = 0;
  const scheduleDisposers = new Map<string, () => void>();
  const disposers: Array<() => void> = [];
  let streamClaim: AgentStreamClaim | null = null;
  let closeStream: (() => void) | null = null;
  let stopped = false;
  let lastPrune = 0;
  const dirty = new Set<string>();
  const reconciling = new Set<string>();

  /** The types this worker has to reconcile for one account. */
  const typesOf = (accountId: string): ChangeType[] => {
    const areas = servedAreas.get(accountId);
    if (!areas) return [];
    const types = new Set<ChangeType>();
    for (const area of areas) for (const type of TYPES_BY_AREA[area]) types.add(type);
    return [...types];
  };

  const areaOf = (accountId: string, type: ChangeType): AgentArea | null => {
    const areas = servedAreas.get(accountId);
    if (!areas) return null;
    for (const area of areas) if (TYPES_BY_AREA[area].includes(type)) return area;
    return null;
  };

  const reconcileAccount = async (accountId: string): Promise<void> => {
    const store = new AgentStore(deps.ctx, accountId);
    const types = typesOf(accountId);
    for (const type of types) {
      const area = areaOf(accountId, type);
      if (!area) continue;
      const claim = (await store.readClaim(area))?.doc;
      if (!claim) continue;
      try {
        await executor.reconcile(accountId, type, claim);
      } catch (err) {
        // A lost reconcile is not a lost worker: the state stays where it was,
        // so the next pass re-reads the same range.
        log(
          `${accountId}: ${type} reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Nothing wakes the worker for a time trigger — it is not a change — so the
    // pass asks. This is the catch-up for the runs a worker was away for, and
    // it reads the due entries back out of the document on every round.
    const due = await executor.runDueSchedules(accountId);
    if (due) log(`${accountId}: ${due} scheduled run(s) due`);
    const areas = [...(servedAreas.get(accountId) ?? [])];
    const retried = await executor.runPending(accountId, areas);
    if (retried) log(`${accountId}: retried ${retried} job(s)`);
    // An audit entry a contended document pushed out of its retries is held in
    // memory: the pass writes it, so a group that has gone quiet does not carry
    // it until it happens to write something else.
    const carried = await store.flushPendingAudits();
    if (carried) log(`${accountId}: wrote ${carried} held audit entry(ies)`);
    const decisions = (await store.listDecisions())
      .map((entry) => entry.doc)
      .filter((decision) => decision.state === "pending");
    if (decisions.length) {
      // The draft that left Drafts is settled **before** the chat is read: a
      // member who sent the draft and then wrote "sì" has approved once by
      // sending it, and the document that wins is the one a person acted on.
      // Resolving the reply first would settle the decision on the
      // conversational answer and leave the sent draft unexplained.
      await executor.sweepDrafts(
        accountId,
        decisions.filter((decision) => decision.draft).map((decision) => decision.id),
      );
      const messages = await readChat(deps.ctx, accountId, client);
      const answered = await executor.answerDecisions(accountId, messages);
      if (answered.length)
        log(`${accountId}: ${answered.length} decision(s) answered in the chat`);
    }
    if (!scheduleDisposers.has(accountId)) {
      // A far-future entry is re-checked each poll rather than trusted to one
      // long timer; the same cap keeps a paused container's clock jump honest.
      scheduleDisposers.set(
        accountId,
        await executor.armSchedule(accountId, { maxDelayMs: pollMs }),
      );
    }
  };

  /** Reconcile the accounts the stream just woke, one at a time. */
  const drain = async (): Promise<void> => {
    for (const accountId of [...dirty]) {
      if (stopped || reconciling.has(accountId)) continue;
      dirty.delete(accountId);
      reconciling.add(accountId);
      try {
        await reconcileAccount(accountId);
      } finally {
        reconciling.delete(accountId);
      }
    }
  };

  const wake = (accountId: string, type: string): void => {
    if (!servedAreas.has(accountId)) return;
    if (type !== "Email" && type !== "FileNode") return;
    dirty.add(accountId);
    void drain().catch((err: unknown) =>
      log(`reconcile failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  const openStreamIfHeld = (): void => {
    // The stream is a process-level concern: a test drives `pass()` alone and
    // holds the claim document without opening a live connection.
    if (!timers || closeStream || !streamClaim) return;
    const types = new Set<string>();
    for (const accountId of servedAreas.keys())
      for (const type of typesOf(accountId)) types.add(type);
    closeStream = openEventStream(
      deps.ctx.session,
      deps.ctx.authorization,
      [...types],
      wake,
      (err) => log(`the event stream failed: ${err.message}`),
    );
    log(`holding the agent's event stream (${[...types].join(", ")})`);
  };

  const heartbeat = async (): Promise<void> => {
    const stamp = now().toISOString();
    const record: AgentWorkerRecord = {
      v: 1,
      id,
      address: deps.address,
      areas: [...deps.areas],
      version: config.version,
      startedAt,
      heartbeatAt: stamp,
    };
    await agentStore.writeWorker(record);
    for (const [accountId, areas] of servedAreas) {
      const store = new AgentStore(deps.ctx, accountId);
      for (const area of [...areas]) {
        const renewed = await claimArea(store, area, id, { now: now(), leaseMs });
        if (!renewed) {
          // A peer took it over while this worker was renewing: stop serving it
          // rather than work an account somebody else owns now.
          areas.delete(area);
          log(`lost ${accountId}/${area}`);
        }
      }
    }
    if (streamClaim) {
      const renewed = await claimStream(agentStore, id, { now: now(), leaseMs });
      if (!renewed && closeStream) {
        // Somebody else holds the stream now: stop reading, keep polling.
        closeStream();
        closeStream = null;
        streamClaim = null;
        log("the event stream claim moved to another worker; polling");
      }
    }
    if (now().getTime() - lastPrune > heartbeatMs) {
      lastPrune = now().getTime();
      const cutoff = new Date(now().getTime() - DOCUMENT_RETENTION_MS);
      const auditCutoff = new Date(now().getTime() - AUDIT_RETENTION_MS);
      for (const accountId of servedAreas.keys()) {
        const removed = await executor.prune(accountId, cutoff);
        if (removed) log(`${accountId}: pruned ${removed} finished document(s)`);
        const months = await executor.pruneAudit(accountId, auditCutoff);
        if (months) log(`${accountId}: pruned ${months} audit month(s)`);
      }
    }
  };

  /**
   * What a refused claim says: contention out loud, ownership not.
   *
   * Losing a claim to a peer that holds a live lease is the design working, and
   * saying it every pass would be noise. Losing every write to a unit nobody
   * holds is the fleet quietly stopping, and nothing else in the process would
   * ever say so.
   */
  const refused = (accountId: string, area: AgentArea) => (reason: ClaimRefusal) => {
    if (reason === "contended")
      log(`${accountId}/${area}: nobody holds it and the claim kept losing`);
  };

  // One account's fault is that account's: an unreadable claim document ends the
  // round for that account alone, instead of ending it for every account behind
  // it in the list, and the pass says what it caught (resolution 18).
  const guarded = async (accountId: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      log(
        `${accountId}: the pass could not finish this account: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Re-read the agent's session, at most once per poll interval.
   *
   * A grant withdrawn in Stalwart's own administration removes the group from
   * the agent's session — that is what a grant is — and nothing announces it:
   * the account simply stops being listed. Re-reading on a timer is what turns
   * that into a fact the pass can act on, and the interval is the poll interval
   * the worker already runs on, a third of a lease, so no new knob arrives with
   * it. A refresh that fails is not a withdrawal: the session in force stays in
   * force and the next pass tries again.
   *
   * It replaces the context's session, which is what everything downstream
   * reads: the pass's accounts and the installation's narrowing, the executor,
   * and the client itself — each holds the context, not a copy of the session,
   * so nothing carries the withdrawn account forward.
   */
  const refreshSession = async (): Promise<void> => {
    const at = now().getTime();
    if (at - refreshedAt < pollMs) return;
    refreshedAt = at;
    try {
      deps.ctx.session = await openSession(
        deps.ctx.authorization,
        upstreamFor(deps.address),
      );
    } catch (err) {
      log(
        `could not re-read the agent's session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Write down a grant the agent has lost, with what it was holding.
   *
   * In the agent's **own** account, because it is the only place it can still
   * write: the moment the grant is gone, the group's own documents are refused
   * to it. So the report is what the worker held and when it noticed — the work
   * a withdrawal leaves behind is in the group's audit, unreadable from here,
   * and saying more than this would be inventing it.
   */
  const reportWithdrawal = async (
    account: string,
    group: string,
    heldAreas: ReadonlyArray<AgentArea>,
  ): Promise<void> => {
    const self = filesAccountId(deps.ctx);
    const seen = await readAppJsonAt(deps.ctx, self, WITHDRAWALS_PATH);
    const entries = Array.isArray(seen) ? (seen as AgentWithdrawal[]) : [];
    const entry: AgentWithdrawal = {
      account,
      group,
      heldAreas: [...heldAreas],
      at: now().toISOString(),
    };
    await writeAppFileAt(
      deps.ctx,
      self,
      WITHDRAWALS_PATH,
      [...entries, entry].slice(-20),
    );
    log(`${group || account}: the agent's grant on this group is gone`);
  };

  const pass = async (): Promise<ReadonlyArray<string>> => {
    if (stopped) return [...servedAreas.keys()];
    await refreshSession();
    const accounts = candidateAccounts(deps.ctx.session);
    // An account the worker was serving and the session no longer lists is a
    // grant that has been withdrawn. It stops being served here and is reported
    // once, rather than failing against it on every pass for as long as the
    // worker runs — and nothing here writes or touches a claim: the leases it
    // still holds under that account lapse on their own, which is how a
    // withdrawal is meant to end (ADR 0003 §2).
    const gone = withdrawnAccounts(knownAccounts, accounts);
    knownAccounts = new Map(
      accounts.map((accountId) => [accountId, groupNameOf(deps.ctx.session, accountId)]),
    );
    for (const { account, name } of gone) {
      const held = [...(servedAreas.get(account) ?? [])];
      servedAreas.delete(account);
      await guarded(account, () => reportWithdrawal(account, name, held));
    }
    for (const accountId of accounts) {
      await guarded(accountId, async () => {
        const store = new AgentStore(deps.ctx, accountId);
        const held = servedAreas.get(accountId) ?? new Set<AgentArea>();
        // The deployment's areas, narrowed by the installation's record for this
        // group (ADR 0009). An area the record no longer covers stops being
        // renewed, so its lease lapses on its own: nothing here writes or
        // deletes a claim document, and nothing here touches the fence.
        const served = areasFor(deps.ctx.session, accountId, deps.areas);
        for (const area of [...held]) if (!served.includes(area)) held.delete(area);
        for (const area of served) {
          if (held.has(area)) {
            // Renewal is what keeps a claim from looking stale to a peer.
            const renewed = await claimArea(store, area, id, {
              now: now(),
              leaseMs,
              onRefused: refused(accountId, area),
            });
            if (!renewed) {
              held.delete(area);
              log(`lost ${accountId}/${area}`);
            }
            continue;
          }
          const claim: AgentClaim | null = await claimArea(store, area, id, {
            now: now(),
            leaseMs,
            onRefused: refused(accountId, area),
          });
          if (!claim) continue;
          held.add(area);
          log(`claimed ${accountId}/${area}`);
        }
        if (held.size) servedAreas.set(accountId, held);
        else servedAreas.delete(accountId);
      });
    }
    // The heartbeat is written even when nothing is served: the status surface
    // has to be able to say that a worker is up and idle.
    await heartbeat();
    if (!servedAreas.size) return [];
    if (!streamClaim) {
      const won = await claimStream(agentStore, id, { now: now(), leaseMs });
      if (won) {
        streamClaim = won;
        openStreamIfHeld();
      }
    } else {
      openStreamIfHeld();
    }
    for (const accountId of servedAreas.keys())
      await guarded(accountId, () => reconcileAccount(accountId));
    return [...servedAreas.keys()];
  };

  if (timers) {
    disposers.push(
      pollLoop(
        pollMs,
        async () => {
          await pass();
        },
        {
          onError: (err) =>
            log(`the pass threw: ${err instanceof Error ? err.message : String(err)}`),
        },
      ),
    );
    disposers.push(
      pollLoop(heartbeatMs, async () => {
        await heartbeat();
      }),
    );
  }

  return {
    pass,
    served: () => [...servedAreas.keys()],
    health: () => ({
      status: "ok",
      worker: id,
      address: deps.address,
      areas: [...deps.areas],
      accounts: [...servedAreas.keys()],
      streaming: streamClaim !== null,
      startedAt,
      uptimeSeconds: Math.max(
        0,
        Math.round((now().getTime() - Date.parse(startedAt)) / 1000),
      ),
    }),
    stop: async () => {
      stopped = true;
      for (const dispose of disposers) dispose();
      for (const dispose of scheduleDisposers.values()) dispose();
      scheduleDisposers.clear();
      if (closeStream) {
        closeStream();
        closeStream = null;
      }
      if (streamClaim) {
        await releaseStreamClaim(agentStore, id);
        streamClaim = null;
      }
      // The areas too: a replacement worker has a fresh id and would otherwise
      // wait out the lease before serving anything.
      for (const [accountId, areas] of servedAreas) {
        const store = new AgentStore(deps.ctx, accountId);
        for (const area of areas) await releaseClaim(store, area, id);
      }
      servedAreas.clear();
    },
  };
}

/** How long a worker waits for an upstream that has not opened its door yet. */
const BOOT_ATTEMPTS = 6;
const BOOT_DELAY_MS = 1000;

/**
 * Open the agent's session, waiting out an upstream that is not there yet.
 *
 * The missing-configuration case has already exited above, so what is left
 * here is the server side: a container orchestrator replaces a worker that
 * cannot reach Stalwart, but a development stack starts the mock and the
 * worker together and a worker that dies in that first second is a papercut,
 * not a diagnosis. A refused credential is not a race and is not retried —
 * that failure belongs loud and immediate.
 */
async function openSession(
  authorization: string,
  base: string,
): Promise<UpstreamSession> {
  let last: unknown;
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
    try {
      return await fetchUpstreamSession(authorization, base);
    } catch (err) {
      last = err;
      if (err instanceof UpstreamError && err.status === 401) break;
      if (attempt < BOOT_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, BOOT_DELAY_MS * attempt));
    }
  }
  throw last instanceof Error ? last : new Error("the agent session could not be opened");
}

/**
 * The worker's health endpoint (ADR 0003 resolution 8).
 *
 * A restart policy can only act on an answer, and a worker that is up but
 * holds no claim is not serving anything: the endpoint reports which accounts
 * this process is actually working, so a deployment can tell "running" from
 * "running and useless". It is started only when the deployment names a port
 * (`GILBERT_AGENT_HEALTH_PORT`) — a worker otherwise needs no inbound surface
 * at all, and a port nobody asked for is surface for nothing.
 */
export function startHealthServer(opts: {
  port: number;
  health: () => WorkerHealth;
}): () => void {
  const server = createServer((req, res) => {
    if ((req.url ?? "/").split("?")[0] !== "/health") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(opts.health()));
  });
  server.listen(opts.port, "0.0.0.0");
  return () => server.close();
}

/**
 * The agent the deployment names, as the worker needs it.
 *
 * `config.agent` is bootstrap configuration, resolved when the module loaded:
 * the environment cannot change under a running process, so this is the word
 * the deployment started with.
 */
export interface AgentIdentity {
  address: string;
  password: string;
  areas: AgentArea[];
}

/**
 * How often the running fleet asks whether the deployment renamed the agent.
 *
 * This is not the session's own poll: a session is re-read every poll interval
 * because a grant changes inside the mail server, while this asks whether the
 * *deployment* changed the identity. Both are cheap reads of a file that is
 * re-read on its own stamp, so this only decides how long a hand-edited file
 * takes to matter.
 */
const AGENT_IDENTITY_RECHECK_MS = 2_000;

/** The agent the deployment names right now. */
export function currentIdentity(): AgentIdentity {
  const { address, password, areas } = config.agent;
  return { address, password, areas: [...areas] };
}

/** Whether two identities would start the same fleet. */
export function sameIdentity(a: AgentIdentity, b: AgentIdentity): boolean {
  return (
    a.address === b.address &&
    a.password === b.password &&
    a.areas.length === b.areas.length &&
    a.areas.every((area, index) => area === b.areas[index])
  );
}

/** Sign in as an identity, the way the worker does at boot. */
async function signInAs(
  identity: AgentIdentity,
): Promise<{ authorization: string; session: UpstreamSession }> {
  const authorization = basicAuth(identity.address, identity.password);
  return {
    authorization,
    session: await openSession(authorization, upstreamFor(identity.address)),
  };
}

/**
 * The identity the running fleet should follow, or null to stay as it is.
 *
 * A deployment that renames the agent is followed by signing in as the new one
 * **before** anything is stopped: a sign-in that fails leaves the fleet that is
 * serving alone, so a deployment mid-edit never takes a working agent down.
 * Null is therefore three things — nothing changed, nothing usable is named any
 * more, or what is named cannot sign in — and each of them means the groups
 * being served keep being served.
 */
export async function identityToFollow(
  running: AgentIdentity,
  deps: {
    current?: () => AgentIdentity;
    signIn?: (
      identity: AgentIdentity,
    ) => Promise<{ authorization: string; session: UpstreamSession }>;
    log?: (line: string) => void;
  } = {},
): Promise<{ identity: AgentIdentity; ctx: Ctx } | null> {
  const log = deps.log ?? ((line: string) => console.log(`[gilbert] ${line}`));
  const wanted = (deps.current ?? currentIdentity)();
  if (sameIdentity(running, wanted)) return null;
  if (!wanted.address || !wanted.password) {
    log("the deployment no longer names a usable agent: the fleet keeps serving");
    return null;
  }
  try {
    const { authorization, session } = await (deps.signIn ?? signInAs)(wanted);
    return {
      identity: wanted,
      ctx: { authorization, session, username: wanted.address },
    };
  } catch (err) {
    log(
      `${wanted.address} could not sign in, so the fleet keeps serving ${running.address}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

/** The areas a fleet serves, as the startup line names them. */
const servedAreas = (identity: AgentIdentity): string =>
  identity.areas.join(", ") || AGENT_AREAS.join(", ");

/** Start serving one identity: sign in as it, then start a fleet on that. */
async function startFleet(identity: AgentIdentity): Promise<WorkerHandle> {
  const { authorization, session } = await signInAs(identity);
  const ctx: Ctx = { authorization, session, username: identity.address };
  return startWorker({ ctx, address: identity.address, areas: identity.areas });
}

/** The worker's own entrypoint: no half-configured start, ever. */
export async function main(): Promise<void> {
  const first = currentIdentity();
  if (!first.address || !first.password) {
    console.error(
      "[gilbert] the agent worker is not configured: set GILBERT_AGENT_ADDRESS and " +
        "GILBERT_AGENT_PASSWORD, and start this process inside a deployment that " +
        "carries both; nothing started",
    );
    process.exit(1);
  }
  let identity = first;
  let worker = await startFleet(identity);
  const closeHealth =
    config.agent.healthPort > 0
      ? startHealthServer({
          port: config.agent.healthPort,
          health: () => worker.health(),
        })
      : null;
  if (closeHealth)
    console.log(
      `[gilbert] agent health: http://0.0.0.0:${config.agent.healthPort}/health`,
    );
  console.log(
    `[gilbert] agent worker for ${identity.address} serving ${servedAreas(identity)}`,
  );

  // The deployment can rename the agent while this process runs, and a restart
  // is not how a hand-edited file should have to be applied. `identityToFollow`
  // signs in as the new agent first, so a fleet is only ever replaced by one
  // that can already serve.
  const watch = setInterval(() => {
    void (async () => {
      const next = await identityToFollow(identity);
      if (!next) return;
      await worker.stop();
      worker = await startFleet(next.identity);
      identity = next.identity;
      console.log(
        `[gilbert] the agent is now ${identity.address}, serving ${servedAreas(identity)}`,
      );
    })();
  }, AGENT_IDENTITY_RECHECK_MS);

  const shutdown = async (signal: string) => {
    console.log(`[gilbert] ${signal} received, stopping the agent worker`);
    clearInterval(watch);
    closeHealth?.();
    await worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Only when this file is the process's entrypoint: the module is imported by
// the tests and by anything that wants the seam, and neither should start a
// fleet by importing it.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry && import.meta.url === entry) {
  main().catch((err) => {
    console.error("[gilbert] fatal:", err);
    process.exit(1);
  });
}
