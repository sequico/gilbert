import { sessionIsAdmin } from "@gilbert/shared/sessionAccount";
import type { DeleteContext } from "@/lib/mailDelete";
import { useSession } from "../session";
import type { MailGet } from "./types";

/**
 * The delete rule's inputs, read at the moment an action is taken (ADR 0013).
 *
 * Read here rather than handed in because the store is where the action
 * happens and the account on screen is the store's own; the session is asked
 * for the copy it holds, which is ADR 0001's flag plus the question
 * `isOwnMailAccount` answers. Both move when the session state changes, which
 * the app re-reads on its own.
 */
export function deleteContext(get: MailGet): DeleteContext {
  const session = useSession.getState().session;
  return {
    accountId: get().accountId,
    session,
    isAdmin: sessionIsAdmin(session),
  };
}
