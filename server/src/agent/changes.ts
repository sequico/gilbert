/**
 * One account's changes, and the runs they open or continue.
 *
 * Split from the loop it serves: this walks the account's change batch, asks
 * the decision turn which rules cover each change, continues the run a person
 * answered and opens one per rule named. It reads the pass's cursor and the
 * installation's prose and memory through `ChangesDeps`, so nothing here holds
 * the loop's claim or its alarms.
 */

import type { Ctx } from "../appFolder.js";
import { postChatMessage, readChatMessageAt } from "../groupChat.js";
import { CAPABILITIES } from "../shared/capabilities.js";
import { mentionsName } from "../shared/chat.js";
import { recallFacts } from "../shared/memory.js";
import type { RunDoc } from "../shared/run.js";
import { spendRun } from "../shared/run.js";
import { clientOf } from "../util.js";
import type { AccountEvent } from "./accountEvent.js";
import { anchorEvents, type EventCursor, readAccountEvents } from "./events.js";
import type { AnsweredRun, PassSummary } from "./loop.js";
import type { MemoryStore } from "./memory.js";
import type { ModelAccess } from "./model.js";
import { decideEvent, usageMeter } from "./model.js";
import type { ProseLevel } from "./prose.js";
import { type RuleDoc, ruleApplies } from "./rule.js";
import { listRules } from "./rules.js";
import { listRuns, type RunRecord } from "./runs.js";
import { readMessageForAnswer, sendMail } from "./tools/mail.js";

/** What the changes of one account need from the loop that asked for them. */
export interface ChangesDeps {
  ctx: Ctx;
  cursors: Map<string, EventCursor>;
  access: ModelAccess;
  proseAbove(accountId: string): Promise<Partial<Record<ProseLevel, string>>>;
  memory(): Promise<MemoryStore>;
  readingCall(
    accountId: string,
    event: AccountEvent,
    candidates: readonly RuleDoc[],
  ): { ctx: Ctx; accountId: string; run: RunDoc };
  runAnsweredBy(
    accountId: string,
    event: AccountEvent,
    records: readonly RunRecord[],
  ): Promise<AnsweredRun | "already" | null>;
  workRun(
    accountId: string,
    run: RunDoc,
    now: Date,
    facts?: Record<string, string>,
  ): Promise<void>;
  authoriseAnswer(answer: AnsweredRun): Promise<RunDoc>;
  openRun(accountId: string, event: AccountEvent, rule: RuleDoc): Promise<RunDoc>;
}

/** What woke a run, in the group's own words, from the event's own parts. */
export function wokeOf(event: AccountEvent): string {
  return `${event.source} ${event.change}: ${event.where}`;
}
/**
 * Which rule and which change a run is the answer to: its own `startedBy`.
 *
 * The change is named the way the run carries it (`wokeOf`), so the pair a run
 * is filed under and the pair a change is looked up by are one string and not
 * two spellings that could drift.
 */
function startKey(rule: string, woke: string): string {
  return `${rule}\n${woke}`;
}
/**
 * The account's runs by what started them: one entry per rule-and-change pair.
 *
 * A run an instruction started names no rule and no change, and is not an answer
 * to one — nothing here. Two runs of one pair cannot be written by this build,
 * and the one a pass can continue is the one still running, so that is the one
 * kept when a hand-written pair of documents says otherwise.
 *
 * shortcut: a change is named by its surface, its kind and its address, which is
 * all the change log hands over — so a document created again at a path a rule
 * already answered is read as the change that was answered, not as a new one.
 * Upgrade when an event can name the state it happened at, or the object's own
 * version, which is what tells a recurrence from a replay.
 */
function runsByStart(records: readonly RunRecord[]): Map<string, RunDoc> {
  const byStart = new Map<string, RunDoc>();
  for (const { run } of records) {
    const { rule, woke } = run.startedBy;
    if (!rule || !woke) continue;
    const key = startKey(rule, woke);
    const held = byStart.get(key);
    if (!held || (held.state !== "running" && run.state === "running"))
      byStart.set(key, run);
  }
  return byStart;
}
/** What an agent that is turned off says, in chat and by mail. */
const OFF_NOTICE = "AI agents are turned off.";

