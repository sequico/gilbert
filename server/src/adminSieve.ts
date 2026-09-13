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
 */

import { accountId, type Ctx } from "./account.js";
import { JmapClient } from "./jmap.js";

const OBJECT = "x:SieveSystemScript";

export interface SystemSieveScript {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface SystemSieveScriptContent extends SystemSieveScript {
  contents: string;
}

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

interface SetErrorShape {
  type?: string;
  description?: string;
  properties?: string[];
}

/** Stalwart's own words about a refusal — this is where a bad script's compile error surfaces. */
function describeSetError(err: SetErrorShape): string {
  if (err.description) return err.description;
  if (err.type === "forbidden")
    return "Stalwart refused the change — this administrator may be missing the sysSieveSystemScript* permission.";
  if (err.type === "invalidProperties")
    return err.properties?.length
      ? `Stalwart rejected ${err.properties.join(", ")}.`
      : "Stalwart rejected the script.";
  return `Stalwart refused the change (${err.type ?? "error"}).`;
}

function clientOf(ctx: Ctx): JmapClient {
  return new JmapClient(ctx);
}

function toRow(o: Record<string, unknown>): SystemSieveScript {
  return {
    id: String(o.id ?? ""),
    name: String(o.name ?? ""),
    description: typeof o.description === "string" ? o.description : null,
    isActive: Boolean(o.isActive),
  };
}

export async function listSystemSieveScripts(ctx: Ctx): Promise<SystemSieveScript[]> {
  const res = await clientOf(ctx).call<{ list?: Record<string, unknown>[] }>(
    `${OBJECT}/get`,
    {
      accountId: accountId(ctx),
      ids: null,
      properties: ["name", "description", "isActive"],
    },
  );
  return (res.list ?? []).map(toRow);
}

export async function getSystemSieveScript(
  ctx: Ctx,
  id: string,
): Promise<SystemSieveScriptContent> {
  const res = await clientOf(ctx).call<{ list?: Record<string, unknown>[] }>(
    `${OBJECT}/get`,
    { accountId: accountId(ctx), ids: [id] },
  );
  const o = res.list?.[0];
  if (!o)
    throw new SystemSieveError(
      "That system Sieve script no longer exists.",
      404,
      "not_found",
    );
  return { ...toRow(o), contents: typeof o.contents === "string" ? o.contents : "" };
}

export interface SystemSieveScriptWrite {
  id: string | null;
  name: string;
  description: string | null;
  contents: string;
  activate: boolean;
}

/**
 * Create or update, in the shape Stalwart's own `x:SieveSystemScript/set`
 * validates: a bad script (or a name collision among active scripts) is
 * refused as a `SetError` here, not compiled or checked client-side.
 */
export async function saveSystemSieveScript(
  ctx: Ctx,
  opts: SystemSieveScriptWrite,
): Promise<string> {
  const properties = {
    name: opts.name,
    description: opts.description,
    contents: opts.contents,
    isActive: opts.activate,
  };
  const args: Record<string, unknown> = { accountId: accountId(ctx) };
  if (opts.id) args.update = { [opts.id]: properties };
  else args.create = { s: properties };
  const res = await clientOf(ctx).call<{
    created?: Record<string, { id: string }>;
    notCreated?: Record<string, SetErrorShape>;
    notUpdated?: Record<string, SetErrorShape>;
  }>(`${OBJECT}/set`, args);
  if (opts.id) {
    const err = res.notUpdated?.[opts.id];
    if (err) throw new SystemSieveError(describeSetError(err), 400, "invalid");
    return opts.id;
  }
  const err = res.notCreated?.s;
  if (err) throw new SystemSieveError(describeSetError(err), 400, "invalid");
  const id = res.created?.s?.id;
  if (!id)
    throw new SystemSieveError(
      "Stalwart created the script but did not return its id.",
      502,
      "upstream",
    );
  return id;
}

export async function setSystemSieveScriptActive(
  ctx: Ctx,
  id: string,
  active: boolean,
): Promise<void> {
  const res = await clientOf(ctx).call<{ notUpdated?: Record<string, SetErrorShape> }>(
    `${OBJECT}/set`,
    { accountId: accountId(ctx), update: { [id]: { isActive: active } } },
  );
  const err = res.notUpdated?.[id];
  if (err) throw new SystemSieveError(describeSetError(err), 400, "invalid");
}

export async function deleteSystemSieveScript(ctx: Ctx, id: string): Promise<void> {
  const res = await clientOf(ctx).call<{ notDestroyed?: Record<string, SetErrorShape> }>(
    `${OBJECT}/set`,
    { accountId: accountId(ctx), destroy: [id] },
  );
  const err = res.notDestroyed?.[id];
  if (err) throw new SystemSieveError(describeSetError(err), 400, "invalid");
}
