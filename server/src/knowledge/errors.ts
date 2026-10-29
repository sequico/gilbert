/**
 * The knowledge base's own refusals.
 *
 * Every refusal a KB caller reads is a `KnowledgeAdminError`, every conditional
 * write takes its FileNode state token through `requireState`, and the refusal a
 * retry carries when the article's own draft moved under it is `draftConflict`.
 * All three live here so the modules beside this one share one type.
 */

import { stateRefuser } from "../adminSession.js";
import { CodedError } from "../shared/errors.js";
import type { KnowledgeDraft } from "../shared/knowledge.js";

/** A refusal a KB caller will read: a code, and the sentence to show. */
export class KnowledgeAdminError extends CodedError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status, "KnowledgeAdminError");
  }
}

/**
 * The refusal a retry carries when the article's own draft moved under it.
 *
 * A write retries a refusal on the **account's** state, because an unrelated
 * write — a chat message, another article — moves that token for everybody. If
 * this article's own draft moved as well, the retry is not recovering from an
 * unrelated write: somebody saved this page while the change was deciding, and
 * writing the caller's copy over it would drop their words. The draft's own
 * last-change stamp is what tells the two apart, and the answer is a refusal the
 * person can act on rather than a silent overwrite. `before` is the draft the
 * last attempt knew — what it read, or the copy it wrote itself when only the
 * state document lost its race.
 */
export function draftConflict(
  before: KnowledgeDraft | null,
  after: KnowledgeDraft | null,
): KnowledgeAdminError | null {
  if (draftStamp(before) === draftStamp(after)) return null;
  return new KnowledgeAdminError(
    "draft_changed",
    "Somebody saved this page while this change was being written, so nothing was written over it. Reload the page to read their change, then make yours again.",
    409,
  );
}

/** What "the draft moved" means: who changed it last, and when. */
function draftStamp(draft: KnowledgeDraft | null): string {
  return draft ? `${draft.updated.by}\u0000${draft.updated.at}` : "";
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
