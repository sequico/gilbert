/**
 * The tools over the account's workorders.
 *
 * Reading one with its steps, and settling a step as the agent — signed so a
 * reader sees that the agent settled it and not a person.
 */

import { readAppJsonAt } from "../../appFolder.js";
import { AGENT_SIGNATURE } from "../../shared/agent.js";
import {
  isWorkorderDoc,
  isWorkorderStepState,
  stepOf,
  WORKORDER_FOLDER,
  workorderClosedPath,
  workorderFileName,
} from "../../shared/workorder.js";
import { settleStepAsAgent, WorkorderAdminError } from "../../workorderAdmin.js";
import { argsRecord, notFound, textArg } from "./args.js";
import { defineTool, ToolError } from "./define.js";

export const readWorkorder = defineTool({
  name: "workorder.read",
  description:
    "Read one workorder this account holds, by its uid: its name, its state, " +
    "the checklist steps with who signed each of them, and the objects it " +
    "references.",
  authority: "reversible",
  writes: false,
  keys: ["uid"],
  parse: (raw: unknown) => ({ uid: textArg(argsRecord(raw), "uid") }),
  run: async ({ ctx, accountId }, { uid }) => {
    const name = workorderFileName(uid);
    const raw =
      (await readAppJsonAt(ctx, accountId, `${WORKORDER_FOLDER}/${name}`)) ??
      (await readAppJsonAt(ctx, accountId, `${workorderClosedPath()}/${name}`));
    if (!isWorkorderDoc(raw)) throw notFound(`workorder "${uid}" in this account`);
    return {
      uid: raw.uid,
      name: raw.name ?? null,
      state: raw.state ?? null,
      steps: raw.checklist.steps,
      refs: raw.refs,
      updated: raw.updated,
    };
  },
});

export const settleStep = defineTool({
  name: "workorder.settle",
  description:
    "Settle a step of one of this account's workorders: mark it done, skipped or " +
    "not-applicable, or open it again, with an optional note saying why. The step " +
    "is signed as the agent, so a reader sees that the agent settled it and not a " +
    "person. The step is named by its path, as workorder.read answers it.",
  authority: "reversible",
  writes: true,
  surface: "workorder",
  spend: { steps: 1 },
  keys: ["note", "path", "state", "uid"],
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
      const step = stepOf(doc.checklist, path);
      return { uid, path, state: step?.state ?? state, by: step?.by ?? AGENT_SIGNATURE };
    } catch (err) {
      // The workorder door's refusals are the surface's own codes and sentences;
      // what the model reads is the same code and the same words.
      if (err instanceof WorkorderAdminError)
        throw new ToolError(err.code, err.message, err.status);
      throw err;
    }
  },
});
