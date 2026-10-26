/**
 * The reader: a question about a case too big for a turn, answered in lines (R2).
 *
 * A thread of twenty messages, or a folder of thirty documents, is not handed into a
 * working turn and is not read by it either: it asks a question, a **reader** — the
 * decision turn's own shape, `decideEvent` asked a question instead of shown a change —
 * reads what it needs with the same write-free catalogue and answers in a few lines.
 * The investigation stays in its own context and the working turn keeps the answer.
 *
 * It reads and answers, and never acts: no two decision-makers touch one shipment.
 */

import { decideEvent, runningModelAccess } from "../model.js";
import { argsRecord, optionalTextArg, textArg } from "./args.js";
import { defineTool, ToolError } from "./define.js";

/** The most of a question, and of what the reader is told the question is about. */
export const READER_QUESTION_MAX = 400;

export const readBrief = defineTool<{
  question: string;
  about?: string;
}>({
  name: "read.brief",
  description:
    "Ask one question about this group's own account and get a few lines back: what a " +
    "thread says, which documents a folder holds and what is missing from them, what a " +
    "long conversation decided. The reader reads what it needs itself — you do not open " +
    "the objects first — and it never acts.",
  authority: "reversible",
  writes: false,
  /*
   * Reading is free of *steps*, not of what it costs: the call the reader makes
   * is metered on the run and on the day through the call's own meter (ADR 0038),
   * so nothing is declared here and nothing is counted twice.
   */
  spend: {},
  args: { question: { type: "text" }, about: { type: "text" } },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const about = optionalTextArg(args, "about");
    return { question: textArg(args, "question"), ...(about ? { about } : {}) };
  },
  run: async (call, { question, about }) => {
    const access = runningModelAccess();
    if (!access)
      throw new ToolError(
        "no_model",
        "This installation has no model to read with, so nothing can be asked about the account.",
        409,
      );
    const answer = await decideEvent(
      access,
      {
        ask: {
          question:
            question.length > READER_QUESTION_MAX
              ? `${question.slice(0, READER_QUESTION_MAX)}…`
              : question,
          ...(about ? { about } : {}),
        },
        prose: {},
      },
      call,
      // One lookup: a reader that has not found its answer in one look is asking the
      // wrong question, and the working turn is told so rather than left waiting.
      // The call is metered on the run and the day: a reader is a model call.
      { maxReads: 1, ...(call.meter ? { meter: call.meter } : {}) },
    );
    if (answer.kind !== "lines")
      throw new ToolError(
        "model_answer_malformed",
        "The reader answered something that is not lines.",
        502,
      );
    return { lines: answer.lines };
  },
});
