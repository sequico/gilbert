/**
 * A group's standing instruction, as a document (ADR 0031).
 *
 * One document per group account: `instruction.json` at the root of that
 * account's `gilbert` app folder, beside the label catalog — the two documents a
 * group owns whole. It says one thing, in prose: how the group wants its agent to
 * work. It is the **middle** of the three levels the model is told, above the
 * rule's own instruction and below the installation's own line.
 *
 * The shape, its parser and the address live here because both tiers name them:
 * the server reads the document, and a member's client writes it with the group's
 * own session. What reads it is `agent/instruction.ts`.
 */

import { errorDetail } from "./errors.js";
import { isRecord } from "./json.js";

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
