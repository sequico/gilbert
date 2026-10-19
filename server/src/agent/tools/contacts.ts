/**
 * The tool over the installation's Global contacts (ADR 0023).
 *
 * One directory, owned by the Master and readable by every account: it is how
 * the agent learns who an address belongs to before it writes to somebody, and
 * it is read as the installation, exactly as the surfaces read it.
 */

import { filesAccountId } from "../../appFolder.js";
import { readGlobalContacts } from "../../globalContactsAdmin.js";
import { argsRecord, textArg } from "./args.js";
import { defineTool } from "./define.js";

/** How many cards one search answers with, whatever the model asks for. */
const FIND_MAX = 25;

export const findContacts = defineTool({
  name: "contacts.find",
  description:
    "Find people in the installation's Global contacts by any part of their " +
    "name, address, organization, phone or notes — the one directory every " +
    "account shares. Use it to learn who an address belongs to before you " +
    `write to it. At most ${FIND_MAX} cards.`,
  authority: "reversible",
  writes: false,
  keys: ["query"],
  parse: (raw: unknown) => ({ query: textArg(argsRecord(raw), "query") }),
  run: async ({ ctx }, { query }) => {
    const wanted = query.trim().toLowerCase();
    const cards = await readGlobalContacts(ctx, filesAccountId(ctx));
    const matches = cards
      .filter((card) =>
        [card.name, card.organization, card.notes, ...card.emails, ...card.phones].some(
          (one) => one.toLowerCase().includes(wanted),
        ),
      )
      .slice(0, FIND_MAX);
    return { contacts: matches };
  },
});
