/**
 * A group's standing instruction, as a document (ADR 0035).
 *
 * One document per group account: `instruction.json` at the root of that
 * account's `gilbert` app folder, beside the label catalog — the two documents a
 * group owns whole. It says one thing, in prose: how the group wants its agent to
 * work. It is the **middle** of the three levels the model is told, above the
 * rule's own instruction and below the installation's own line, and unlike a rule
 * nothing wakes it: it stands for every call the group's account makes.
 *
 * The shape and its parser are here; where the document is addressed and how it
 * is read are here too, because a document read from a path is one thing. Nothing
 * on this tier writes it: a group's prose is the group's own, written with the
 * group's session where its chat is written, and that surface is not built.
 *
 * A stored instruction is a contract: every field below is written by one build
 * and read by the next, and a field that moves moves with every reader and
 * writer of it.
 */

import { type Ctx, readAppFileAt } from "../appFolder.js";
import { CodedError, errorDetail, errorMessage } from "../shared/errors.js";
import { isRecord } from "../shared/json.js";

/** Where a group's standing instruction lives: the one path constant. */
export const INSTRUCTION_FILE = "instruction.json";

/**
 * The schema this build writes and reads. A document of another version is
 * refused, so a field of the shape below moves this with it — the version is
 * how a change reaches an instruction a group has already written.
 */
export const INSTRUCTION_VERSION = 1;

/** One group's standing instruction, as it is stored. */
export interface InstructionDoc {
  /** The schema version; `INSTRUCTION_VERSION` today. */
  v: 1;
  /** In prose, how the group wants its agent to work. */
  instruction: string;
}

/**
 * Parse one stored instruction.
 *
 * Strict JSON, an object at the top, then the two fields checked: a `v` this
 * build does not know is refused rather than read as though it meant the same,
 * and an instruction that is not text or says nothing is refused rather than
 * carried into a call as a heading over nothing. A key this build does not know
 * is ignored, so a field a later build added decides nothing here.
 */
export function parseInstructionDocumentDetailed(
  raw: string,
): { instruction: InstructionDoc } | { problem: string } {
  let whole: unknown;
  try {
    whole = JSON.parse(raw);
  } catch (err) {
    return { problem: `Not valid JSON${errorDetail(err)}.` };
  }
  if (!isRecord(whole)) return { problem: "The document must be a JSON object." };
  if (whole.v !== INSTRUCTION_VERSION)
    return {
      problem: `"v" is ${JSON.stringify(whole.v)}; this build reads version ${INSTRUCTION_VERSION}.`,
    };
  if (typeof whole.instruction !== "string" || !whole.instruction.trim())
    return { problem: '"instruction" must say how the group wants its agent to work.' };
  return {
    instruction: { v: INSTRUCTION_VERSION, instruction: whole.instruction },
  };
}

/**
 * An instruction this build cannot use.
 *
 * One that is there but unreadable is a **defect the agent reports**, never a
 * level it silently drops (ADR 0035): the pass fails with this and the next one
 * tries again, which is how the people it belongs to learn that their instruction
 * stopped being carried. The code is what a surface composes its own sentence
 * from.
 */
export class InstructionError extends CodedError {
  constructor(code: string, message: string, status = 502) {
    super(code, message, status, "InstructionError");
  }
}

/** The group's standing instruction, or null when it has written none. */
export async function readInstruction(
  ctx: Ctx,
  accountId: string,
): Promise<string | null> {
  let found: Awaited<ReturnType<typeof readAppFileAt>>;
  try {
    found = await readAppFileAt(ctx, accountId, INSTRUCTION_FILE);
  } catch (err) {
    // A document that is there with bytes that do not come back is unreadable,
    // not absent: reading it as absent would carry a call with no group level.
    throw unreadable(errorMessage(err));
  }
  if (!found) return null;
  const parsed = parseInstructionDocumentDetailed(found.text);
  if ("problem" in parsed) throw unreadable(parsed.problem);
  return parsed.instruction.instruction;
}

function unreadable(why: string): InstructionError {
  return new InstructionError(
    "instruction_unreadable",
    `The group's instruction at ${INSTRUCTION_FILE} is not readable: ${why} It has been left exactly as it is.`,
  );
}
