/**
 * One message, five facts, and a report that must carry all of them.
 *
 * The shape behind the twelve reads: a body holding a list the report must carry
 * whole. A turn that loses the body re-reads the message; a turn that keeps it
 * reports once. What a person would accept: every item in the report, and the run
 * done in a handful of model calls rather than a budget's worth.
 */
import type { EvalTask } from "../task.js";

const ITEMS = ["MRKU7862150", "MRSU0039101", "TGHU9988776", "MSKU7654321", "TCLU1122334"];

export const listInOneMessage: EvalTask = {
  name: "a list in one message is reported whole, read once",
  message: "one message listing five container numbers",
  data: "a group instructed to put every container number of the message in the conversation, in one report",
  reference:
    "the report carries all five numbers, and the run ends done in at most six model calls",
  live: true,
  prepare: async (h) => {
    await h.instruct(
      "When a message lists containers, put every one of them in the conversation in " +
        "one report. Do not report a message twice and do not read the same page again.",
      ["mail", "chat"],
    );
  },
  arrive: async (h) => {
    await h.deliver(
      "BK-903 5x40 CNT — the equipment list",
      `the consignment carries five containers:\n${ITEMS.map((one, at) => `${at + 1}. ${one}`).join("\n")}`,
    );
  },
  grade: async (_h, got) => {
    const said = got.said ?? "";
    const carried = ITEMS.filter((one) => said.includes(one)).length;
    const ended = got.ending === "done";
    const cheap = got.calls <= 6;
    if (carried === ITEMS.length && ended && cheap) return 1;
    /*
     * The report is the work: a share missing is squared, because a list with an
     * item missing is not four fifths of a list — it is the list that would send
     * somebody looking for the fifth container.
     */
    const share = (carried / ITEMS.length) ** 2;
    return share * 0.8 + (ended ? 0.1 : 0) + (cheap ? 0.1 : 0);
  },
};
