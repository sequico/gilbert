/**
 * The eval's fourteen tasks, in the order the measure runs them (ADR 0038).
 *
 * Ordered quiet first: a task that measures silence costs nothing and answers
 * before any provider call is made, so a broken instruction or switch is read
 * before the day's budget is spent on the ones that drive the model. Three of them
 * are the failures of 2026-10-26 written as shapes: a delivery in pieces, a
 * reference that lives in the thread, and a list in one message.
 */
import type { EvalTask } from "../task.js";
import { deliveryInPieces } from "./delivery-in-pieces.js";
import { deliveryOnTheCalendar } from "./delivery-on-the-calendar.js";
import { filedIntoAFolder } from "./filed-into-a-folder.js";
import { listInOneMessage } from "./list-in-one-message.js";
import { mailOutsideTheArea } from "./mail-outside-the-area.js";
import { mailReadAndReported } from "./mail-read-and-reported.js";
import { mentionAnswered } from "./mention-answered.js";
import { mentionWithoutInstruction } from "./mention-without-instruction.js";
import { noteSavedIntoFiles } from "./note-saved-into-files.js";
import { parkedUntilAnswered } from "./parked-until-answered.js";
import { referenceInTheReply } from "./reference-in-the-reply.js";
import { replyBecomesADraft } from "./reply-becomes-a-draft.js";
import { switchedOffNotice } from "./switched-off-notice.js";
import { threadReference } from "./thread-reference.js";

export const TASKS: readonly EvalTask[] = [
  mentionWithoutInstruction,
  mailOutsideTheArea,
  switchedOffNotice,
  mailReadAndReported,
  replyBecomesADraft,
  mentionAnswered,
  filedIntoAFolder,
  deliveryInPieces,
  threadReference,
  listInOneMessage,
  deliveryOnTheCalendar,
  noteSavedIntoFiles,
  referenceInTheReply,
  parkedUntilAnswered,
];