/**
 * A pass with the agent off: nothing is decided, nothing is modelled, and the
 * one thing that happens is an answer to the people who wrote.
 *
 * The owner chose this on 2026-10-19 (option 2): the off notice answers chat
 * and mail directly, without the class-3 licence a rule must otherwise carry
 * for outward mail. The guards are the ones that keep it from becoming a loop:
 * a message from the agent itself is never answered, and the cursor advances
 * once per batch, so each message is answered once.
 *
 * shortcut: a stranger's own auto-responder is not filtered, so an installation
 * that turns the agent off while a vacation responder writes to the group can
 * exchange notices. Upgrade by reading the standard auto-submitted headers (or
 * replying once per thread) before this becomes the default state.
 */
export async function offPath(
  deps: { ctx: Ctx; cursors: Map<string, EventCursor>; self: string },
  accountId: string,
): Promise<void> {
  let cursor = deps.cursors.get(accountId);
  if (!cursor) {
    cursor = await anchorEvents(deps.ctx, accountId);
    deps.cursors.set(accountId, cursor);
  }
  const read = await readAccountEvents(deps.ctx, accountId, cursor);
  for (const event of read.events) {
    if (event.change !== "created") continue;
    try {
      if (event.source === "chat") {
        const message = await readChatMessageAt(deps.ctx, accountId, event.where);
        if (!message || message.from === deps.self) continue;
        // In the group conversation the notice is for a message that names the
        // agent, not for everything the group says to itself.
        /*
         * A mention is either the stored mark or the words themselves: a person
         * typing `@gilbert` by hand leaves no mark, and the loose form is what
         * the conversation reads (`mentionsName`).
         */
        if (
          !mentionsName(message.text, deps.self) &&
          !message.mentions?.some(
            (one) => one.id.toLowerCase() === deps.self.toLowerCase(),
          )
        )
          continue;
        await postChatMessage(deps.ctx, accountId, deps.self, OFF_NOTICE, {
          replyTo: message.id,
        });
      } else if (event.source === "mail") {
        const message = await readMessageForAnswer(deps.ctx, accountId, event.where, {
          own: deps.self,
          known: [],
        });
        if (!message?.from || message.from === deps.self) continue;
        /*
         * Only mail the agent was addressed in **alone**: if the message also
         * went to anybody else — the group's own address, a colleague, a Cc —
         * the conversation is not the agent's, and it stays silent. A group's
         * ordinary correspondence is not a conversation with the agent.
         */
        const addressed = await clientOf(deps.ctx).call<{
          list?: Array<{
            to?: Array<{ email?: string | null }>;
            cc?: Array<{ email?: string | null }>;
          }>;
        }>("Email/get", { accountId, ids: [event.where], properties: ["to", "cc"] }, [
          CAPABILITIES.mail,
        ]);
        const mine = deps.self.toLowerCase();
        const isMine = (one: { email?: string | null }): boolean =>
          (one.email ?? "").toLowerCase() === mine;
        const addressees = (addressed.list ?? []).flatMap((one) => [
          ...(one.to ?? []),
          ...(one.cc ?? []),
        ]);
        if (addressees.length !== 1 || !isMine(addressees[0] ?? {})) continue;
        await sendMail(deps.ctx, accountId, {
          to: message.from,
          subject: OFF_NOTICE,
          text: OFF_NOTICE,
        });
      }
    } catch {
      /* the notice is best effort: a write that fails is retried by the next
         change, and a pass with the agent off must not fail over it */
    }
  }
  deps.cursors.set(accountId, read.cursor);
}

/** The decision turn's tokens, on the run it opened or continued. */
function withUsage(
  run: RunDoc,
  meter: { promptTokens: number; completionTokens: number; cachedTokens: number },
): RunDoc {
  if (!meter.promptTokens && !meter.completionTokens) return run;
  return spendRun(run, {
    promptTokens: meter.promptTokens,
    completionTokens: meter.completionTokens,
    cachedPromptTokens: meter.cachedTokens,
  });
}

