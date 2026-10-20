/**
 * A group's standing instruction: where it is read from (ADR 0031).
 *
 * The shape, its parser and the document's address are the **shared** tree's
 * (`shared/instruction.ts`), because both tiers name them — the server reads the
 * document here, and a member's client writes it with the group's own session.
 * What lives on this tier is the read: the app folder, the bytes and the refusal.
 */

import { type Ctx, readAppFileAt } from "../appFolder.js";
import { CodedError, errorMessage } from "../shared/errors.js";
import {
  INSTRUCTION_FILE,
  parseInstructionDocumentDetailed,
} from "../shared/instruction.js";

export {
  INSTRUCTION_FILE,
  INSTRUCTION_VERSION,
  type InstructionDoc,
  parseInstructionDocumentDetailed,
} from "../shared/instruction.js";

/**
 * An instruction this build cannot use.
 *
 * One that is there but unreadable is a **defect the agent reports**, never a
 * level it silently drops (ADR 0031): the pass fails with this and the next one
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
