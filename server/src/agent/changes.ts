/**
 * One account's changes, and the runs they open or continue.
 *
 * Split from the loop it serves: this walks the account's change batch, asks the
 * decision turn what the change is about, continues the run this change already
 * has and opens one when it has none. A group has **one** instruction, so a
 * covered change is one run and there is no routing to do (ADR 0038). It reads
 * the pass's cursor and the installation's prose and memory through
 * `ChangesDeps`, so nothing here holds the loop's claim or its alarms.
 */

import type { Ctx } from "../appFolder.js";
import { postChatMessage, readChatMessageAt, readChatMessageBy } from "../groupChat.js";
import { areaOfSource } from "../shared/areas.js";
import { CAPABILITIES } from "../shared/capabilities.js";
import { addressedToAgent, addressesAgent } from "../shared/chat.js";
import { errorMessage } from "../shared/errors.js";
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
import type { InstructionDoc } from "./instruction.js";
import type { AnsweredRun, PassSummary } from "./loop.js";
import type { MemoryStore } from "./memory.js";
import { recallFor } from "./memory.js";
import type { ModelAccess } from "./model.js";
import { decideEvent, usageMeter } from "./model.js";
import type { ProseLevel } from "./prose.js";
import { type Drop, dropEvent } from "./queue.js";
import { listRunsForWorking, type RunRecord } from "./runs.js";
import { takeOwnCalendarChange } from "./tools/calendar.js";
import type { ToolCall } from "./tools/define.js";
import { readMessageForPass, sendNotice } from "./tools/mail.js";

