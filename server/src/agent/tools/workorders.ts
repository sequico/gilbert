/**
 * The tools over the account's workorders.
 *
 * Discovering the work this account holds a part of, reading one with its steps,
 * and settling a step as the agent — signed so a reader sees that the agent
 * settled it and not a person.
 */

import {
  type Ctx,
  fileChildren,
  filesAccountId,
  findFolderPath,
  nodeStamp,
  readAppJsonAt,
} from "../../appFolder.js";
import { AGENT_SIGNATURE } from "../../shared/agent.js";
import { APP_FOLDER_NAME, FOLDER_PROPS } from "../../shared/appFolder.js";
import { mapLimit, READ_CONCURRENCY } from "../../shared/concurrency.js";
import { resolveChecklist } from "../../shared/knowledge.js";
import {
  isWorkorderDoc,
  isWorkorderStepState,
  itemKeysOf,
  stepOf,
  WORKORDER_FOLDER,
  WORKORDER_STEP_STATES,
  type WorkorderChecklist,
  workorderClosedPath,
  workorderFileName,
} from "../../shared/workorder.js";
import { type TemplateReader, templateDef } from "../../workorder/templates.js";
import { settleStepAsAgent, WorkorderAdminError } from "../../workorderAdmin.js";
import { fileWriteKey, markOwnWrite } from "../ownWrites.js";
import { argsRecord, countArg, notFound, textArg } from "./args.js";
import { defineTool, ToolError } from "./define.js";

/**
 * The most workorders one listing answers with.
 *
 * Each row costs a read of the Master's root beside the part — the name and the
 * state live there and nowhere else — so the page is smaller than a files
 * listing's, and `total`/`truncated` say what it left out.
 */
export const WORKORDER_LIST_MAX = 50;

/** What one listing page answers with unless the model asks for less. */
const WORKORDER_LIST_DEFAULT = 20;

/**
 * The Master's own copy of one workorder: the root, which carries the name and
 * the state, in the active folder or in `closed/`.
 *
 * A group holds a **part** — its own steps — and the part carries neither, so a
 * workorder's name and whether it is closed are read from here. A root that is
 * not there answers null, which the callers treat as a document this account
 * cannot name.
 */
async function masterRootOf(ctx: Ctx, master: string, uid: string): Promise<unknown> {
  const name = workorderFileName(uid);
  return (
    (await readAppJsonAt(ctx, master, `${WORKORDER_FOLDER}/${name}`)) ??
    (await readAppJsonAt(ctx, master, `${workorderClosedPath()}/${name}`))
  );
}

export const listWorkorders = defineTool({
  name: "workorder.list",
  description:
    "List the workorders this account holds a part of, newest first: the uid, " +
    "the name, the state, and how many of this account's steps are still open. " +
    `\`limit\` is how many to answer with (at most ${WORKORDER_LIST_MAX}); ` +
    "`total` and `truncated` say whether there are more. Read one with " +
    '`open` (`what: "workorder"`), by the uid this answers.',
  authority: "reversible",
  writes: false,
  args: { limit: { type: "number", min: 1, max: WORKORDER_LIST_MAX } },
  parse: (raw: unknown) => ({
    limit:
      countArg(argsRecord(raw), "limit", WORKORDER_LIST_MAX) ?? WORKORDER_LIST_DEFAULT,
  }),
  run: async ({ ctx, accountId }, { limit }) => {
    const folder = await findFolderPath(ctx, accountId, WORKORDER_FOLDER);
    if (folder === null) return { workorders: [], total: 0, truncated: false };
    const master = filesAccountId(ctx);
    // The stamps are what the page is ordered by, and they are not in the set a
    // tree walk asks for; asking for them widens that set (`readProps`).
    const children = await fileChildren(ctx, accountId, folder, [
      ...FOLDER_PROPS,
      "created",
      "modified",
    ]);
    /*
     * Ordered **before** the page is cut: the folder answers in its own order, and
     * a page taken from that order is the first documents ever filed — a listing
     * of fifty would read work that ended months ago while today's sits behind it.
     * The node's own stamp is the order, as the runs listing's is.
     */
    const held = children
      .filter(
        (child) =>
          child.nodeType === "file" &&
          typeof child.name === "string" &&
          child.name.endsWith(".json"),
      )
      .map((child) => ({
        uid: String(child.name).slice(0, -".json".length),
        stamp: nodeStamp(child),
      }))
      .sort((a, b) => b.stamp.localeCompare(a.stamp));
    const rows = await mapLimit(
      held.slice(0, limit),
      READ_CONCURRENCY,
      async ({ uid }) => {
        const part = await readAppJsonAt(
          ctx,
          accountId,
          `${WORKORDER_FOLDER}/${workorderFileName(uid)}`,
        );
        if (!isWorkorderDoc(part)) return null;
        const root = await masterRootOf(ctx, master, uid);
        const whole = isWorkorderDoc(root) ? root : null;
        const steps = part.checklist.steps;
        return {
          uid,
          name: whole?.name ?? part.name ?? null,
          state: whole?.state ?? part.state ?? null,
          open: steps.filter((step) => step.state === "open").length,
          steps: steps.length,
          updated: whole?.updated ?? part.updated ?? null,
        };
      },
    );
    return {
      workorders: rows.filter((row): row is NonNullable<typeof row> => row !== null),
      total: held.length,
      truncated: held.length > limit,
    };
  },
});

