/**
 * The knowledge base's own refusals.
 *
 * Every refusal a KB caller reads is a `KnowledgeAdminError`, and every
 * conditional write takes its FileNode state token through `requireState`.
 * Both live here so the modules beside this one share one type.
 */

import { stateRefuser } from "../adminSession.js";
import { CodedError } from "../shared/errors.js";

/** A refusal a KB caller will read: a code, and the sentence to show. */
export class KnowledgeAdminError extends CodedError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status, "KnowledgeAdminError");
  }
}

/**
 * The account's FileNode state as the KB's conditional-write token, or a
 * refusal.
 *
 * The shared helper's sentence and code, raised as this door's own error
 * (`adminSession.ts`); `requireState(state)` stays the shape every KB write
 * calls, so only the error type is this module's.
 */
export const requireState = stateRefuser(KnowledgeAdminError);
