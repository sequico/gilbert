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
import { addressesAgent } from "../shared/chat.js";
import { errorMessage } from "../shared/errors.js";
import { recallFacts } from "../shared/memory.js";
import type { RunDoc } from "../shared/run.js";
import { spendRun } from "../shared/run.js";
import { clientOf } from "../util.js";
import type { AccountEvent } from "./accountEvent.js";
import {
  type AccountEvents,
  anchorEvents,
  type EventCursor,
  readAccountEvents,
} from "./events.js";
import type { AnsweredRun, PassSummary, RefusedAnswer } from "./loop.js";
import type { MemoryStore } from "./memory.js";
import type { ModelAccess } from "./model.js";
import { decideEvent, usageMeter } from "./model.js";
import type { ProseLevel } from "./prose.js";
import { type Drop, dropEvent } from "./queue.js";
import { type RuleDoc, ruleApplies } from "./rule.js";
import { listRules } from "./rules.js";
import { listRunsForWorking, type RunRecord } from "./runs.js";
import { takeOwnCalendarChange } from "./tools/calendar.js";
import type { ImageReader } from "./tools/content.js";
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
  ): { ctx: Ctx; accountId: string; run: RunDoc; readImage: ImageReader };
  runAnsweredBy(
    accountId: string,
    event: AccountEvent,
    records: readonly RunRecord[],
  ): Promise<AnsweredRun | "already" | RefusedAnswer | null>;
  /** Keep an answer that was not its sender's own word on the run it answered. */
  recordRefusal(accountId: string, refused: RefusedAnswer): Promise<RunDoc | null>;
  workRun(
    accountId: string,
    run: RunDoc,
    facts?: Record<string, string>,
    /** The questions the group already has open, so this run does not re-ask. */
    openQuestions?: readonly string[],
  ): Promise<RunDoc | null>;
  authoriseAnswer(answer: AnsweredRun): Promise<RunDoc>;
  /** Hold a file event until its folder's burst is over (`queue.ts`). */
  noteDrop(accountId: string, path: string, now: Date): Promise<void>;
  /** The drops whose burst is over, one event each. */
  dueDrops(accountId: string, now: Date): Promise<Drop[]>;
  /** Drop a folder from the queue, once its batch was worked. */
  forgetDrop(accountId: string, folder: string): Promise<void>;
  /** Take a destroyed file out of a drop still waiting. */
  forgetDropPath(accountId: string, path: string): Promise<void>;
  /** Read the one document a file change names, for the decision turn. */
  readEventFile(
    accountId: string,
    path: string,
  ): Promise<{ path: string; text: string } | null>;
  openRun(
    accountId: string,
    event: AccountEvent,
    rule: RuleDoc,
    /** The sender the waking message named, or null when the change names none. */
    from: string | null,
  ): Promise<RunDoc>;
}

/**
 * How many changes one pass reads per log: a page small enough that a backlog
 * cannot pay a decision call per change all at once. The next pass resumes at
 * the state this page ended at.
 */
const CHANGES_PER_PASS = 20;

/**
 * One account's changes for one pass, on the cursor the process already holds
 * or anchored where it stands now. The reading is the same one `workChanges`
 * used to make for itself; the pass makes it first so the FileNode state it
 * ends at is the state the run listing is judged against.
 */
export async function readChangesForPass(
  ctx: Ctx,
  cursors: Map<string, EventCursor>,
  accountId: string,
): Promise<AccountEvents> {
  let cursor = cursors.get(accountId);
  if (!cursor) {
    cursor = await anchorEvents(ctx, accountId);
    cursors.set(accountId, cursor);
  }
  return await readAccountEvents(ctx, accountId, cursor, {
    maxPages: 1,
    maxChanges: CHANGES_PER_PASS,
  });
}

/** What woke a run, in the group's own words, from the event's own parts. */
export function wokeOf(event: AccountEvent): string {
  const base = `${event.source} ${event.change}: ${event.where}`;
  // A batched drop is one change: the folder, how many files it brought, and the
  // instant it opened — which is what keeps a second drop in the same folder a
  // second run rather than "the change that was answered".
  return event.also?.length
    ? `${base} (${event.also.length} files, ${event.at ?? ""})`
    : base;
}

/**
 * The chat message a run's wake names, when a person wrote to the agent.
 *
 * The inverse of the one spelling `wokeOf` gives a wake: `chat created: <path>`
 * and nothing else is a message a person wrote in the group's conversation. It
 * lives here, beside the writer, so the two cannot drift apart.
 */
