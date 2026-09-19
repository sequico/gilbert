/**
 * Whether this reader may move a contact between accounts, as a surface reads
 * it.
 *
 * The answer itself is the rule's (`contactMoveRefusal` in `contactMove.ts`),
 * which asks the session's admin flag (ADR 0001). What a *component* needs on
 * top of that is a reason to re-render when the flag moves, and no store this
 * view subscribes to carries it — so the subscription is here, read for its own
 * sake, exactly as `useMayDestroy` reads it for the mail rule.
 *
 * A surface that draws the move entries from a flag it read once, at mount,
 * would keep offering them to somebody whose administration was withdrawn, and
 * withhold them from somebody who just gained it.
 */
import { useSession } from "@/store/session";

export function useMayMoveContact(): boolean {
  return useSession((s) => s.session?.gilbert?.isAdmin) === true;
}
