/**
 * A mention in a group with an instruction is answered in the conversation
 * (ADR 0038).
 *
 * The other half of the quiet mention: a group that has written an instruction
 * has an agent, and a mention opens a run that says what it found. What is
 * measured is the words in the conversation, not the run's shape.
 */
import type { EvalTask } from "../task.js";

export const mentionAnswered: EvalTask = {
  name: "a mention in a group with an instruction is answered in the conversation",
  message: "@demo are you working today?",
  data: "a group instructed to answer what people ask in the conversation",
  reference:
    "a message from the agent in the conversation; the decision turn may answer a mention itself, with no run",
  live: true,
  prepare: async (h) => {
    await h.instruct("Answer what people ask in the conversation.", ["chat", "mail"]);
  },
  arrive: async (h) => {
    await h.post("sam@example.org", "@demo are you working today?");
  },
  grade: async (h, got) => {
    const chat = await h.chat(10);
    if (chat.some((message) => message.from === h.agent)) return 1;
    return got.ending === "done" ? 0.5 : 0;
  },
};