export function chatWoken(woke: string | null | undefined): string | null {
  const [head, ...rest] = (woke ?? "").split(": ");
  if (head !== "chat created" || !rest.length) return null;
  return rest.join(": ");
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
 * The one rule a mention opens.
 *
 * The decision turn's own routing is honoured where it named a rule that watches
 * the conversation; otherwise the first of the chat-watching rules answers.
 * Either way it is **one** rule: every other rule the decision named for this
 * change stays unrun, because a second run would answer the same sentence again.
 */
function mentionRoute(
  named: readonly string[],
  candidates: readonly { id: string }[],
): string[] {
  const watchers = candidates.map((rule) => rule.id);
  const first = named.find((id) => watchers.includes(id)) ?? watchers[0];
  return first ? [first] : [];
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
 * What a person is told when their mention of the agent reaches no rule at all.
 *
 * A group with no rule watching the conversation is a group whose agent is not
 * asked to speak there; the person still addressed it, and silence is not an
 * answer to a question somebody typed.
 */
const NO_RULE_NOTICE =
  "This group has no rule for the conversation, so your message has woken nothing. An administrator can write one in Administration → Agent → Rules.";

/**
 * What a person is told when their mention reached the agent and it found
 * nothing to do.
 *
 * Distinct from the notice above because it says something else: the rules are
 * there and the agent read the words, and it chose no act. A person who asked
 * for something is owed that answer rather than the silence of a decision that
 * was never made.
 */
const NOTHING_TO_DO_NOTICE =
  "The agent read your message and found nothing in it to act on. Say what you need it to do, and it will take that as the work.";

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
  /** What a notice could not be delivered for: said by the pass, not swallowed. */
  problems: string[] = [],
): Promise<void> {
  const read = await readChangesForPass(deps.ctx, deps.cursors, accountId);
  // A gap in the log is mentions this pass did not see: said, not assumed empty.
  if (read.gap) problems.push(read.gap);
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
         * the conversation reads (`addressesAgent`).
         */
        if (!addressesAgent(message, deps.self)) continue;
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
        /*
         * shortcut: the notice answers any sender who writes to the agent
         * alone, known or not — one message per mail, never a thread. A roster
         * check waits until the owner decides whether the agent's own mailbox
         * is a public front or a members' one.
         */
        await sendMail(deps.ctx, accountId, {
          to: message.from,
          subject: OFF_NOTICE,
          text: OFF_NOTICE,
        });
      }
    } catch (err) {
      // The cursor moves past this change either way, so the notice is gone:
      // the pass says so rather than letting a person believe they were told.
      problems.push(`${event.source} ${event.where}: ${errorMessage(err)}`);
    }
  }
  deps.cursors.set(accountId, read.cursor);
}

/** The decision turn's tokens, on the run it opened or continued. */
function withUsage(
  run: RunDoc,
  meter: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
  },
): RunDoc {
  if (!meter.calls && !meter.promptTokens && !meter.completionTokens) return run;
  return spendRun(run, {
    calls: meter.calls,
    promptTokens: meter.promptTokens,
    completionTokens: meter.completionTokens,
    cachedPromptTokens: meter.cachedTokens,
  });
}

/** The questions a group already has open, as the parked runs that wait on them. */
function openQuestionsOf(
  records: readonly RunRecord[],
  /** The run being worked: its own question is not an "already open" one. */
  except?: string,
): string[] {
  return records
    .filter(
      ({ run }) =>
        run.id !== except &&
        run.state === "blocked" &&
        typeof run.waiting?.what === "string" &&
        Boolean(run.waiting.what.trim()),
    )
    .map(
      ({ run }) => `${run.waiting?.asked?.channel ?? "chat"}: ${run.waiting?.what ?? ""}`,
    )
    .slice(0, 8);
}

/** One run, put where the batch's list holds it: replaced, or added at the end. */
function remember(records: RunRecord[], run: RunDoc): void {
  const at = records.findIndex((record) => record.run.id === run.id);
  if (at >= 0) records[at] = { run, state: records[at]?.state ?? "" };
  else records.push({ run, state: "" });
}