export async function workChanges(
  deps: ChangesDeps,
  accountId: string,
  now: Date,
  summary: PassSummary,
): Promise<void> {
  let cursor = deps.cursors.get(accountId);
  if (!cursor) {
    // A first read anchors at where the account stands now: a process that
    // starts asks for the changes after it started, never for the whole
    // history (`events.ts`).
    cursor = await anchorEvents(deps.ctx, accountId);
    deps.cursors.set(accountId, cursor);
  }
  const read = await readAccountEvents(deps.ctx, accountId, cursor);
  if (read.gap) summary.gaps.push(read.gap);
  const rules = (await listRules(deps.ctx, accountId)).map((record) => record.rule);
  /** The runs the account already held, asked for once and only when needed. */
  let held: RunRecord[] | null = null;
  for (const event of read.events) {
    summary.changes += 1;
    /*
     * A chat message is read once here, so the decision turn has its words
     * without spending a model call and a round trip on `chat.read`.
     */
    const message =
      event.source === "chat" && event.change !== "destroyed"
        ? await readChatMessageAt(deps.ctx, accountId, event.where)
        : null;
    /*
     * The agent's own words are not activity to answer: its own status message
     * would otherwise wake every rule that watches chat and pay a model call to
     * read itself, each reply opening the next round.
     */
    if (message && message.from.toLowerCase() === deps.ctx.username.toLowerCase())
      continue;
    /*
     * A message that answers a run's question continues that run and opens no
     * run of its own (ADR 0033). The correlation is the record's — a reply to
     * the question in chat, a mail in its thread — so it is asked before any
     * rule and on **whatever surface the answer arrived on**: a question asked
     * in chat by a rule that watches mail is answered in chat, and the answer
     * is not a change that rule watches.
     */
    const couldAnswer =
      (event.source === "chat" && message?.replyTo !== undefined) ||
      (event.source === "mail" && event.change !== "destroyed");
    if (couldAnswer) {
      held ??= await listRuns(deps.ctx, accountId);
      const answer = await deps.runAnsweredBy(accountId, event, held);
      if (answer === "already") continue;
      if (answer) {
        summary.due += 1;
        await deps.workRun(accountId, await deps.authoriseAnswer(answer), now);
        continue;
      }
    }
    const candidates = rules.filter((rule) => ruleApplies(rule, event));
    // A change no rule watches costs no model call and no step (ADR 0035).
    if (!candidates.length) continue;
    const woke = wokeOf(event);
    /*
     * What the installation holds and the group wrote above the rule: the
     * installation's own line and the group's standing instruction reach the
     * decision turn too, because which rules apply is asked of the same agent
     * (ADR 0035).
     */
    const detail = message
      ? {
          from: message.from,
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        }
      : null;
    const meter = usageMeter();
    const decision = await decideEvent(
      deps.access,
      {
        event,
        rules,
        prose: await deps.proseAbove(accountId),
        memory: recallFacts((await deps.memory()).facts, woke, accountId),
        ...(detail ? { detail } : {}),
      },
      deps.readingCall(accountId, event, candidates),
      { meter },
    );
    if (decision.kind === "reply") {
      /*
       * The fast path: a chat message that only wants words is answered by the
       * call that decided it, instead of opening a run and a step to say the
       * same. Other surfaces are never answered in the group's chat, so a
       * reply chosen for them is a decision with nothing to do.
       */
      if (event.source === "chat")
        await postChatMessage(
          deps.ctx,
          accountId,
          deps.ctx.username,
          decision.text,
          message?.id ? { replyTo: message.id } : {},
        );
      continue;
    }
    if (decision.kind !== "decision") continue;
    for (const named of decision.rules) {
      const rule = rules.find((candidate) => candidate.id === named);
      if (!rule) continue;
      const key = startKey(named, woke);
      // A run of the account that already names this rule and this change is
      // that change being worked, or the answer it already has: never a second
      // run over it.
      held ??= await listRuns(deps.ctx, accountId);
      const open = runsByStart(held).get(key);
      if (open) {
        if (open.state === "running")
          await deps.workRun(accountId, withUsage(open, meter), now, decision.facts);
        continue;
      }
      const run = await deps.openRun(accountId, event, rule);
      summary.runs += 1;
      await deps.workRun(accountId, withUsage(run, meter), now, decision.facts);
    }
  }
  // The cursor moves only once the batch is answered: a read that failed
  // half-way is read again rather than lost as silence.
  deps.cursors.set(accountId, read.cursor);
}
