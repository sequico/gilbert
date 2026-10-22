/**
 * A delivery named in a mail is put on the group's calendar (ADR 0038).
 *
 * Two areas meeting by identifier, which is how a run spans them: the mail names
 * the reference and the date, and the calendar holds the event. What is measured
 * is the event carrying the reference, not the run's route to it.
 */
import type { EvalTask } from "../task.js";

export const deliveryOnTheCalendar: EvalTask = {
  name: "a delivery named in a mail is put on the group's calendar",
  message: "a booking confirmation naming the collection date",
  data: "a group instructed to put deliveries on its calendar when a booking names a date, working mail and calendar",
  reference: "a calendar event whose title carries BK-42, from a run that ends done",
  live: true,
  prepare: async (h) => {
    await h.instruct(
      "When a booking names a collection, put it on the group's calendar with the booking reference in the title.",
      ["mail", "calendar"],
    );
  },
  arrive: async (h) => {
    await h.deliver(
      "a booking confirmation",
      "The booking reference is BK-42. Collection is on 3 November 2026 at 09:00.",
    );
  },
  grade: async (h, got) => {
    const events = await h.events();
    const made = events.some((event) => event.title.includes("BK-42"));
    const ended = got.ending === "done" && got.refused === 0;
    if (made && ended) return 1;
    return made || ended ? 0.5 : 0;
  },
};
