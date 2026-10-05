/**
 * Whether this reader may move a contact between accounts, as a surface reads
 * it.
 *
 * The answer itself is the rule's (`mayMoveBetweenAccounts` in `contactMove.ts`),
 * which ADR 0018 states once; this hook adds the reason a *component* needs it
 * here — a subscription, so the entry is drawn again when the session's admin
 * flag moves (ADR 0001). The contacts store carries no such flag, so a surface
 * that read it once, at mount, would keep offering the entry to somebody whose
 * administration was withdrawn and withhold it from somebody who just gained
 * it. `useMayDestroy` is the same shape for the mail rule.
 */

import { useSession } from "@/store/session";
import { mayMoveBetweenAccounts } from "./contactMove";

export function useMayMoveContact(): boolean {
  return mayMoveBetweenAccounts(useSession((s) => s.session?.gilbert?.isAdmin) === true);
}
