/**
 * One task of the eval, as the repository holds it (ADR 0038).
 *
 * A task is a **document**: the message that arrives, the data it arrives into,
 * and the outcome a person would accept — written before the measure, so a zero
 * is the agent's failure and never the task's. It is one file under `tasks/`,
 * and the runner reads it as data: nothing here knows how a run is worked.
 *
 * `grade` may award part of the work, because a task with more than one side is
 * not one question with a yes or a no. The runner takes a task at its word only
 * when the **first** attempt scores whole: a task that passes on the retry is
 * `unstable`, not passed.
 */

import type { AreaName } from "../../shared/areas.js";
import type { ChatMessage } from "../../shared/chat.js";

/** What one run did, as every task is graded against it. */
export interface RunMeasure {
  /** The ending the run reached, or `no-run` when the pass opened none. */
  ending: string | null;
  steps: number;
  calls: number;
  /** Steps that ended refused — the argument misuse the eval exists to catch. */
  refused: number;
  /** What the run last said, when its ending carried words. */
  said: string | null;
  /** Tokens the run spent, prompt and completion together. */
  tokens: number;
  /**
   * The part of the prompt the provider served from its own cache, when it says.
   * The ADR's caching question — is the stable prefix cached? — is answered by
   * this number over `tokens`, never by an assumption.
   */
  cachedTokens: number;
  /** Milliseconds the run spent in model calls and tools. */
  ms: number;
}

/**
 * The account as a task sees it: the doors other tests use, and no JMAP call of
 * a task's own.
 *
 * A task writes the state its message arrives into and reads back what the agent
 * did, through the same modules the product uses. What it never does is open a
 * run, read a document the agent keeps or ask the model anything: those are the
 * measure's, and a task that could reach them would be grading itself.
 */
export interface Harness {
  /** The session's own address: what the agent writes in the conversation as. */
  agent: string;
  /** Write the group's instruction: its prose, and the areas it works. */
  instruct(prose: string, areas: AreaName[]): Promise<void>;
  /** Put a mail in the group's inbox, with the words it carries. */
  deliver(subject: string, body?: string): Promise<string>;
  /** Post a message in the group's conversation, from a person. */
  post(from: string, text: string): Promise<string>;
  /** The conversation's newest messages, newest first. */
  chat(limit?: number): Promise<ChatMessage[]>;
  /** The drafts the account holds. */
  drafts(): Promise<Array<{ subject: string; inReplyTo: string[] }>>;
  /** The subjects of the messages one mail folder holds, by the folder's name. */
  subjectsIn(folder: string): Promise<string[]>;
  /** One document of the account's Files, as text, or null when it is not there. */
  fileText(path: string): Promise<string | null>;
  /** The account's calendar events. */
  events(): Promise<Array<{ title: string }>>;
  /** Turn the installation's agent off, as an administrator can. */
  switchOff(): Promise<void>;
}

/** One task: what arrives, where it arrives, and what a person would accept. */
export interface EvalTask {
  /** The name the measure prints. */
  name: string;
  /** The message that arrives, in a person's own words. */
  message: string;
  /** The account state it arrives into: the instruction, the folders, the data. */
  data: string;
  /** The outcome a person would accept, written before the measure. */
  reference: string;
  /** Whether a run and a model call are expected; a quiet task measures silence. */
  live: boolean;
  /**
   * Put the account in the state the message arrives into — the instruction, the
   * switch, the folders — **before** the agent's first pass, as a boot meets an
   * account that already holds them.
   */
  prepare?(h: Harness): Promise<void>;
  /**
   * The message arrives, **after** the pass that anchored the account: a change
   * created before the reading starts is not a change the agent was woken by.
   */
  arrive?(h: Harness): Promise<void>;
  /** How much of the reference the run met: 1 is all of it, 0 none. */
  grade(h: Harness, got: RunMeasure): Promise<number>;
}
