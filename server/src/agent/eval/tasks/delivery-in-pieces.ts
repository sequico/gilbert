/**
 * A delivery arrives as one mail per item, and the group reads one report for it.
 *
 * The shape the live installation met on 2026-10-26: seven messages of one
 * consignment, each its own change, each worked as a run of its own that
 * rediscovered the same case, the same place and the same rule — seven
 * investigations and seven reports for one delivery. Here it is three, and the
 * instruction asks for one report, because that is a group's own rule and not the
 * harness's guess.
 *
 * What a person would accept: every item filed in the folder the booking names,
 * the folder made when it is missing, and the work done — one report, not three.
 */
import type { EvalTask } from "../task.js";

export const deliveryInPieces: EvalTask = {
  name: "a delivery in pieces is filed once and reported once",
  message: "three messages of one consignment, each marked 1 of 3, 2 of 3, 3 of 3",
  data: "a group instructed to file each message of a consignment into a folder named after its reference, making the folder when it is missing, and to report the delivery once",
  reference: "all three messages sit in the folder BK-901, and the run ended done",
  live: true,
  prepare: async (h) => {
    await h.instruct(
      "File every message of a consignment into the folder named after its booking " +
        "reference, making that folder when it does not exist. Report a delivery once, " +
        "not once per message.",
      ["mail", "files"],
    );
  },
  arrive: async (h) => {
    await h.deliver(
      "BK-901 2x40 CNT MSKU1234567 (1 of 3)",
      "the first container's papers",
    );
    await h.deliver(
      "BK-901 2x40 CNT MSKU7654321 (2 of 3)",
      "the second container's papers",
    );
    await h.deliver(
      "BK-901 2x40 CNT TGHU9988776 (3 of 3)",
      "the third container's papers",
    );
  },
  grade: async (h, got) => {
    const filed = await h.subjectsIn("BK-901");
    const placed = ["(1 of 3)", "(2 of 3)", "(3 of 3)"].filter((mark) =>
      filed.some((subject) => subject.includes(mark)),
    ).length;
    const ended = got.ending === "done";
    if (placed === 3 && ended) return 1;
    return (placed / 3) * 0.75 + (ended ? 0.25 : 0);
  },
};
