/**
 * The reference a case is known by lives in another message of the thread.
 *
 * The live run of 2026-10-26 read one message twelve times while the fact it
 * needed — the booking reference — sat in the thread beside it. What a person
 * would accept: the reply reports the reference, which means the run went and
 * found the message that carries it instead of re-reading its own.
 */
import type { EvalTask } from "../task.js";

export const threadReference: EvalTask = {
  name: "a reference that lives in the thread is found, not re-read",
  message: "a reply that answers a booking mail without repeating its reference",
  data: "a group holding the first message of a booking thread, whose reference BK-901 appears only there, instructed to report the reference in the conversation",
  reference: "the run reports BK-901 in the conversation and ends done",
  live: true,
  prepare: async (h) => {
    await h.instruct(
      "When a message answers a booking thread, say in the conversation which " +
        "booking it belongs to. The reference is the one the thread carries, not a " +
        "guess: look for it if the message does not repeat it.",
      ["mail", "chat"],
    );
    /*
     * The first message is in the account before the agent's reading starts, the
     * way a real thread is: it is data, not a change of this task.
     */
    await h.deliver(
      "BK-902 1x20 CNT TCLU1122334 — booking confirmed",
      "the booking is confirmed",
    );
  },
  arrive: async (h) => {
    await h.deliver(
      "R: BK-902 — the papers you asked for",
      "the papers are attached to this answer",
    );
  },
  grade: async (h, got) => {
    const said = got.said ?? "";
    const found = said.includes("BK-902");
    const ended = got.ending === "done";
    if (found && ended) return 1;
    return found ? 0.5 : 0;
  },
};
