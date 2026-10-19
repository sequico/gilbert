/**
 * The arguments a tool's `parse` reads, and the refusals it answers with.
 *
 * Every tool takes named fields, validated before the executor runs; a field
 * that is not what the tool can use is a `ToolError` in the model's own words.
 * The readers live here so a surface module reads its arguments the way its
 * neighbours do.
 */

import { isRecord } from "../../shared/json.js";
import { ToolError } from "./define.js";

/** The arguments as one record, or a refusal: every tool takes named fields. */
export function argsRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw))
    throw new ToolError("bad_arguments", "A tool's arguments are an object.");
  return raw;
}

/** One required text field. */
export function textArg(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim())
    throw new ToolError("bad_arguments", `"${key}" must be text.`);
  return value.trim();
}

/** One optional text field. */
export function optionalTextArg(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new ToolError("bad_arguments", `"${key}" must be text.`);
  return value.trim() || undefined;
}

/**
 * The most entries one listing tool answers with.
 *
 * A listing that returned everything made the step's outcome a document that
 * the prompt then clipped, and a clipped list reads as the whole of the folder:
 * the model concludes the tail does not exist. The cap is stated in the answer
 * (`total`, `truncated`) so nothing is silently missing, and the model can ask
 * for a smaller page or a narrower folder.
 */
export const TOOL_LIST_MAX = 200;

/** One optional count, bounded so a model cannot ask the server for a flood. */
export function countArg(
  raw: Record<string, unknown>,
  key: string,
  max: number,
): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new ToolError(
      "bad_arguments",
      `"${key}" must be a whole number of at least 1.`,
    );
  return Math.min(value, max);
}

/** A missing object, in the model's own words: not a failure to report as one. */
export function notFound(what: string): ToolError {
  return new ToolError("not_found", `There is no ${what}.`, 404);
}
