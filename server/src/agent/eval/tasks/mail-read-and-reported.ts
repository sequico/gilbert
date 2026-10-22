/**
 * A mail in the mail area is read and answered (ADR 0038).
 *
 * The common path the rewrite exists for: the change names a message, the
 * instruction says what the group does with it, and the run reports in the
 * conversation. What is measured is that it ends, and that no step of it was
 * refused for its arguments.
 */
import type { EvalTask } from "../task.js";

export const mailReadAndReported: EvalTask = {
  name: "a mail in the mail area is read and answered",
  message: "a booking confirmation carrying the booking reference BK-42",
  data: "a group instructed to read what the shippers send and report in the conversation what a message is missing, working mail and files",
  reference:
    "a run that ends done with no refused step; the calls it spent are printed beside it",
  live: true,
  prepare: async (h) => {
    await h.instruct(
      "Read what the shippers send, and report in the conversation what a message is missing.",
      ["mail", "files"],
    );
  },
  arrive: async (h) => {
    await h.deliver("a booking confirmation", "the booking reference is BK-42");
  },
  grade: async (_h, got) => (got.ending === "done" && got.refused === 0 ? 1 : 0),
};
