/**
 * The agent's tools, read from the group's own account (ADR 0038).
 *
 * A tool is one of **four verbs** over the endpoints Stalwart offers (ADR 0038):
 * `open` reads what the account holds, `act` changes it, `say` speaks in the
 * group's conversation, `note` keeps the case's scratchpad. Each value a verb
 * accepts names its endpoint (`tools/jobs.ts`), so the catalogue the model reads
 * is four lines rather than one per endpoint. Two tools that do one thing are a
 * defect — they make the choice a lottery — and a tool that answers with more
 * context than the caller needs is one too.
 *
 * **What defines a tool** is its **name**, its **description** (the product's
 * interface to the model, written as prose a person's agent should reach for),
 * its **routes** — one per value of its discriminator, each naming the endpoint,
 * the **authority class** it exercises (ADR 0028), the **act** that class is
 * about when it asks a person, and what it **spends** of the run's tally (ADR
 * 0038), which the loop applies with `spendRun` and which for a read is nothing
 * — and the **argument schemas** validated before the executor runs, never
 * inside it.
 *
 * **The reading half cannot change anything.** Reading before acting is what
 * makes these the tools a run opens with, and every one of them declares
 * `writes: false`: the catalogue's write-free half is what a reading caller gets
 * (`readingTools`), so a tool that writes is unreachable through it. A tool
 * whose act leaves the run waiting answers with the wait it left, and the loop
 * applies it with `waitUntil` — the run document is the loop's to write, exactly
 * as the tally is.
 *
 * Every tool acts in the account its run lives in — the group's own (ADR 0038)
 * — and reads it through the same doors the surfaces use, so the agent sees the
 * same documents a person does. The one that does not is `memory.remember`,
 * which records a fact into the **installation's** own store in the Master's
 * account rather than into any group's (ADR 0038): the memory is one for the
 * whole installation, which is what makes what one group learned worth knowing
 * in the next.
 *
 * The four verbs are defined once, in `tools/jobs.ts`, and each value routes to
 * the endpoint's own executor under `tools/` — mail, chat, files, workorders,
 * knowledge, calendars, contacts, runs and the installation's memory — so the
 * validation, the authority and the answer stay the endpoint's. This module is
 * the catalogue's entry point: it composes `TOOLS`, and holds the two doors a
 * call is made through. It re-exports the names callers already import rather
 * than a second spelling of any of them.
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

export type { AnyTool, ArgSpec, ImageReader, ToolCall };
export { argSchema, defineTool, mayRun };

/**
 * Every verb this build has (ADR 0038).
 *
 * Four of them — `open`, `act`, `say`, `note` — each naming the value its call
 * means: reading is free, so `open` is offered whole, and `act`'s values are narrowed
 * by the run's instruction (`areas.ts`). What a call may take is `mayRun`'s answer
 * over the run that asks, read from the endpoint the value names — never the list's
 * order or a caller's assumption about which half a tool is in.
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
  if (!tool) {
    /*
     * A name the catalogue does not hold is named back where one name is the tail of
     * the other — `read.open` for `open`, `open` for `read.open` — because a refusal
     * that only says "there is no tool named …" leaves the model nothing to correct
     * with. The call is still refused, so nothing runs on a guess.
     */
    const names = catalogue.map((one) => one.name);
    const near = names.filter(
      (one) => one.endsWith(`.${name}`) || name.endsWith(`.${one}`),
    );
    throw new ToolError(
      "unknown_tool",
      near.length
        ? `There is no tool named "${name}". The tool is ${near.map((one) => `"${one}"`).join(" or ")}: a name is used as it is written, prefix included.`
        : `There is no tool named "${name}". The tools are: ${names.join(", ")}.`,
    );
  }
  return { tool, args: tool.parse(raw) };
}

/**
 * Whether a failed call of this catalogue may be made again.
 *
 * Only a reversible act may: its failure is the account's answer, and asking
 * again asks the same question. A destructive or outward act that failed may
 * have landed — a submission that timed out is the case this exists for — and a
 * person's authority covers one act, so it is not repeated silently.
 *
 * The class is the **endpoint's**, read through the verb's own `authorityOf`:
 * the four verbs are one tool each, so a verb's declared class is its default
 * and says nothing about the value a call names. `act` files a message and
 * trashes one; only the second is an act a retry may take twice. A call this
 * build cannot read is not one to repeat.
 */
export function repeatable(
  catalogue: readonly AnyTool[],
  name: string,
  args: unknown,
): boolean {
  try {
    const { tool, args: parsed } = validatedTool(catalogue, name, args);
    return tool.authorityOf(parsed) === "reversible";
  } catch {
    return false;
  }
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
  let resolved: { tool: AnyTool; args: unknown };
  try {
    resolved = validatedTool(catalogue, name, raw);
  } catch (err) {
    /*
     * A name the catalogue does not hold is the reader's to hear too, when it asked
     * `failSoft`: the model wrote `read.open` for `open`, and the refusal ended the
     * whole decision turn — so the pass died **before a run was opened**, and a
     * person's message was never worked and never even said to be waiting (live,
     * 2026-10-27). The refusal now travels back into the turn, naming the tool.
     */
    if (opts.failSoft) return { problem: errorMessage(err) };
    throw err;
  }
  const { tool, args } = resolved;
  /*
   * A write on a surface the run's matrix keeps off is refused before the class
   * is asked: the matrix says *where* this run may act (ADR 0038), the class says
   * whether the act needs a person's word (ADR 0028). Reading is free — a
   * reading is proof, not an act. The surface is the call's own, because one
   * verb reaches more than one of them (ADR 0038).
   */
  const surface = tool.surfaceOf(args);
  if (tool.writes && surface && surfaceModeOf(call.run, surface) === "off")
    throw new ToolError(
      "surface_off",
      `"${tool.name}" writes ${surface}, and this run's areas keep ${surface} off.`,
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
