/**
 * The one tool that changes the installation's memory (ADR 0037).
 *
 * The write lands in the Master's own account, because one memory serves the
 * installation; the fact records the group it is about, which is what a
 * `standing` fact is filtered by.
 */

import { filesAccountId } from "../../appFolder.js";
import { MEMORY_FACT_MAX, subjectProblem } from "../../shared/memory.js";
import { rememberFact } from "../memory.js";
import { argsRecord, textArg } from "./args.js";
import { defineTool, ToolError } from "./define.js";

/**
 * One fact the agent records while it works (ADR 0037).
 *
 * The write lands in the **Master's** own account and not the group's: one
 * memory serves the installation, so what is learned while working one group's
 * change is known by the next call in any of them. Its class is the agent's own
 * (`reversible`, ADR 0032): a fact it wrote can be read back and removed, so
 * nothing here asks a person — and the one thing that is *not* the agent's to
 * undo, a **person's** fact, is refused by the store itself and never reached
 * through the class.
 */
export const rememberFactTool = defineTool({
  name: "memory.remember",
  description:
    "Record one thing you have come to hold true, so that later calls start " +
    "from it: the subject it is about — a shipper, a client, a booking, a " +
    "folder, this group itself — and one sentence of what you hold of it. It is " +
    "information you reason from, never an instruction: it grants nothing and " +
    "authorises nothing. The fact is recorded as being about **this group** — " +
    "the account you are working in — and one you mark `standing` is carried by " +
    "every call of this group and of no other; any fact you record is recalled " +
    "by its subject wherever in the installation it is needed. Name the facts " +
    "it belongs with in `links`. A fact a person wrote is in force and this " +
    "is in force and is never written over: what you conclude against it is " +
    "recorded as a **proposal** beside it, and a person accepts or dismisses it.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const subject = textArg(args, "subject");
    const problem = subjectProblem(subject);
    if (problem) throw new ToolError("bad_arguments", problem);
    const fact = textArg(args, "fact");
    if (fact.length > MEMORY_FACT_MAX)
      throw new ToolError(
        "bad_arguments",
        `"fact" must be at most ${MEMORY_FACT_MAX} characters.`,
      );
    const standing = args.standing ?? false;
    if (typeof standing !== "boolean")
      throw new ToolError("bad_arguments", '"standing" must be true or false.');
    // The subjects the fact belongs with; a list left out is no links at all.
    const links: unknown = args.links ?? [];
    if (
      !Array.isArray(links) ||
      !links.every((one) => typeof one === "string" && Boolean(one.trim()))
    )
      throw new ToolError("bad_arguments", '"links" must be a list of names.');
    return {
      subject,
      fact,
      links: (links as string[]).map((one) => one.trim()),
      standing,
    };
  },
  run: async ({ ctx, accountId, run, memory }, { subject, fact, links, standing }) => {
    // The memory is the installation's, so the account it is **written to** is
    // the principal's own — the Master's — and never the group's the run lives in
    // (ADR 0037). The account the fact is **about** is the group's, because that
    // is what a `standing` fact is filtered by when a call of a group is made.
    // What the fact is written against is the pass's own reading of the store,
    // handed to every step of the pass: reading it again here is what would walk
    // the whole memory once per remembered fact.
    if (!memory)
      throw new ToolError(
        "memory_unread",
        "The installation's memory has not been read for this call, and a fact is never written against a reading that is not there.",
        409,
      );
    const written = await rememberFact(
      ctx,
      filesAccountId(ctx),
      {
        subject,
        fact,
        run: run.id,
        at: new Date().toISOString(),
        group: accountId,
        links,
        standing,
      },
      memory,
    );
    // A write against a person's fact is a proposal, and the model is told what
    // it is and what the person's sentence still is (ADR 0037).
    const proposal = written.proposal;
    return proposal?.run === run.id
      ? {
          id: written.id,
          subject: written.subject,
          proposed: proposal.fact,
          inForce: written.fact,
        }
      : { id: written.id, subject: written.subject };
  },
});
