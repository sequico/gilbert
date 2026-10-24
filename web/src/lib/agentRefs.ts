/**
 * Where a reference in the conversation sends the reader.
 *
 * The agent names **an object of the group's account** — a thread, a file, a
 * card, an event — and never an address: the address is composed here, from the
 * kind and the id the server checked, so a message cannot point anywhere else
 * and a hostile mail cannot talk Gilbert into printing a link to itself.
 *
 * The label is the surface's own name, translated where it is drawn, so a chip
 * reads as the place it opens rather than as an id.
 */
import type { ChatRef } from "@gilbert/shared/chat";

/** The surface a reference opens, as the word the rest of the app uses. */
export const REF_LABEL: Record<ChatRef["kind"], string> = {
  thread: "Mail",
  file: "Files",
  contact: "Contacts",
  event: "Calendar",
};

/** The route a reference opens, inside the mount prefix the router adds. */
export function refHref(ref: ChatRef): string {
  const id = encodeURIComponent(ref.id);
  switch (ref.kind) {
    case "thread":
      // The conversation route: the one address that opens a thread without
      // naming a folder, which a chat answer cannot know.
      return `/search/${id}`;
    case "file":
      return `/files/${id}`;
    case "contact":
      return `/contacts/${id}`;
    case "event":
      // A calendar route names a day, which is why an event reference carries
      // one: the link lands on that day. Opening the event itself is the
      // calendar's own work, and a parameter nothing reads would only claim it.
      return `/calendar/day/${ref.date}`;
  }
}
