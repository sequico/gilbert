/**
 * A mention in a group with no instruction is answered, with no run (ADR 0038).
 *
 * A group that has written no instruction has no agent, and a person who writes
 * to it is told so once. Silence would be indistinguishable from an agent that
 * is down, which is the failure the notice exists to prevent.
 */
import type { EvalTask } from "../task.js";

export const mentionWithoutInstruction: EvalTask = {
  name: "a mention in a group with no instruction is answered, without a run",
  message: "@demo are you up?",
  data: "a group that has written no instruction",
  reference: "one message from the agent in the conversation, no run, no model call",
  live: false,
  arrive: async (h) => {
    await h.post("sam@example.org", "@demo are you up?");
  },
  grade: async (h, got) => {
    if (got.ending !== "no-run") return 0;
    const chat = await h.chat(5);
    return chat.filter((message) => message.from === h.agent).length === 1 ? 1 : 0;
  },
};