/**
 * The controlled label of every step, by path, from the template this part is
 * bound to.
 *
 * A part stores paths and states and never the words — the controlled text lives
 * in the template's revision (ADR 0026) — so a model handed only `loading[CONT-1].seal`
 * reasons about a string it cannot read. A template that cannot be read leaves
 * the map empty and the caller falls back to the path, which is still the step's
 * identity.
 */
async function stepLabels(
  ctx: Ctx,
  accountId: string,
  checklist: WorkorderChecklist,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  // A reader of its own: this read is one workorder, and the caches live as long
  // as the answer it composes.
  const reader: TemplateReader = { ctx, defs: new Map(), articleFolders: new Map() };
  const def = (await templateDef(reader, checklist.template)).checklist;
  if (!def) return labels;
  /*
   * Both targets: the sections this account owns, and the global ones it may
   * hold — what a part document carries is the document's business, and a label
   * resolved for the wrong scope is a path the model sees stripped of its words
   * for no reason.
   */
  for (const target of [accountId, null])
    for (const section of resolveChecklist(
      def,
      checklist.variants,
      itemKeysOf(checklist.items),
      target,
    ))
      for (const item of section.items)
        for (const step of item.steps) labels.set(step.path, step.label);
  return labels;
}

export const readWorkorder = defineTool({
  name: "workorder.read",
  description:
    "Read one workorder this account holds a part of, by its uid: its name, its " +
    "state, the checklist steps with their words and who signed each of them, " +
    "and the objects it references. The name, the state and the closed record " +
    "are the installation's, read beside the part this account holds.",
  authority: "reversible",
  writes: false,
  args: { uid: { type: "text" } },
  parse: (raw: unknown) => ({ uid: textArg(argsRecord(raw), "uid") }),
  run: async ({ ctx, accountId }, { uid }) => {
    const name = workorderFileName(uid);
    const raw = await readAppJsonAt(ctx, accountId, `${WORKORDER_FOLDER}/${name}`);
    if (!isWorkorderDoc(raw)) throw notFound(`workorder "${uid}" in this account`);
    /*
     * A part carries the steps and nothing about the workorder as a whole: the
     * name, the state and the successor are the Master's root, which is the one
     * document that knows whether this work still changes. Read here, so a
     * closed workorder does not read as a runnable one.
     */
    const root = await masterRootOf(ctx, filesAccountId(ctx), uid);
    const whole = isWorkorderDoc(root) ? root : null;
    const labels = await stepLabels(ctx, accountId, raw.checklist);
    return {
      uid: raw.uid,
      name: whole?.name ?? raw.name ?? null,
      state: whole?.state ?? raw.state ?? null,
      steps: raw.checklist.steps.map((step) => ({
        ...step,
        // The words the reader sees, beside the path the calls take.
        label: labels.get(step.path) ?? step.path,
      })),
      refs: whole?.refs ?? raw.refs,
      updated: whole?.updated ?? raw.updated,
    };
  },
});

export const settleStep = defineTool({
  name: "workorder.settle",
  description:
    "Settle a step of one of this account's workorders: mark it done, skipped or " +
    "not-applicable, or open it again, with an optional note saying why. The step " +
    "is signed as the agent, so a reader sees that the agent settled it and not a " +
    "person. The step is named by its path, as `open` answers it.",
  authority: "reversible",
  writes: true,
  surface: "workorder",
  spend: { steps: 1 },
  args: {
    uid: { type: "text" },
    path: { type: "text" },
    state: { type: "one of", values: WORKORDER_STEP_STATES },
    note: { type: "text" },
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const state = args.state ?? "done";
    if (!isWorkorderStepState(state))
      throw new ToolError(
        "bad_arguments",
        '"state" must be open, done, skipped or not-applicable.',
      );
    return {
      uid: textArg(args, "uid"),
      path: textArg(args, "path"),
      state,
      note: args.note === undefined ? "" : textArg(args, "note"),
    };
  },
  run: async ({ ctx, accountId }, { uid, path, state, note }) => {
    try {
      const doc = await settleStepAsAgent({
        ctx,
        accountId,
        uid,
        path,
        state,
        note,
        by: AGENT_SIGNATURE,
      });
      // Its own settlement, so the change reading does not answer it.
      markOwnWrite(
        accountId,
        fileWriteKey(`${APP_FOLDER_NAME}/${WORKORDER_FOLDER}/${workorderFileName(uid)}`),
      );
      const step = stepOf(doc.checklist, path);
      const steps = doc.checklist.steps;
      return {
        uid,
        path,
        state: step?.state ?? state,
        by: step?.by ?? AGENT_SIGNATURE,
        open: steps.filter((one) => one.state === "open").length,
        steps: steps.length,
      };
    } catch (err) {
      // The workorder door's refusals are the surface's own codes and sentences;
      // what the model reads is the same code and the same words.
      if (err instanceof WorkorderAdminError)
        throw new ToolError(err.code, err.message, err.status);
      throw err;
    }
  },
});
