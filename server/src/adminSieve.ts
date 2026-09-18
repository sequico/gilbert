/**
 * System Sieve scripts (ADR 0008): Stalwart's own trusted, server-wide
 * filters, held as the `x:SieveSystemScript` JMAP registry object — not an
 * account's own script, which is `SieveScript` in `web/src/store/sieve.ts`.
 *
 * The object belongs to no account, so the call runs directly as the
 * signed-in administrator's own session: no impersonation, the way
 * `account.ts` already calls `x:AppPassword` etc. as the signed-in user's own
 * session for their own account. `accountId(ctx)` is passed because JMAP
 * requires one on every call, not because Stalwart uses it here — the
 * registry ignores it for an object type that is not account-filtered.
 *
 * Every read hands back the type's own `state`, and every write that follows
 * a read (update, activate/deactivate, destroy) carries it as `ifInState` —
 * the same compare-and-set guard `FileNode/set` already relies on elsewhere
 * (ADR 0003, "Coordination: claims and fencing") — so a plain "Save" from a stale editor cannot silently
 * overwrite a change made from the list in between; it is refused instead.
 */

import { accountId, type Ctx } from "./account.js";
import { isStateMismatch } from "./jmap.js";
/*
 * The shapes these routes answer with, and the body a write carries, declared
 * once for both tiers: the surface that sends a write names the same fields the
 * route reads. See the module's own header for why the wire keeps `state`.
 */
import type {
  SystemSieveScript,
  SystemSieveScriptContent,
  SystemSieveScriptList,
  SystemSieveScriptWrite,
} from "./shared/sieveViews.js";
import {
  clientOf,
  describeSetError,
  type SetErrorPhrases,
  type SetErrorShape,
} from "./util.js";

/** How a refusal from Stalwart reads on this surface. */
const SET_ERRORS: SetErrorPhrases = {
  server: "Stalwart",
  forbidden:
    "Stalwart refused the change — this administrator may be missing the sysSieveSystemScript* permission.",
  rejected: (properties) => `Stalwart rejected ${properties.join(", ")}.`,
  rejectedValue: "Stalwart rejected the script.",
};

const OBJECT = "x:SieveSystemScript";

/** An error with a message meant for the administrator using the surface. */
export class SystemSieveError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "system_sieve_error",
  ) {
    super(message);
    this.name = "SystemSieveError";
  }
}

/** Stalwart's own words about a refusal — this is where a bad script's compile error surfaces. */
/** The one message for a lost race: reload and see the current version before trying again. */
const CONFLICT_MESSAGE =
  "This script was changed by someone else since it was last read here. Reload and try again.";

function toRow(o: Record<string, unknown>): SystemSieveScript {
  return {
    id: String(o.id ?? ""),
    name: String(o.name ?? ""),
    description: typeof o.description === "string" ? o.description : null,
    isActive: Boolean(o.isActive),
  };
}

/** Run a conditional `/set`; a lost `ifInState` race becomes one clear refusal. */
async function conditionalSet<T>(ctx: Ctx, args: Record<string, unknown>): Promise<T> {
  try {
    return await clientOf(ctx).call<T>(`${OBJECT}/set`, args);
  } catch (err) {
    if (isStateMismatch(err))
      throw new SystemSieveError(CONFLICT_MESSAGE, 409, "conflict");
    throw err;
  }
}

export async function listSystemSieveScripts(ctx: Ctx): Promise<SystemSieveScriptList> {
  const res = await clientOf(ctx).call<{
    list?: Record<string, unknown>[];
    state?: string;
  }>(`${OBJECT}/get`, {
    accountId: accountId(ctx),
    ids: null,
    properties: ["name", "description", "isActive"],
  });
  return { scripts: (res.list ?? []).map(toRow), state: String(res.state ?? "") };
}

export async function getSystemSieveScript(
  ctx: Ctx,
  id: string,
): Promise<SystemSieveScriptContent> {
  const res = await clientOf(ctx).call<{
    list?: Record<string, unknown>[];
    state?: string;
  }>(`${OBJECT}/get`, { accountId: accountId(ctx), ids: [id] });
  const o = res.list?.[0];
  if (!o)
    throw new SystemSieveError(
      "That system Sieve script no longer exists.",
      404,
      "not_found",
    );
  return {
    ...toRow(o),
    contents: typeof o.contents === "string" ? o.contents : "",
    state: String(res.state ?? ""),
  };
}

/**
 * Create or update, in the shape Stalwart's own `x:SieveSystemScript/set`
 * validates: a bad script (or a name collision among active scripts) is
 * refused as a `SetError` here, not compiled or checked client-side. `id` is
 * null for a create. An update carries the wire's `state` to Stalwart as
 * `ifInState` when the caller has one — this is the one place the two
 * vocabularies meet — so a save built on a since-changed read is refused
 * rather than silently overwriting it.
 */
export async function saveSystemSieveScript(
  ctx: Ctx,
  id: string | null,
  body: SystemSieveScriptWrite,
): Promise<string> {
  const properties = {
    name: body.name,
    description: body.description,
    contents: body.contents,
    isActive: body.activate,
  };
  const args: Record<string, unknown> = { accountId: accountId(ctx) };
  if (id) {
    args.update = { [id]: properties };
    if (body.state) args.ifInState = body.state;
  } else {
    args.create = { s: properties };
  }
  const res = await conditionalSet<{
    created?: Record<string, { id: string }>;
    notCreated?: Record<string, SetErrorShape>;
    notUpdated?: Record<string, SetErrorShape>;
  }>(ctx, args);
  if (id) {
    const err = res.notUpdated?.[id];
    if (err)
      throw new SystemSieveError(describeSetError(err, SET_ERRORS), 400, "invalid");
    return id;
  }
  const err = res.notCreated?.s;
  if (err) throw new SystemSieveError(describeSetError(err, SET_ERRORS), 400, "invalid");
  const created = res.created?.s?.id;
  if (!created)
    throw new SystemSieveError(
      "Stalwart created the script but did not return its id.",
      502,
      "upstream",
    );
  return created;
}

export async function setSystemSieveScriptActive(
  ctx: Ctx,
  id: string,
  active: boolean,
  ifInState?: string,
): Promise<void> {
  const res = await conditionalSet<{ notUpdated?: Record<string, SetErrorShape> }>(ctx, {
    accountId: accountId(ctx),
    update: { [id]: { isActive: active } },
    ...(ifInState ? { ifInState } : {}),
  });
  const err = res.notUpdated?.[id];
  if (err) throw new SystemSieveError(describeSetError(err, SET_ERRORS), 400, "invalid");
}

export async function deleteSystemSieveScript(
  ctx: Ctx,
  id: string,
  ifInState?: string,
): Promise<void> {
  const res = await conditionalSet<{ notDestroyed?: Record<string, SetErrorShape> }>(
    ctx,
    {
      accountId: accountId(ctx),
      destroy: [id],
      ...(ifInState ? { ifInState } : {}),
    },
  );
  const err = res.notDestroyed?.[id];
  if (err) throw new SystemSieveError(describeSetError(err, SET_ERRORS), 400, "invalid");
}
