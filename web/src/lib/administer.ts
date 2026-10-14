import { sessionIsAdmin } from "@gilbert/shared/sessionAccount";
import type { JmapSession } from "@/jmap/types";

/**
 * Whether this session may administer (ADR 0017): the Stalwart admin marker
 * *and* the door's own condition — an installation that still offers
 * administration, on a device this person marked as their own.
 *
 * What it gates is **administering**: the admin menu, and the workorder panel's
 * create and close controls, which the server's own doors enforce beside it. One
 * definition, so a control a refused session still sees is not a menu that
 * disagrees with the door.
 *
 * It gates nothing else. A workorder's steps are **checked by competence**, not
 * by administration: a member's part is theirs whatever this says (the summary
 * carries `canCheck` per part, and the check route needs a session plus
 * membership). Reading is not administering either — a device condition must not
 * change what a workorder looks like to the person reading it.
 */
export function mayAdminister(gilbert: JmapSession["gilbert"] | undefined): boolean {
  return sessionIsAdmin({ gilbert }) && gilbert?.administration !== false;
}
