/**
 * The eval's eleven tasks, in the order the measure runs them (ADR 0038).
 *
 * Ordered quiet first: a task that measures silence costs nothing and answers
 * before any provider call is made, so a broken instruction or switch is read
 * before the day's budget is spent on the eight that drive the model.
 */
import type { EvalTask } from "../task.js";
import { deliveryOnTheCalendar } from "./delivery-on-the-calendar.js";
import { filedIntoAFolder } from "./filed-into-a-folder.js";
import { mailOutsideTheArea } from "./mail-outside-the-area.js";
import { mailReadAndReported } from "./mail-read-and-reported.js";
import { mentionAnswered } from "./mention-answered.js";
import { mentionWithoutInstruction } from "./mention-without-instruction.js";
import { noteSavedIntoFiles } from "./note-saved-into-files.js";
import { parkedUntilAnswered } from "./parked-until-answered.js";
import { referenceInTheReply } from "./reference-in-the-reply.js";
import { replyBecomesADraft } from "./reply-becomes-a-draft.js";
import { switchedOffNotice } from "./switched-off-notice.js";

export const TASKS: readonly EvalTask[] = [
  mentionWithoutInstruction,
  mailOutsideTheArea,
  switchedOffNotice,
  mailReadAndReported,
  replyBecomesADraft,
  mentionAnswered,
  filedIntoAFolder,
  deliveryOnTheCalendar,
  noteSavedIntoFiles,
  referenceInTheReply,
  parkedUntilAnswered,
];
