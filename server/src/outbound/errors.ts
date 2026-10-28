/**
 * The outbound area's own refusals (ADR 0040).
 *
 * Every refusal a caller of this area reads is an `OutboundError`, and every
 * conditional write takes its FileNode state token through `requireState`. Both
 * live here so the modules beside this one share one type.
 */

import { stateRefuser } from "../adminSession.js";
import { CodedError } from "../shared/errors.js";

/** A refusal an outbound caller will read: a code, and the sentence to show. */
export class OutboundError extends CodedError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status, "OutboundError");
  }
}

/** The account's FileNode state as this area's conditional-write token. */
export const requireState = stateRefuser(OutboundError);
