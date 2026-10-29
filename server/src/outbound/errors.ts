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

/**
 * The refusal for a campaign that is not there.
 *
 * Written once because three acts reach a campaign and each of them has to refuse
 * a missing one with the same code and the same sentence.
 */
export function campaignMissing(uid: string): OutboundError {
  return new OutboundError("outbound_not_found", `No campaign "${uid}" is there.`, 404);
}

/** The refusal for a row that is not in the campaign it was asked of. */
export function rowMissing(campaignUid: string, rowUid: string): OutboundError {
  return new OutboundError(
    "outbound_not_found",
    `No row "${rowUid}" is in campaign "${campaignUid}".`,
    404,
  );
}
