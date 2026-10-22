/**
 * A mail is filed into the folder the instruction names (ADR 0038).
 *
 * The job `place` files a message by the folder's id, which the run has to find
 * first (`find folders`) or make (`place mailFolder`): two steps, and the second
 * only possible after the first. It is the shape a dependency takes now — a
 * second answer, not a plan field.
 */
import type { EvalTask } from "../task.js";

export const filedIntoAFolder: EvalTask = {
  name: "a shipper's mail is filed into the folder the instruction names",
  message: "a booking confirmation",
  data: "a group instructed to file every shipper's mail into Archive, making that folder when it is missing",
  reference: "the message is in a folder named Archive, from a run that ends done",
  live: true,
  prepare: async (h) => {
    await h.instruct(
      "File every shipper's mail into the Archive folder. If it does not exist, make it.",
      ["mail"],
    );
  },
  arrive: async (h) => {
    await h.deliver("a booking confirmation", "the booking reference is BK-42");
  },
  grade: async (h, got) => {
    const subjects = await h.subjectsIn("Archive");
    const filed = subjects.some((subject) => subject.includes("booking confirmation"));
    const ended = got.ending === "done" && got.refused === 0;
    if (filed && ended) return 1;
    return filed || ended ? 0.5 : 0;
  },
};
