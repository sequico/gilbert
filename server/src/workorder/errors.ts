/**
 * The workorder surface's own refusals.
 *
 * Every refusal a workorder caller reads is a `WorkorderAdminError`, and every
 * conditional write takes its FileNode state token through `requireState`.
 * Both live here so the modules beside this one share one type.
 */

import { groupNotGrantedRefuser, stateRefuser } from "../adminSession.js";
import { CodedError } from "../shared/errors.js";

/** A refusal a workorder caller will read: a code, and the sentence to show. */
export class WorkorderAdminError extends CodedError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status, "WorkorderAdminError");
  }
}

/**
 * The account's FileNode state as the workorder conditional-write token, or a
 * refusal.
 *
 * The shared helper's sentence and code, raised as this door's own error
 * (`adminSession.ts`); `requireState(state)` stays the shape every workorder
 * write calls, so only the error type is this module's.
 */
export const requireState = stateRefuser(WorkorderAdminError);

/** The refusal a group the Master's own session does not hold carries, in the workorder error. */
export const groupNotGranted = groupNotGrantedRefuser(WorkorderAdminError);
