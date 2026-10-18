/**
 * The administrator door (ADR 0001, ADR 0017).
 *
 * Stalwart admin is the Gilbert admin, read freshly on every privileged call,
 * bounded by the installation's own switch and its own-device rule, and failing
 * closed. `resolveAdminState` is the client's cosmetic mirror of it.
 */

import type { Context, MiddlewareHandler } from "hono";
import { administrationAllowed } from "../../adminGate.js";
import { config } from "../../config.js";
import type { LiveSession } from "../../sessions.js";
import { errorMessage } from "../../shared/errors.js";
import {
  fetchAccountIntrospection,
  isStalwartAdmin,
  upstreamFor,
} from "../../upstream.js";
import { upstreamFailure } from "./errors.js";
import type { Env } from "./sessions.js";

/**
 * Stalwart admin is the Gilbert admin: the session's own `/api/account`
 * permission list, read freshly on every privileged call so a demotion
 * really lands on the next call of an open session. Fails closed — an
 * unreachable introspection is an upstream failure, a list without the
 * admin marker is a plain 403.
 *
 * Two conditions on top of that marker bound every admin route as well as
 * the JMAP proxy (ADR 0017): the installation still offers administration
 * (`server.administration`), and this session was signed in on a device
 * marked as its owner's. An operator who turned administration off means it
 * of every door — this is the second one, and the version of the product that
 * only hid the menu would leave every one of these routes open to a browser
 * console.
 *
 * It bounds **writes**, and only writes: what a session may *read* is decided by
 * the rules of the surface it reads — a workorder's visibility is competence
 * (ADR 0028) — so neither condition here ever changes what a member or an
 * administrator sees.
 */
export const adminAllows = (session: LiveSession) =>
  administrationAllowed(
    config.administration,
    config.administrationNeedsOwnDevice,
    session.remember,
  );

/**
 * The administrator door, in one place: the checks `requireAdmin` performs,
 * and the same checks a route needs when only one tier of a shared write is
 * an administration's. It answers a refusal response, or null when the
 * session may act, and hands the caller's own permission list on for
 * `outranks`.
 */
export const enforceAdmin = async (c: Context<Env>): Promise<Response | null> => {
  try {
    // Registered behind requireSession everywhere; the deref sits inside
    // the try so a mis-registration fails as a controlled response, not a
    // 500 out of the accessor.
    const session = c.get("session");
    const intro = await fetchAccountIntrospection(
      session.authorization,
      upstreamFor(session.username),
    );
    if (!isStalwartAdmin(intro.permissions)) {
      return c.json(
        {
          error: "forbidden",
          message: "This needs Stalwart server-administrator privileges.",
        },
        403,
      );
    }
    if (!adminAllows(session)) {
      return administrationRefusal(c, config.administration);
    }
    // Handed on rather than fetched again: a route that acts on another
    // account has to compare the two permission lists (see `outranks`), and
    // this is the caller's own, read fresh a moment ago.
    c.set("adminPermissions", intro.permissions);
    return null;
  } catch (err) {
    return upstreamFailure(c, err);
  }
};

export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  const refusal = await enforceAdmin(c);
  if (refusal) return refusal;
  await next();
};

/**
 * Whether this session's credential currently resolves as a Stalwart admin,
 * for the client's `isAdmin` flag (ADR 0001). Fail-closed and never fatal:
 * an unreadable introspection reads as non-admin, so the shield is a
 * cosmetic mirror of the enforcement in `requireAdmin`, which stays the
 * authority.
 */
export const resolveAdminState = async (session: LiveSession): Promise<boolean> => {
  try {
    const intro = await fetchAccountIntrospection(
      session.authorization,
      upstreamFor(session.username),
    );
    return isStalwartAdmin(intro.permissions);
  } catch (err) {
    console.warn(
      `[gilbert] admin introspection failed for ${session.username}:`,
      errorMessage(err),
    );
    return false;
  }
};

/**
 * Why an administrative route is unavailable, as one refusal (ADR 0017). The
 * two causes are told apart because they are fixed differently: one by the
 * operator, one by signing in again on your own device. `method` names what was
 * refused, where a request had a name to give.
 */
export function administrationRefusal(
  c: Context<Env>,
  enabled: boolean,
  method?: string,
) {
  const suffix = method ? ` (${method})` : "";
  /*
   * Two causes, told apart because they are fixed differently — one by the
   * operator's configuration, the other by signing in again on your own device.
   * `enabled` false is the installation's own switch; reaching here with it true
   * means the only rule left is the device one, so that is what is reported.
   */
  return !enabled
    ? c.json(
        {
          error: "administration_disabled",
          message: `Administration is turned off on this installation${suffix}.`,
        },
        403,
      )
    : c.json(
        {
          error: "administration_needs_own_device",
          message: `Administration is only available when signed in on a device marked as your own${suffix}.`,
        },
        403,
      );
}
