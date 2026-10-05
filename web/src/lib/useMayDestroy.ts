/**
 * Whether this reader may end the mail in the account on screen (ADR 0015), as a
 * surface reads it.
 *
 * The answer itself is the store's `mayDestroyHere()`, which asks the rule with
 * the account on screen and the session's admin flag. What a *component* needs
 * on top of that is a reason to re-render when either moves, and the mail store
 * only knows about one of the two: `isAdmin` lives in the session, so a surface
 * subscribed to the mail store alone would keep drawing the old answer after the
 * flag changed — the staleness ADR 0015 names in its consequences.
 *
 * The extra subscription is the established shape here: a component reads the
 * value it depends on purely so that a change re-renders it, as a list row does
 * for the date format. It is one hook rather than five copies of the same trick,
 * because a surface that forgets it is a surface that lies about what it may do.
 */
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";

export function useMayDestroy(): boolean {
  // Subscribed so a grant or a removal re-renders whatever drew an entry.
  useSession((s) => s.session?.gilbert?.isAdmin);
  return useMail((s) => s.mayDestroyHere());
}
