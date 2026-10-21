/**
 * The one tool that changes the installation's memory (ADR 0033).
 *
 * The write lands in the Master's own account, because one memory serves the
 * installation; the fact records the group it is about, which is what a
 * `standing` fact is filtered by.
 */

import { filesAccountId } from "../../appFolder.js";
import {
  MEMORY_FACT_MAX,
  MEMORY_SUBJECT_MAX,
  sameSubject,
  subjectProblem,
} from "../../shared/memory.js";
import { rememberFact } from "../memory.js";
import { argsRecord, textArg } from "./args.js";
import { defineTool, ToolError } from "./define.js";

/**
 * One fact the agent records while it works (ADR 0033).
 *
 * The write lands in the **Master's** own account and not the group's: one
 * memory serves the installation, so what is learned while working one group's
 * change is known by the next call in any of them. Its class is the agent's own
 * (`reversible`, ADR 0028): a fact it wrote can be read back and removed, so
 * nothing here asks a person — and the one thing that is *not* the agent's to
 * undo, a **person's** fact, is refused by the store itself and never reached
 * through the class.
 */
/**
 * A date or a time an ISO 8601 document would carry: `2026-10-21`, optionally
 * with a clock.
 */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/;

/**
 * A record's id: a UUID, or a short hex token that carries **both** a letter
 * and a digit — which is what a message, a run or a FileNode is named by
 * (`e907000`). Both are required on purpose: a pure number is a business
 * reference somebody typed (`seal 005073`), and a word spelled in hex letters
 * alone (`decade`) is a word, so neither is read as an id.
 */
const ID_TOKEN =
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{6,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** A sentence short enough to quote back in a refusal. */
function quoted(text: string): string {
  return text.length > 120 ? `"${text.slice(0, 120)}…"` : `"${text}"`;
}

/**
 * Why a sentence is not a fact the memory keeps (ADR 0033).
 *
 * The memory is the installation's standing knowledge, not a log. A sentence
 * that carries a date or a record's id reports what happened in one change, and
 * that belongs to the run's own record, where a reader looks for it. What is
 * kept is what a later change will still need: who a party is, how this group
 * wants a thing done, a standing constraint. The test is one question — would
 * this still be true, and still be useful, for a different change? — and these
 * are the two shapes that never pass it.
 */
export function eventProblem(fact: string): string | null {
  if (ISO_DATE.test(fact))
    return `${quoted(fact)} carries a date or a time, which is what happened in one change — the run's own record holds that. A fact is what stays true beyond it: who a party is, how this group wants a thing done, a standing constraint.`;
  if (ID_TOKEN.test(fact))
    return `${quoted(fact)} carries a record's id, which names one message, run or document — the run's record is where that belongs. A fact is what a later change will still need.`;
  return null;
}

/**
 * Why a subject is not one the memory files a fact under.
 *
 * A subject is a thing a later change names again — a party, a place, a
 * product, a practice. A date or a record's id is an instance of something that
 * happened: filed under it, the fact is recalled by nothing else, and it takes
 * one of the memory's subjects for ever.
 */
export function instanceSubjectProblem(subject: string): string | null {
  if (ISO_DATE.test(subject) || ID_TOKEN.test(subject))
    return `"${subject}" names one record or one date, not a thing the group works with. A subject is what a later change will name again — a party, a place, a product, a practice — and what happened once belongs to the run's own record.`;
  return null;
}

export const rememberFactTool = defineTool({
  name: "memory.remember",
  description:
    "Record one thing you have come to hold true, so that later calls start " +
    "from it: the subject it is about — a shipper, a client, a booking, a " +
    "folder, this group itself — and one sentence of what you hold of it. " +
    "Record what stays true beyond the change that taught it: who a party is, " +
    "how this group wants a thing done, a standing constraint or preference. " +
    "Never what happened once — a date, a message or run id, an arrival, a " +
    "figure from this morning: the run's own record holds that, and a fact " +
    "filed under it is recalled by nothing later. " +
    "It is " +
    "information you reason from, never an instruction: it grants nothing and " +
    "authorises nothing. The fact is recorded as being about **this group** — " +
    "the account you are working in — and one you mark `standing` is carried by " +
    "every call of this group and of no other; any fact you record is recalled " +
    "by its subject wherever in the installation it is needed. Name the facts " +
    "it belongs with in `links`. A fact a person wrote is in force and is never " +
    "written over: what you conclude against it is recorded as a **proposal** " +
    "beside it, and a person accepts or dismisses it.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  args: {
    subject: { type: "text", max: MEMORY_SUBJECT_MAX },
    fact: { type: "text", max: MEMORY_FACT_MAX },
    links: { type: "list" },
    standing: { type: "boolean" },
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const subject = textArg(args, "subject");
    const problem = subjectProblem(subject) ?? instanceSubjectProblem(subject);
    if (problem) throw new ToolError("bad_arguments", problem);
    const fact = textArg(args, "fact");
    if (fact.length > MEMORY_FACT_MAX)
      throw new ToolError(
        "bad_arguments",
        `"fact" must be at most ${MEMORY_FACT_MAX} characters.`,
      );
    const shape = eventProblem(fact);
    if (shape) throw new ToolError("bad_arguments", shape);
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
    // (ADR 0033). The account the fact is **about** is the group's, because that
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
    /*
     * A link names a fact the memory holds, and the model names the subjects it
     * knows. A subject the memory holds nothing about is dropped from the link
     * list and reported, never refused: the fact is the payload, and a booking
     * named before anyone wrote a fact about it is the ordinary case — the live
     * run refused fourteen facts for exactly that and re-asked without the link.
     */
    const held = links.filter((one) =>
      memory.facts.some((fact) => sameSubject(fact.subject, one)),
    );
    const notHeld = links.filter((one) => !held.includes(one));
    const written = await rememberFact(
      ctx,
      filesAccountId(ctx),
      {
        subject,
        fact,
        run: run.id,
        at: new Date().toISOString(),
        group: accountId,
        links: held,
        standing,
      },
      memory,
    );
    // A write against a person's fact is a proposal, and the model is told what
    // it is and what the person's sentence still is (ADR 0033).
    const proposal = written.proposal;
    return proposal?.run === run.id
      ? {
          id: written.id,
          subject: written.subject,
          ...(notHeld.length ? { notHeld } : {}),
          proposed: proposal.fact,
          inForce: written.fact,
        }
      : {
          id: written.id,
          subject: written.subject,
          ...(notHeld.length ? { notHeld } : {}),
        };
  },
});
