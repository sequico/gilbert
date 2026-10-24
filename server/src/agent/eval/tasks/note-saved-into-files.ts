/**
 * What a shipper sent is kept as a note in Files (ADR 0038).
 *
 * The write that leaves an object behind for the next run: the instruction names
 * the path, so what is measured is the document there and what it says — a
 * summary that lost the reference is not the note that was asked for.
 */
import type { EvalTask } from "../task.js";

export const noteSavedIntoFiles: EvalTask = {
  name: "what a shipper sent is saved as a note in Files",
  message: "a booking confirmation",
  data: "a group instructed to keep each booking as notes/<reference>.txt in Files, with the reference in it",
  reference: "a file notes/BK-42.txt holding BK-42, from a run that ends done",
  live: true,
  prepare: async (h) => {
    await h.instruct(
      "Keep each booking confirmation as a note at notes/<reference>.txt in Files, with the reference and the collection date in it.",
      ["mail", "files"],
    );
  },
  arrive: async (h) => {
    await h.deliver(
      "a booking confirmation",
      "The booking reference is BK-42. Collection is on 3 November 2026 at 09:00.",
    );
  },
  grade: async (h, got) => {
    const text = await h.fileText("notes/BK-42.txt");
    const kept = text?.includes("BK-42") === true;
    const ended = got.ending === "done";
    if (kept && ended) return 1;
    return kept || ended ? 0.5 : 0;
  },
};