/** What the changes of one account need from the loop that asked for them. */
export interface ChangesDeps {
  ctx: Ctx;
  cursors: Map<string, EventCursor>;
  access: ModelAccess;
  proseAbove(accountId: string): Promise<Partial<Record<ProseLevel, string>>>;
  /** The group's one instruction, which says whether a change is its work. */
  instructionOf(accountId: string): Promise<InstructionDoc | null>;
  memory(): Promise<MemoryStore>;
  readingCall(accountId: string, event: AccountEvent): ToolCall;
  runAnsweredBy(
    accountId: string,
    event: AccountEvent,
    records: readonly RunRecord[],
  ): Promise<AnsweredRun | "already" | null>;
  workRun(
    accountId: string,
    run: RunDoc,
    facts?: Record<string, string>,
    /** The questions the group already has open, so this run does not re-ask. */
    openQuestions?: readonly string[],
    /** The words the change carried, so the first turn is handed the message. */
    written?: { from?: string; text: string; quoted?: string },
  ): Promise<RunDoc | null>;
  authoriseAnswer(answer: AnsweredRun): Promise<RunDoc>;
  /** Hold a file event until its folder's burst is over (`queue.ts`). */
  noteDrop(accountId: string, path: string, now: Date): Promise<void>;
  /** The drops whose burst is over, one event each. */
  dueDrops(accountId: string, now: Date): Promise<Drop[]>;
  /** Drop the paths an answered drop named from the queue, once its batch was worked. */
  forgetDrop(
    accountId: string,
    folder: string,
    answered: readonly string[],
  ): Promise<void>;
  /** Take a destroyed file out of a drop still waiting. */
  forgetDropPath(accountId: string, path: string): Promise<void>;
  /** Read the one document a file change names, for the decision turn. */
  readEventFile(
    accountId: string,
    path: string,
  ): Promise<{ path: string; text: string } | null>;
  /**
   * A model call this pass made answered: the provider's run of failures ends
   * (ADR 0038). Called after the decision turn returns, so a provider that
   * refuses only the run's turns is not excused by it.
   */
  modelAnswered(): void;
  openRun(
    accountId: string,
    event: AccountEvent,
    instruction: InstructionDoc,
    /** The sender the waking message named, or null when the change names none. */
    from: string | null,
    /** What the change said, in its own words, as this pass read it. */
    about?: string,
    /** Who set it off, when the change names a person. */
    by?: string,
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
 * or anchored where it stands now. The pass makes this reading before it lists
 * the runs, so the FileNode state it ends at is the state the run listing is
 * judged against.
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
 * The object a wake of one kind names, or null when it is not a wake of that kind.
 *
 * One reader of the one spelling `wokeOf` writes, so a parser and the writer cannot
 * drift apart: `"<source> <change>: <where>"`, and `where` is what this answers.
 */
function wokeTarget(woke: string | null | undefined, head: string): string | null {
  const [kind, ...rest] = (woke ?? "").split(": ");
  const where = rest.join(": ").trim();
  return kind === head && where ? where : null;
}

/**
 * The chat message a run's wake names, when a person wrote to the agent.
 *
 * `chat created: <path>` and nothing else is a message a person wrote in the group's
 * conversation.
 */
export function chatWoken(woke: string | null | undefined): string | null {
  return wokeTarget(woke, "chat created");
}

/**
 * The mail message a run's wake names, when a message woke it.
 *
 * `mail created: <id>` is the only shape a mail wake has, and the message it names is
 * what a thread is read from. A wake whose target carries a parenthesised tail is a
 * batched drop rather than one message, and answers null.
 */
export function mailWoken(woke: string | null | undefined): string | null {
  const id = wokeTarget(woke, "mail created");
  return id && !id.includes("(") ? id : null;
}

/**
 * The account's runs by the change that woke them: one entry per change.
 *
 * A run woken by a person's own sentence names no change, and is not an answer to
 * one — nothing here. Two runs of one change cannot be written by this build, and
 * the one a pass can continue is the one still running, so that is the one kept
 * when a hand-written pair of documents says otherwise.
 *
 * shortcut: a change is named by its surface, its kind and its address, which is
 * all the change log hands over — so a document created again at a path a run
 * already answered is read as the change that was answered, not as a new one.
 * Upgrade when an event can name the state it happened at, or the object's own
 * version, which is what tells a recurrence from a replay.
 */
function runsByStart(records: readonly RunRecord[]): Map<string, RunDoc> {
  const byStart = new Map<string, RunDoc>();
  for (const { run } of records) {
    const { woke } = run.startedBy;
    if (!woke) continue;
    const key = woke;
    const held = byStart.get(key);
    if (!held || (held.state !== "running" && run.state === "running"))
      byStart.set(key, run);
  }
  return byStart;
}
/** What an agent that is turned off says, in chat and by mail. */
const OFF_NOTICE = "AI agents are turned off.";

/**
 * What a person is told when their words reached the agent and no instruction
 * names the surface they arrived on.
 *
 * One sentence for every surface. A group whose instruction says nothing about
 * the conversation is a group whose agent is not asked to speak there, and the
 * same holds for mail — the live defect was that only the conversation got the
 * sentence, so a message to a group that named no mail was read and dropped
 * without a word.
 */
function noInstructionNotice(
  surface: "chat" | "mail",
  about: { from?: string | null; subject?: string | null } = {},
): string {
  const where = surface === "mail" ? "mail" : "the conversation";
  const from = about.from ? ` from ${about.from}` : "";
  const subject = about.subject ? ` (“${about.subject}”)` : "";
  return `This group's instruction does not wake on ${where}, so the message${from}${subject} has woken nothing. An administrator can change it in Administration → AI Agents → Instruction.`;
}

/**
 * Whether the instruction wakes on this change: its wake row watches the
 * surface.
 *
 * The instruction is the whole of the routing (ADR 0038): a surface the group
 * did not tick in its wake row wakes nothing, and the notice above says so
 * rather than leaving the change unanswered in silence. The areas decide what a
 * run may change, not what wakes it; `ondemand` and `off` do not wake, and the
 * editor writes `watch` or `off` (a stored `ondemand` survives until its box is
 * touched). `activity` is the installation's own bookkeeping and wakes nothing.
 */
function coversChange(instruction: InstructionDoc, event: AccountEvent): boolean {
  if (areaOfSource(event.source) === null) return false;
  return instruction.surfaces[event.source] === "watch";
}

/**
 * A pass with the agent off: nothing is decided, nothing is modelled, and the
 * one thing that happens is an answer to the people who wrote.
 *
 * The owner chose this on 2026-10-19 (option 2): the off notice answers chat
 * and mail directly, without the class-3 licence an instruction must otherwise
 * carry for outward mail. The guards are the ones that keep it from becoming a
 * loop: a message from the agent itself is never answered, and the cursor
 * advances once per batch, so each message is answered once.
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
        /*
         * A chat message is for the agent unless it names somebody else (owner
         * decision 2026-10-22): no mention, or a mention of the agent, gets the
         * notice; a message that names another person is theirs.
         */
        if (!addressedToAgent(message, deps.self)) continue;
        await postChatMessage(deps.ctx, accountId, deps.self, OFF_NOTICE, {
          replyTo: message.id,
        });
      } else if (event.source === "mail") {
        const message = await readMessageForPass(deps.ctx, accountId, event.where);
        if (!message.from || message.from === deps.self) continue;
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
        await sendNotice(deps.ctx, accountId, {
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
function openQuestionLines(
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
   * The account's runs by the change they answer, built once per pass and rebuilt
   * only when a run this pass writes moves the list: rebuilding it per change was
   * a scan of every run of the account for every change of the batch.
   */
  let byStart: Map<string, RunDoc> | null = null;
  /*
   * The agent's own calendar events are not activity to answer: a calendar
   * change is handed over like any other, and the instruction woken by the
   * agent's own write would open a run whose write wakes it again. Its mail
   * never reaches this list — an event is an arrival in the Inbox, which its own
   * sends and drafts never are — and its own documents are left out by the
   * reading.
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
        // The agent's own calendar events are not activity to answer: the
        // instruction woken by them would open a run whose write wakes it again.
        !(event.source === "calendar" && takeOwnCalendarChange(event.where)),
    ),
  ];
  if (!events.length) {
    // A quiet account pays no document read: there is nothing to apply it to.
    deps.cursors.set(accountId, read.cursor);
    return held;
  }
  const instruction = await deps.instructionOf(accountId);
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
     * A quote reply means "about that": the message a person answers is part of
     * the change, not a lookup the turn has to spend. It is read where the
     * turn's own detail is built — after a reply that answers a run has already
     * continued it and gone, so that path pays one read and not two.
     */
    /*
     * A mail the change names is read here for the same reason: the turn that
     * decides it is then told the sender's words instead of spending a lookup —
     * a whole model call — on a read this process makes in one request. A
     * message that cannot be read answers null and the turn looks it up as
     * before.
     */
    const mail =
      event.source === "mail" && event.change !== "destroyed"
        ? await readMessageForPass(deps.ctx, accountId, event.where).catch(() => null)
        : null;
    /*
     * The agent's own words are not activity to answer: its own status message
     * would otherwise wake the instruction and pay a model call to read itself,
     * each reply opening the next round.
     */
    if (message && message.from.toLowerCase() === deps.ctx.username.toLowerCase())
      continue;
    /*
     * A message that answers a run's question continues that run and opens no
     * run of its own (ADR 0029). The correlation is the record's — a reply to
     * the question in chat — so it is asked before anything else. A mail answers
     * nothing: an outward message is a draft a person sends (ADR 0038).
     */
    const couldAnswer = event.source === "chat" && message?.replyTo !== undefined;
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
      if (answer) {
        summary.due += 1;
        const worked = await deps.workRun(
          accountId,
          await deps.authoriseAnswer(answer),
          // The answer's own words are what the next call recalls facts by,
          // as the decision turn's facts were for a change it opened.
          { answer: answer.said },
          openQuestionLines(held ?? [], answer.run.id),
        );
        held ??= [];
        if (worked) remember(held, worked);
        continue;
      }
    }
    /*
     * A chat message is for the agent unless it names somebody else (owner
     * decision 2026-10-22): no mention, or a mention of the agent, is its work;
     * a message that names another person is theirs, and one that names both is
     * still the agent's. This is after the answer block: an answer to a
     * question needs no mention to continue the run it replies to.
     */
    if (
      event.source === "chat" &&
      message &&
      !addressedToAgent(message, deps.ctx.username)
    )
      continue;
    if (!instruction || !coversChange(instruction, event)) {
      /*
       * A change the group's instruction does not name costs no model call and no
       * step (ADR 0038) — but a person addressing the agent is owed an answer or a
       * reason. A chat message that reaches this point is the agent's (a message
       * naming somebody else was skipped above), and mail that names the agent is
       * answered the same way: silence was the live ending, and a live
       * installation read and dropped thirteen mail messages in a group whose
       * agent had nothing for mail. The notice goes to the group's conversation —
       * an administrator reads it there — and says what arrived and that no
       * instruction names the surface.
       */
      if (event.source === "chat" && message)
        await postChatMessage(
          deps.ctx,
          accountId,
          deps.ctx.username,
          noInstructionNotice("chat"),
          {
            ...(message.id ? { replyTo: message.id } : {}),
          },
        );
      else if (
        event.source === "mail" &&
        mail &&
        addressesAgent({ text: mail.text }, deps.ctx.username)
      )
        await postChatMessage(
          deps.ctx,
          accountId,
          deps.ctx.username,
          noInstructionNotice("mail", { from: mail.from, subject: mail.subject }),
        );
      continue;
    }
    const woke = wokeOf(event);
    /*
     * A change the account already answers costs no decision call: the run's key
     * is the change, and the record is the answer. This is what makes the
     * cursor's rule affordable — it advances only past what the pass worked
     * (ADR 0038), so a pass that stopped mid-batch re-reads the batch, and every
     * change it already answered is skipped here instead of being decided again.
     */
    const key = woke;
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
      byStart = null;
    }
    byStart ??= runsByStart(held);
    const open = byStart.get(key);
    if (open) {
      /*
       * The change is answered. A run still running is the **due work's** — the
       * pass works every running run with no wait before it reads the changes —
       * so continuing it here as well would work the same document twice on one
       * pass. Nothing to do for this change.
       */
      continue;
    }
    /*
     * What the change said and who set it off, captured now: the record is the
     * arbiter of what happened, so a message edited next week does not rewrite
     * why this run exists. Everything here comes from what the pass already read
     * — except a calendar event's title, which the change log names by id alone.
     */
    const said = await aboutOf(deps.ctx, accountId, event, message, mail);
    /*
     * The installation's own line and the group's standing instruction reach the
     * decision turn: the turn reads the change against both (ADR 0038).
     */
    /*
     * The sentence a quote reply is about. Read once, here: the path that
     * answers a run has already continued it and left, so this read is paid only
     * by the change that may answer in words — the one that answered "I do not
     * have the content of the message you refer to" without it.
     */
    const quoted = message?.replyTo
      ? await readChatMessageBy(deps.ctx, accountId, message.replyTo)
      : null;
    const detail = message
      ? {
          from: message.from,
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(quoted?.text ? { quoted: quoted.text } : {}),
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
        prose: await deps.proseAbove(accountId),
        memory: (await recallFor(deps.access, await deps.memory(), woke)).facts,
        ...(detail ? { detail } : {}),
        ...(document ? { document } : {}),
      },
      deps.readingCall(accountId, event),
      // One lookup, as ADR 0038 says: a file event already carries its document
      // above, and every surface shares the same ceiling.
      { meter },
    );
    // The day's counter is the pass's own, and a decision call is spent on it
    // (ADR 0038): a change the agent looked at costs tokens even when no run
    // opens.
    summary.tokens += meter.promptTokens + meter.completionTokens;
    deps.modelAnswered();
    if (decision.kind === "reply") {
      /*
       * The fast path: a chat message that only wants words is answered by the
       * call that decided it, instead of opening a run and a step to say the
       * same. **On any other surface the words are not a reply**: a mail has no
       * conversation to answer in, and refusing them left the change unworked
       * for ever (measured 2026-10-22), so it opens with no facts and the run
       * reads the change itself.
       */
      if (event.source === "chat") {
        await postChatMessage(
          deps.ctx,
          accountId,
          deps.ctx.username,
          decision.text,
          message?.id ? { replyTo: message.id } : {},
        );
        continue;
      }
    }
    /** What the decision found, or nothing when it only had words. */
    // A change is decided in facts; a reply carries none, and only a reader answers
    // lines — which a change never is (R2).
    const facts = decision.kind === "decision" ? decision.facts : {};
    /*
     * A group has **one** instruction, so a change it covers is one run: there is
     * no second to choose between and no routing to do (ADR 0038). The run this
     * change answers is opened here; one the account already held was continued
     * above, before the decision turn was paid for.
     */
    const run = await deps.openRun(
      accountId,
      event,
      instruction,
      message?.from ?? null,
      said.about,
      said.by,
    );
    summary.runs += 1;
    const worked = await deps.workRun(
      accountId,
      withUsage(run, meter),
      facts,
      openQuestionLines(held ?? [], run.id),
      // The words the change carried: the decision turn already read them, and the
      // working turn is handed the same message rather than fetching it (ADR 0038).
      detail
        ? {
            ...(detail.from ? { from: detail.from } : {}),
            text: detail.text,
            ...(detail.quoted ? { quoted: detail.quoted } : {}),
          }
        : undefined,
    );
    remember(held, worked ?? run);
    byStart = null;
  }
  /*
   * The drops answered here leave the queue once the batch is worked, and only
   * the paths they named: a file that landed in the same folder after the drop
   * was taken is a drop of its own. A crash before this line leaves them, and the
   * run's own key — the folder and the instant the drop opened — makes the next
   * attempt the same run, not a second one.
   */
  for (const drop of due) await deps.forgetDrop(accountId, drop.folder, drop.paths);
  // The cursor moves only once the batch is answered: a read that failed
  // half-way is read again rather than lost as silence.
  deps.cursors.set(accountId, read.cursor);
  return held;
}

