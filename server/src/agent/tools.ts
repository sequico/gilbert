/**
 * The agent's tools, read from the group's own account (ADR 0027).
 *
 * A tool is a **task over one object Stalwart offers**, not a step of the
 * protocol: one that finds messages by the mail client's own search grammar,
 * one that reads a message, a KB page, a workorder, a node or a run, and one
 * that lists a mailbox's folders or a folder of Files. Two tools that do one
 * thing are a defect — they make the choice a lottery — and a tool that answers
 * with more context than the caller needs is one too.
 *
 * **What defines a tool** is six things beside its executor: its **name**, its
 * **description** (the product's interface to the model, written as prose a
 * person's agent should reach for), its **arguments** (validated before the
 * executor runs, never inside it), the **authority class it exercises** (ADR
 * 0028), the **act** that class is about when the class asks a person, and what
 * it **spends** of the run's budget (ADR 0027) — which the loop applies with
 * `spendRun`, and which for a read is nothing.
 *
 * **The reading half cannot change anything.** Reading before acting is what
 * makes these the tools a run opens with, and every one of them declares
 * `writes: false`: the catalogue's write-free half is what a reading caller gets
 * (`readingTools`), so a tool that writes is unreachable through it. A tool
 * whose act leaves the run waiting answers with the wait it left, and the loop
 * applies it with `waitUntil` — the run document is the loop's to write, exactly
 * as the tally is.
 *
 * Every tool acts in the account its run lives in — the group's own (ADR 0031)
 * — and reads it through the same doors the surfaces use, so the agent sees the
 * same documents a person does. The one that does not is `memory.remember`,
 * which records a fact into the **installation's** own store in the Master's
 * account rather than into any group's (ADR 0038): the memory is one for the
 * whole installation, which is what makes what one group learned worth knowing
 * in the next.
 *
 * What a tool is, and the arguments it reads, are defined once beside this file
 * under `tools/`, and each surface defines its own there: mail, chat, files,
 * workorders, knowledge, calendars, runs and the installation's memory. This module is the
 * catalogue's entry point: it composes `TOOLS` in the order the model reads, and
 * holds the two doors a call is made through. It re-exports the names callers
 * already import rather than a second spelling of any of them.
 */

import { errorMessage } from "../shared/errors.js";
import {
  type AnyTool,
  type ArgSpec,
  argSchema,
  defineTool,
  type ImageReader,
  mayRun,
  surfaceModeOf,
  type ToolCall,
  ToolError,
} from "./tools/define.js";
import { JOBS } from "./tools/jobs.js";
import { isGroupAddress, readMessageForAnswer } from "./tools/mail.js";

export type { AnyTool, ArgSpec, ImageReader, ToolCall };
export { argSchema, defineTool, isGroupAddress, mayRun, readMessageForAnswer };

/**
 * Every job this build has (ADR 0038).
 *
 * Eight tools, each a value its call names: reading and finding are free, and
 * the four area writes are narrowed by the run's instruction (`areas.ts`). What
 * a call may take is `mayRun`'s answer over the run that asks, read from the
 * endpoint the value names — never the list's order or a caller's assumption
 * about which half a tool is in.
 */
export const TOOLS: readonly AnyTool[] = JOBS;

/**
 * The half of a catalogue that cannot change anything: the tools that write
 * nothing.
 *
 * This is the whole of what makes a writing tool unreachable while reading: the
 * caller is handed the write-free half, so a tool that writes is not in it to
 * find. A caller with the whole catalogue asks for the half it may use.
 */
export function readingTools(catalogue: readonly AnyTool[]): readonly AnyTool[] {
  return catalogue.filter((tool) => !tool.writes);
}

/** The reading half of this build's catalogue. */
export const READING_TOOLS = readingTools(TOOLS);

/**
 * Find a tool in a catalogue and validate the arguments it is given.
 *
 * One definition of the two, so the door a call is run through (`runTool`) and a
 * caller that only asks whether a call is well formed before running anything
 * (`chooseStep`, `model.ts`) cannot disagree on which tool a name finds or what
 * its arguments are. A name the catalogue does not hold, or arguments its tool
 * refuses, is thrown as a `ToolError`.
 */
export function validatedTool(
  catalogue: readonly AnyTool[],
  name: string,
  raw: unknown,
): { tool: AnyTool; args: unknown } {
  const tool = catalogue.find((one) => one.name === name);
  if (!tool) throw new ToolError("unknown_tool", `There is no tool named "${name}".`);
  return { tool, args: tool.parse(raw) };
}

/**
 * Call one tool: find it, validate its arguments, ask the guard, and run it.
 *
 * The catalogue is the caller's — the reading half for a reading call — and
 * nothing here looks beyond it, so what a caller cannot see it cannot reach.
 * The arguments are validated **before** the executor runs, and a tool whose
 * class the run carries no authority for is refused rather than run.
 */
export async function runTool(
  catalogue: readonly AnyTool[],
  call: ToolCall,
  name: string,
  raw: unknown,
  opts: { failSoft?: boolean } = {},
): Promise<unknown> {
  const { tool, args } = validatedTool(catalogue, name, raw);
  /*
   * A write on a surface the run's rule keeps off is refused before the class
   * is asked: the rule says *where* this run may act (ADR 0031), the class says
   * whether the act needs a person's word (ADR 0028). Reading is free — a
   * reading is proof, not an act. The surface is the call's own, because one
   * job reaches two of them (ADR 0038).
   */
  const surface = tool.surfaceOf(args);
  if (tool.writes && surface && surfaceModeOf(call.run, surface) === "off")
    throw new ToolError(
      "surface_off",
      `"${tool.name}" writes ${surface}, and this run's rule keeps ${surface} off.`,
      403,
    );
  if (!mayRun(tool, call.run, args))
    throw new ToolError(
      "needs_authority",
      `"${tool.name}" is not the agent's to decide, and this run carries no authority for it.`,
      403,
    );
  try {
    return await tool.run(call, args);
  } catch (err) {
    /*
     * A read that fails is the reader's to hear: the decision turn asks for a
     * `failSoft` read so a reserved folder or a missing message becomes the
     * next turn's problem instead of ending the whole decision.
     */
    if (opts.failSoft) return { problem: errorMessage(err) };
    throw err;
  }
}
