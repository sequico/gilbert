/**
 * The reference a mail names reaches the conversation (ADR 0038).
 *
 * A read whose answer a person needs: the run is not graded on ending, but on
 * whether the words it said carry what the message said. A run that reported
 * without the reference did not answer the question that was asked.
 */
import type { EvalTask } from "../task.js";

export const referenceInTheReply: EvalTask = {
  name: "the reference a mail names reaches the conversation",
  message: "a booking confirmation naming the booking reference",
  data: "a group instructed to tell the group the booking reference a shipper's mail names",
  reference: "a message from the agent carrying BK-77, from a run that ends done",
  live: true,
  prepare: async (h) => {
    await h.instruct(
      "Read what a shipper sends, and tell the group the booking reference it names in the conversation.",
      ["mail", "chat"],
    );
  },
  arrive: async (h) => {
    await h.deliver("a booking confirmation", "The booking reference is BK-77.");
  },
  grade: async (h, got) => {
    const chat = await h.chat(10);
    const said = chat.filter((message) => message.from === h.agent);
    if (said.some((message) => message.text.includes("BK-77"))) return 1;
    return said.length > 0 || got.ending === "done" ? 0.5 : 0;
  },
};
