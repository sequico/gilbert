import { useSession } from "@/store/session";

/**
 * Re-read the session, so the collections other people share are current.
 *
 * A shared address book, calendar or folder arrives in the **JMAP session**,
 * which is fetched once and refreshed only when the server pushes a state
 * change to this tab — so a share granted while the reader sat in the composer
 * is invisible until something else moves. Opening the surface that offers
 * those collections is when the answer matters, so that is when it is asked
 * for.
 *
 * Throttled, because those surfaces are navigated to often and the answer is
 * usually the same one. The window is one for the whole client rather than one
 * per surface: the question is whether *this session* knows the shares that
 * exist, and a session re-read a second ago knows it wherever the reader goes
 * next.
 *
 * It answers nothing, and deliberately: the caller goes on to initialise its
 * own store whether or not the session was re-read, because that store lists
 * whatever the last session said. A failed refresh is not worth an error over
 * something the reader did not ask for, and it must not stop the caller from
 * showing what it already holds.
 */
const THROTTLE_MS = 30_000;
let lastRefresh = 0;

export async function refreshSessionShares(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastRefresh < THROTTLE_MS) return;
  lastRefresh = now;
  try {
    await useSession.getState().refresh();
  } catch {
    /* The stores still hold what the last session said. */
  }
}

/**
 * Re-read the session's shares and then re-initialise a store on top of it --
 * always, because that store lists whatever the session currently says.
 *
 * The surfaces that offer shared collections ask this of their own store;
 * `after` is for the one that must also ask which shared accounts exist (Files,
 * whose tree is what lists them).
 */
export async function refreshSharesInto(
  force: boolean,
  init: () => Promise<void>,
  after?: () => Promise<void>,
): Promise<void> {
  await refreshSessionShares(force);
  await init();
  if (after) await after();
}