/** The longest opening line a run carries: a row has one line, not a document. */
const ABOUT_MAX = 240;

/**
 * What woke a run, and who set it off — in the words the change carried.
 *
 * `woke` names the change (`chat created: <path>`, `mail created: <id>`); this is
 * what lies behind the name: the sentence a person typed, the subject of the mail
 * that arrived, the files a drop brought, the title of the event a calendar
 * change renamed. It is written on the run **once**, when it opens, from what the
 * pass already read — so a message edited later does not rewrite the reason the
 * run exists.
 *
 * `by` is the person the event names. A FileNode or a calendar change states no
 * actor in the change log, so those carry none: the field says who, and never
 * guesses at a name the event did not give.
 */
async function aboutOf(
  ctx: Ctx,
  accountId: string,
  event: AccountEvent,
  message: { text?: string; from?: string | null } | null,
  mail: { subject?: string | null; from?: string | null } | null,
): Promise<{ about?: string; by?: string }> {
  if (message?.text) {
    const about = clipAbout(message.text);
    return {
      ...(about ? { about } : {}),
      ...(message.from ? { by: message.from } : {}),
    };
  }
  if (event.source === "mail" && mail) {
    const about = clipAbout(mail.subject ?? "");
    return {
      ...(about ? { about } : {}),
      ...(mail.from ? { by: mail.from } : {}),
    };
  }
  if (event.source === "files") {
    const about = clipAbout([event.where, ...(event.also ?? [])].join(", "));
    return about ? { about } : {};
  }
  if (event.source === "calendar" && event.change !== "destroyed") {
    /*
     * The one read this asks for that the pass did not make: a change log names
     * the event by id, and "calendar updated: <id>" says nothing to a reader. A
     * read that fails leaves the line absent, and the surface falls back to the
     * change's own words.
     */
    const found = await clientOf(ctx)
      .call<{ list?: Array<Record<string, unknown>> }>(
        "CalendarEvent/get",
        { accountId, ids: [event.where] },
        [CAPABILITIES.calendars],
      )
      .catch(() => null);
    const title = found?.list?.[0]?.title;
    const about = typeof title === "string" ? clipAbout(title) : undefined;
    if (about) return { about };
  }
  return {};
}

/** One line: whitespace collapsed, bounded, and nothing when there is nothing. */
function clipAbout(text: string): string | undefined {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > ABOUT_MAX ? `${line.slice(0, ABOUT_MAX - 1)}…` : line;
}
