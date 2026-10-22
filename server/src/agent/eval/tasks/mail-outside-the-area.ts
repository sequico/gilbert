/**
 * A mail in an area the instruction does not declare opens no run (ADR 0038).
 *
 * The instruction names the areas a group works, and a change outside them is
 * not the agent's work. A run opened for it would spend a model call finding
 * nothing to do.
 */
import type { EvalTask } from "../task.js";

export const mailOutsideTheArea: EvalTask = {
  name: "a mail in an area the instruction does not declare opens no run",
  message: "a booking confirmation",
  data: "a group instructed to keep its calendar in order, working the calendar area only",
  reference: "no run",
  live: false,
  prepare: async (h) => {
    await h.instruct("Keep the calendar in order.", ["calendar"]);
  },
  arrive: async (h) => {
    await h.deliver("a booking confirmation", "the booking reference is BK-42");
  },
  grade: async (_h, got) => (got.ending === "no-run" ? 1 : 0),
};