export async function workChanges(
  deps: ChangesDeps,
  accountId: string,
  now: Date,
  summary: PassSummary,
  records?: readonly RunRecord[],
  preRead?: AccountEvents,
): Promise<RunRecord[] | null> {
  const read = preRead ?? (await readChangesForPass(deps.ctx, deps.cursors, accountId));
  if (read.gap) summary.gaps.push(read.gap);
  /**
   * The runs the account already holds: the list the pass read, or asked for
   * once when a caller has none. It is updated as the batch works, so the next
   * event sees the document this one left.
   */
  let held: RunRecord[] | null = records ? [...records] : null;
  /*
   * The agent's own calendar events are not activity to answer: a calendar
   * change is handed over like any other, and a rule woken by the agent's own
   * write would open a run whose write wakes it again. Its mail never reaches
   * this list — an event is an arrival in the Inbox, which its own sends and
   * drafts never are — and its own documents are left out by the reading.
   *
   * The drops whose burst is over are changes of this pass too: one event per
   * folder, carrying the files that landed there while it was open (`queue.ts`).
   */
  /*
   * The queue is the agent's own bookkeeping: a document it cannot read costs
   * the drops it names, never the group's mail. The failure is the pass's gap,
   * and the files are still in the folder for a person to see.
   */
  let due: Drop[] = [];
  try {
    due = await deps.dueDrops(accountId, now);
  } catch (err) {
    summary.gaps.push(`${accountId}: ${errorMessage(err)}`);
  }
  const events = [
    ...due.map(dropEvent),
    ...read.events.filter(
      (event) =>
        // The agent's own calendar events are not activity to answer: a rule
        // that wakes on them opens a run whose write wakes it again.
        !(event.source === "calendar" && takeOwnCalendarChange(event.where)),
    ),
  ];
  if (!events.length) {
    // A quiet account pays no rule listing: there is nothing to apply them to.
    deps.cursors.set(accountId, read.cursor);
    return held;
  }
  const rules = (await listRules(deps.ctx, accountId)).map((record) => record.rule);
  for (const event of events) {
    summary.changes += 1;
    /*
     * A document landing in a folder is one file of a drop, not a change to
     * answer on its own: it is queued against its folder and reported once the
     * burst is over (ADR 0034). The reading already tells a folder from a
     * document, so only documents reach here. A removal is not queued; it takes
     * its path out of a drop still waiting, so the report cannot name a file
     * that is no longer in the folder.
     */
    if (event.source === "files" && event.change !== "destroyed" && !event.also) {
      await deps.noteDrop(accountId, event.where, now);
      continue;
    }
    if (event.source === "files" && event.change === "destroyed")
      await deps.forgetDropPath(accountId, event.where);
    /*
     * A chat message is read once here, so the decision turn has its words
     * without spending a model call and a round trip on `chat.read`.
     */
    const message =
      event.source === "chat" && event.change !== "destroyed"
        ? await readChatMessageAt(deps.ctx, accountId, event.where)
        : null;
    /*
     * A mail the change names is read here for the same reason: the turn that
     * decides it is then told the sender's words instead of spending a lookup —
     * a whole model call — on a read this process makes in one request. A
     * message that cannot be read answers null and the turn looks it up as
     * before.
     */
    const mail =
      event.source === "mail" && event.change !== "destroyed"
        ? await readMessageForAnswer(deps.ctx, accountId, event.where, {
            own: deps.ctx.username,
            known: [],
          }).catch(() => null)
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
     * run of its own (ADR 0029). The correlation is the record's — a reply to
     * the question in chat, a mail in its thread — so it is asked before any
     * rule and on **whatever surface the answer arrived on**: a question asked
     * in chat by a rule that watches mail is answered in chat, and the answer
     * is not a change that rule watches.
     */
    const couldAnswer =
      (event.source === "chat" && message?.replyTo !== undefined) ||
      (event.source === "mail" && event.change !== "destroyed");
    if (couldAnswer) {
      if (!held) {
        /*
         * The working listing says a document it cannot read and hands the
         * readable runs beside it: one corrupt run must not leave the group's
         * change page, or a person's answer, unanswered (runs.ts).
         */
        const listed = await listRunsForWorking(deps.ctx, accountId);
        for (const problem of listed.problems)
          summary.gaps.push(`${accountId}: ${problem}`);
        held = listed.records;
      }
      const answer = await deps.runAnsweredBy(accountId, event, held);
      if (answer === "already") continue;
      if (answer && "record" in answer) {
        // The person answered and the answer was refused: it is written on the
        // run it would have continued, and the run stays blocked.
        await deps.recordRefusal(accountId, answer);
        continue;
      }
      if (answer) {
        summary.due += 1;
        const worked = await deps.workRun(
          accountId,
          await deps.authoriseAnswer(answer),
          // The answer's own words are what the next call recalls facts by,
          // as the decision turn's facts were for a change it opened.
          { answer: answer.said },
          openQuestionsOf(held ?? [], answer.run.id),
        );
        held ??= [];
        if (worked) remember(held, worked);
        continue;
      }
    }
    const candidates = rules.filter((rule) => ruleApplies(rule, event));
    /*
     * A change no rule watches costs no model call and no step (ADR 0031) — but a
     * person addressing the agent in the conversation is not such a change. The
     * address is the mention, so a message that names the agent is answered even
     * when the group's rules say nothing about the conversation: silence was the
     * live ending (a mention produced no run and no word, and nothing said why),
     * and a person who typed a question is owed an answer or a reason.
     */
    if (!candidates.length) {
      if (
        event.source === "chat" &&
        message &&
        addressesAgent(message, deps.ctx.username)
      )
        await postChatMessage(deps.ctx, accountId, deps.ctx.username, NO_RULE_NOTICE, {
          ...(message.id ? { replyTo: message.id } : {}),
        });
      continue;
    }
    const woke = wokeOf(event);
    /*
     * What the installation holds and the group wrote above the rule: the
     * installation's own line and the group's standing instruction reach the
     * decision turn too, because which rules apply is asked of the same agent
     * (ADR 0031).
     */
    const detail = message
      ? {
          from: message.from,
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        }
      : mail?.text
        ? { from: mail.from ?? "", text: mail.text }
        : null;
    const meter = usageMeter();
    /*
     * A drop of one file can be read once here: the decision turn then answers
     * about the document it was woken by instead of spending a lookup call
     * asking for what the process already has. A larger drop is left to the
     * turn, which reads the one or two files it needs rather than paying a
     * transcription for every file of the pack.
     */
    const document =
      event.source === "files" && event.also?.length === 1
        ? await deps.readEventFile(accountId, event.also[0] as string)
        : null;
    const decision = await decideEvent(
      deps.access,
      {
        event,
        rules,
        prose: await deps.proseAbove(accountId),
        memory: recallFacts((await deps.memory()).facts, woke, accountId),
        ...(detail ? { detail } : {}),
        ...(document ? { document } : {}),
      },
      deps.readingCall(accountId, event, candidates),
      // A file event carries its document above, so the turn needs few lookups
      // at most; the other surfaces keep the full allowance.
      { meter, ...(event.source === "files" ? { maxReads: 2 } : {}) },
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
    /*
     * A mention is an address, and an address is answered once (ADR 0031). The
     * decision turn names **which** rule answers it, never how many runs it opens
     * — a group with two chat rules answering one sentence twice is the same
     * defect as answering it never — so a mention narrows to one rule whichever
     * way the decision went. Its facts — empty when it named nothing — are what
     * the run is told.
     */
    const mentioned = message !== null && addressesAgent(message, deps.ctx.username);
    if (decision.kind !== "decision") {
      /*
       * A mention whose change never became a decision is still somebody asking
       * something: the same notice a group with no chat rule gets, because the
       * alternative is a question nobody answered and nobody told why.
       */
      if (mentioned && message)
        await postChatMessage(
          deps.ctx,
          accountId,
          deps.ctx.username,
          NOTHING_TO_DO_NOTICE,
          {
            ...(message.id ? { replyTo: message.id } : {}),
          },
        );
      continue;
    }
    const chosen = mentioned ? mentionRoute(decision.rules, candidates) : decision.rules;
    /*
     * The runs by (rule, change) for this event, grown once and rebuilt only
     * after a named rule changes a run's state: a decision naming three rules
     * used to rebuild the whole map three times.
     */
    let byStart: Map<string, RunDoc> | null = null;
    for (const named of chosen) {
      const rule = rules.find((candidate) => candidate.id === named);
      if (!rule) continue;
      const key = startKey(named, woke);
      // A run of the account that already names this rule and this change is
      // that change being worked, or the answer it already has: never a second
      // run over it.
      if (!held) {
        /*
         * The working listing says a document it cannot read and hands the
         * readable runs beside it: one corrupt run must not leave the group's
         * change page, or a person's answer, unanswered (runs.ts).
         */
        const listed = await listRunsForWorking(deps.ctx, accountId);
        for (const problem of listed.problems)
          summary.gaps.push(`${accountId}: ${problem}`);
        held = listed.records;
      }
      byStart ??= runsByStart(held);
      const open = byStart.get(key);
      if (open) {
        if (open.state === "running") {
          const worked = await deps.workRun(
            accountId,
            withUsage(open, meter),
            decision.facts,
            openQuestionsOf(held ?? [], open.id),
          );
          if (worked) {
            remember(held, worked);
            byStart = null;
          }
        }
        continue;
      }
      const run = await deps.openRun(accountId, event, rule, message?.from ?? null);
      summary.runs += 1;
      const worked = await deps.workRun(
        accountId,
        withUsage(run, meter),
        decision.facts,
        openQuestionsOf(held ?? [], run.id),
      );
      remember(held, worked ?? run);
      byStart = null;
    }
  }
  /*
   * The drops answered here leave the queue once the batch is worked. A crash
   * before this line leaves them, and the run's own key — the folder and the
   * instant the drop opened — makes the next attempt the same run, not a second
   * one.
   */
  for (const drop of due) await deps.forgetDrop(accountId, drop.folder);
  // The cursor moves only once the batch is answered: a read that failed
  // half-way is read again rather than lost as silence.
  deps.cursors.set(accountId, read.cursor);
  return held;
}
