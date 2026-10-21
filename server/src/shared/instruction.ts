/**
 * A group's standing instruction, as a document (ADR 0038).
 *
 * One document per group account: `instruction.json` at the root of that
 * account's `gilbert` app folder, beside the label catalog — the two documents a
 * group owns whole. It says two things: in prose, how the group wants its agent to
 * work, and in the list, **which areas** that work is in.
 *
 * The shape, its parser and the address live here because both tiers name them:
 * the server reads the document and selects a run's catalogue from its areas, and
 * a member's client writes it with the group's own session.
 */

import { type AreaName, declaredAreas } from "./areas.js";
import { errorDetail } from "./errors.js";
import { isRecord } from "./json.js";
import { isSurfaceMatrix, type SurfaceMatrix } from "./surfaces.js";

/** Where a group's standing instruction lives: the one path constant. */
export const INSTRUCTION_FILE = "instruction.json";

/**
 * The schema this build writes and reads. A document of another version is
 * refused, so a field of the shape below moves this with it — the version is
 * how a change reaches an instruction a group has already written.
 *
 * Version 1 carried the prose alone; it is still read, and upgraded in memory,
 * because an installation wrote one before the areas existed.
 */
export const INSTRUCTION_VERSION = 2;

/** One group's standing instruction, as it is stored. */
export interface InstructionDoc {
  /** The schema version; `INSTRUCTION_VERSION` today. */
  v: 2;
  /** In prose, how the group wants its agent to work. */
  instruction: string;
  /** The areas the group works, and the whole of what a run may change. */
  areas: AreaName[];
  /** Where a run may act, one mode per surface of the group's own account. */
  surfaces: SurfaceMatrix;
  /** Whether the group's agent may send outward without a person's yes. */
  sends: boolean;
}

/**
 * The matrix of an instruction that names none: the conversation, and nothing
 * else. A group that writes an instruction and declares no area has told the
 * agent about the chat and about nothing more, and the matrix says exactly that
 * rather than handing it every surface the account has.
 */
const CHAT_ONLY: SurfaceMatrix = {
  chat: "watch",
  mail: "off",
  files: "off",
  knowledge: "off",
  workorder: "off",
  calendar: "off",
};

/**
 * The matrix of an instruction that names none: the conversation, and nothing
 * else. A group that writes an instruction and declares no area has told the
 * agent about the chat and about nothing more, and the matrix says exactly that
 * rather than handing it every surface the account has.
 */

/**
 * Parse one stored instruction.
 *
 * Strict JSON, an object at the top, then the fields checked: a `v` this build
 * does not know is refused rather than read as though it meant the same, an
 * instruction that is not text or says nothing is refused rather than carried
 * into a call as a heading over nothing, and an area nobody has is refused with
 * the names there are. A key this build does not know is ignored, so a field a
 * later build added decides nothing here.
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
  /* A document written before the areas existed says the prose alone: it is the
     instruction it was, with no area declared, and nothing is invented for it. */
  if (whole.v === 1) {
    if (typeof whole.instruction !== "string" || !whole.instruction.trim())
      return { problem: '"instruction" must say how the group wants its agent to work.' };
    return {
      instruction: {
        v: INSTRUCTION_VERSION,
        instruction: whole.instruction,
        areas: [],
        surfaces: { ...CHAT_ONLY },
        sends: false,
      },
    };
  }
  if (whole.v !== INSTRUCTION_VERSION)
    return {
      problem: `"v" is ${JSON.stringify(whole.v)}; this build reads version ${INSTRUCTION_VERSION}.`,
    };
  if (typeof whole.instruction !== "string" || !whole.instruction.trim())
    return { problem: '"instruction" must say how the group wants its agent to work.' };
  if (!Array.isArray(whole.areas) || whole.areas.some((one) => typeof one !== "string"))
    return { problem: '"areas" must be a list of area names.' };
  const areas = declaredAreas(whole.areas as string[]);
  if (areas.problem) return { problem: areas.problem };
  if (whole.surfaces !== undefined && !isSurfaceMatrix(whole.surfaces))
    return {
      problem: '"surfaces" must be one mode per surface of the group\'s account.',
    };
  if (whole.sends !== undefined && typeof whole.sends !== "boolean")
    return { problem: '"sends" must be true or false.' };
  return {
    instruction: {
      v: INSTRUCTION_VERSION,
      instruction: whole.instruction,
      areas: [...areas.areas],
      surfaces: whole.surfaces ?? { ...CHAT_ONLY },
      sends: whole.sends ?? false,
    },
  };
}
