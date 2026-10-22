/**
 * A mention while the agent is switched off is answered with no model call
 * (ADR 0038).
 *
 * Off is not silence: the person who wrote is told the agent is off, once, in
 * the conversation they wrote in — and no run opens, so no provider is paid for
 * a question nobody's agent will answer.
 */
import type { EvalTask } from "../task.js";

export const switchedOffNotice: EvalTask = {
  name: "a mention while the agent is switched off is answered, without a run",
  message: "@demo are you up?",
  data: "an installation whose agent an administrator has switched off",
  reference: "one notice from the agent in the conversation, no run, no model call",
  live: false,
  prepare: async (h) => {
    await h.instruct("Answer what people ask in the conversation.", ["chat", "mail"]);
    await h.switchOff();
  },
  arrive: async (h) => {
    await h.post("sam@example.org", "@demo are you up?");
  },
  grade: async (h, got) => {
    if (got.ending !== "no-run") return 0;
    const chat = await h.chat(5);
    return chat.filter((message) => message.from === h.agent).length === 1 ? 1 : 0;
  },
};
