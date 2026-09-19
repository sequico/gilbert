import {
  type Ctx,
  destroyAppNode,
  downloadBlobText,
  filesAccountId,
  findAppFileAt,
  writeAppFile,
} from "./appFolder.js";
import { config } from "./config.js";
import { type Invocation, JMAP_MAIL, STALWART_CAP } from "./jmap.js";
import {
  type AppPasswordRow,
  type SecurityState,
} from "./shared/accountSecurity.js";
import {
  GROUP_LABELS_FILE,
  isLabelCatalog,
  type LabelCatalogEntry,
} from "./shared/labels.js";
import { generateSecret, otpauthUrl, parseOtpauthUrl, verifyTotp } from "./totp.js";
import { UpstreamError } from "./upstream.js";
import { clientOf, describeSetError, type SetErrorPhrases } from "./util.js";

/** How a refusal reads where a person's own settings are being written. */
const SET_ERRORS: SetErrorPhrases = {
  server: "The mail server",
  forbidden: "The mail server refused the change.",
  overQuota: "You have reached the number of app passwords this account allows.",
  rejected: (properties) => `The mail server rejected ${properties.join(", ")}.`,
  rejectedValue: "The mail server rejected the value.",
};

export type { Ctx };
export { filesAccountId };

/**
 * Self-service credential management, over Stalwart's JMAP registry:
 * `x:AccountPassword` (a singleton holding the password and the otpauth URL)
 * and `x:AppPassword`.
 *
 * The registry crate arrived in 0.16, which is the oldest Stalwart Gilbert
 * supports. Sign-in refuses anything older, so by the time any of this runs
 * the registry is known to be there.
 */

/** Stalwart's id for a singleton object; the number it encodes spells this. */
const SINGLETON = "singleton";
/** Returned in place of a stored secret; echo it back to leave one unchanged. */
const MASKED = "[********]";

/** An error with a message meant for the person using the app. */
export class AccountError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "account_error",
  ) {
    super(message);
    this.name = "AccountError";
  }
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

/**
 * The signed-in session's own account — exported for `adminSieve.ts`, which
 * writes a global registry object (no account of its own to scope to) as the
 * administrator's own session rather than an impersonated one, and needs the
 * same accountId Stalwart's `x:*` calls otherwise ignore but still require.
 */
export function accountId(ctx: Ctx): string {
  return (
    ctx.session.primaryAccounts?.[STALWART_CAP] ??
    ctx.session.primaryAccounts?.[JMAP_MAIL] ??
    Object.keys(ctx.session.accounts ?? {})[0] ??
    ""
  );
}

/**
 * One JMAP request, in the shape this module's call sites read.
 *
 * The transport itself is `JmapClient`'s; this only keeps the `{ methodResponses }`
 * wrapper the `/set` result reader below expects.
 */
async function jmap(
  ctx: Ctx,
  methodCalls: Invocation[],
  using: string[] = [],
): Promise<{ methodResponses?: [string, unknown, string][] }> {
  return { methodResponses: await clientOf(ctx).request(methodCalls, using) };
}

/**
 * Pull the single result out of a /set, turning JMAP's several failure shapes
 * into one error carrying whatever the server was willing to explain.
 */
function setResult(
  res: { methodResponses?: [string, unknown, string][] },
  kind: "created" | "updated" | "destroyed",
): Record<string, unknown> | null {
  const [name, args] = res.methodResponses?.[0] ?? [];
  if (!name) throw new AccountError("The mail server sent no response.", 502, "upstream");
  if (name === "error") {
    const err = args as { type?: string; description?: string };
    if (err.type === "unknownMethod") {
      throw new AccountError(
        "This mail server does not offer self-service credential management.",
        501,
        "unsupported",
      );
    }
    throw new AccountError(
      err.description ?? `The mail server refused the request (${err.type ?? "error"}).`,
      502,
      err.type ?? "upstream",
    );
  }
  const body = args as Record<string, Record<string, unknown> | undefined>;
  const notKind =
    kind === "created"
      ? "notCreated"
      : kind === "updated"
        ? "notUpdated"
        : "notDestroyed";
  const failures = body[notKind];
  const failure = failures && Object.values(failures)[0];
  if (failure) {
    const err = failure as { type?: string; description?: string; properties?: string[] };
    throw new AccountError(
      describeSetError(err, SET_ERRORS),
      err.type === "forbidden" ? 403 : 400,
      err.type ?? "invalid",
    );
  }
  const ok = body[kind];
  return ok ? ((Object.values(ok)[0] ?? {}) as Record<string, unknown>) : null;
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

export async function getState(ctx: Ctx): Promise<SecurityState> {
  const id = accountId(ctx);
  const res = await jmap(ctx, [
    ["x:AccountPassword/get", { accountId: id, ids: [SINGLETON] }, "p"],
    ["x:AppPassword/get", { accountId: id, ids: null }, "a"],
  ]);
  const pass = firstListItem(res, "p") as { otpAuth?: { otpUrl?: string | null } } | null;
  const apps = listOf(res, "a");
  return {
    // The URL itself is masked; its presence is what tells us 2FA is on.
    otpEnabled: Boolean(pass?.otpAuth?.otpUrl),
    appPasswords: apps.map((a) => ({
      id: String(a.id ?? ""),
      description: String(a.description ?? "App password"),
      createdAt: typeof a.createdAt === "string" ? a.createdAt : null,
      expiresAt: typeof a.expiresAt === "string" ? a.expiresAt : null,
    })),
  };
}

function listOf(
  res: { methodResponses?: [string, unknown, string][] },
  callId: string,
): Record<string, unknown>[] {
  const call = res.methodResponses?.find((r) => r[2] === callId);
  if (!call || call[0] === "error") return [];
  const list = (call[1] as { list?: unknown }).list;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

function firstListItem(
  res: { methodResponses?: [string, unknown, string][] },
  callId: string,
): Record<string, unknown> | null {
  return listOf(res, callId)[0] ?? null;
}

export async function changePassword(
  ctx: Ctx,
  opts: { current: string; next: string; otpCode?: string },
): Promise<void> {
  const update: Record<string, unknown> = {
    currentSecret: opts.current,
    secret: opts.next,
  };
  if (opts.otpCode) update["otpAuth/otpCode"] = opts.otpCode;
  const res = await jmap(ctx, [
    [
      "x:AccountPassword/set",
      { accountId: accountId(ctx), update: { [SINGLETON]: update } },
      "s",
    ],
  ]);
  setResult(res, "updated");
}

export async function createAppPassword(
  ctx: Ctx,
  opts: { description: string },
): Promise<{ id: string; secret: string }> {
  const description = opts.description.trim() || "App password";
  const res = await jmap(ctx, [
    [
      "x:AppPassword/set",
      { accountId: accountId(ctx), create: { n: { description } } },
      "s",
    ],
  ]);
  const created = setResult(res, "created");
  const secret = created && typeof created.secret === "string" ? created.secret : "";
  if (!secret)
    throw new AccountError(
      "The mail server created the app password but did not return it.",
      502,
      "upstream",
    );
  return { id: String(created?.id ?? description), secret };
}

export async function revokeAppPassword(ctx: Ctx, id: string): Promise<void> {
  const res = await jmap(ctx, [
    ["x:AppPassword/set", { accountId: accountId(ctx), destroy: [id] }, "s"],
  ]);
  setResult(res, "destroyed");
}

/**
 * Start enrolment: mint a secret and hand back the URL to show as a QR code.
 * Nothing is stored until the user proves they can produce a code from it.
 */
export function beginOtpEnrolment(ctx: Ctx): { secret: string; url: string } {
  const secret = generateSecret();
  return {
    secret,
    url: otpauthUrl({
      secret,
      account: ctx.username,
      issuer: config.appName || "Gilbert",
    }),
  };
}

/**
 * Prove the user can produce a code from the secret they just scanned.
 *
 * Stalwart validates the credentials already on the account and never looks at
 * the new secret, so without this an authenticator that was mistyped or out of
 * step would lock the user out of their mailbox at the next sign-in.
 */
export function assertEnrolmentCode(url: string, code: string): void {
  const params = parseOtpauthUrl(url);
  if (!params)
    throw new AccountError("That two-factor secret is not usable.", 400, "bad_otp_url");
  if (!verifyTotp(params, code)) {
    throw new AccountError(
      "That code doesn't match. Check your authenticator app and try the next code.",
      400,
      "bad_code",
    );
  }
}

export async function enableOtp(
  ctx: Ctx,
  opts: { url: string; code: string; current: string },
): Promise<void> {
  assertEnrolmentCode(opts.url, opts.code);
  const res = await jmap(ctx, [
    [
      "x:AccountPassword/set",
      {
        accountId: accountId(ctx),
        update: {
          [SINGLETON]: { currentSecret: opts.current, "otpAuth/otpUrl": opts.url },
        },
      },
      "s",
    ],
  ]);
  setResult(res, "updated");
}

export async function disableOtp(
  ctx: Ctx,
  opts: { current: string; code: string },
): Promise<void> {
  const res = await jmap(ctx, [
    [
      "x:AccountPassword/set",
      {
        accountId: accountId(ctx),
        update: {
          [SINGLETON]: {
            currentSecret: opts.current,
            "otpAuth/otpCode": opts.code,
            "otpAuth/otpUrl": null,
          },
        },
      },
      "s",
    ],
  ]);
  setResult(res, "updated");
}

export { MASKED };

/* ------------------------------------------------------------------ */
/* The forced-password-change directive (ADR 0001)                     */
/* ------------------------------------------------------------------ */

/**
 * The hidden app folder and the directive file inside it.
 *
 * ADR 0001: the directive is a small file `must-change-password.json` inside
 * the user's own `gilbert` app folder in their account Files — the same
 * folder the client keeps `settings.json` in, and deliberately a separate
 * file, because the client whole-file-replaces `settings.json` on save and a
 * directive inside it would not survive the next settings write. Missing
 * file = not forced.
 *
 * The separation is for a document whose key the client's schema does not own.
 * A key it does own lives inside `settings.json` on purpose — the default
 * sending identity is one (`defaultIdentityByAccount`, ADR 0007) — because
 * the client writes its own copy of the whole document back, that key included,
 * whereas a key it does not know would be gone with the next save.
 *
 * The name match is done here, client-style, because `FileNode/query` cannot
 * filter by `name` — a filter the server does not know fails the whole query
 * (checked on 0.16.19, 2026-08-27; see `web/src/lib/appFolder.ts`).
 */
export const PASSWORD_CHANGE_DIRECTIVE = "must-change-password.json";

/**
 * Whether the principal's own account carries a valid directive.
 *
 * Never throws: a missing folder, a missing file, an unreadable blob or a
 * document that will not parse all mean "not forced". ADR 0001 says a
 * corrupt directive document must not refuse boot or sign-in — the server
 * logs loudly and treats it as absent until it is repaired through the
 * surface.
 */
export async function isPasswordChangeForced(ctx: Ctx): Promise<boolean> {
  try {
    const accountId = filesAccountId(ctx);
    if (!accountId) return false;
    const { file } = await findAppFileAt(ctx, accountId, PASSWORD_CHANGE_DIRECTIVE);
    if (!file) return false;
    let text: string;
    try {
      text = await downloadBlobText(
        ctx,
        accountId,
        String(file.blobId),
        typeof file.type === "string" && file.type ? file.type : "application/json",
      );
    } catch (err) {
      // The node vanished between the listing and the download: not forced.
      if (err instanceof UpstreamError && err.status === 404) return false;
      throw err;
    }
    const parsed = JSON.parse(text) as { setAt?: unknown; setBy?: unknown };
    if (typeof parsed.setAt === "string" && typeof parsed.setBy === "string") return true;
    console.warn(
      `[gilbert] ${PASSWORD_CHANGE_DIRECTIVE} in ${ctx.username}'s app folder is corrupt; treating it as absent (ADR 0001)`,
    );
    return false;
  } catch (err) {
    console.warn(
      `[gilbert] could not read the forced-password-change directive for ${ctx.username}:`,
      (err as Error).message,
    );
    return false;
  }
}

/** The account's own `gilbert` app folder, creating it when missing. */
/**
 * Write (or refresh) the directive naming `setBy`, the administrator who
 * set it. Creates the account's `gilbert` app folder when it does not exist
 * yet, exactly as the client would when saving its own state.
 */
export async function setPasswordChangeDirective(ctx: Ctx, setBy: string): Promise<void> {
  const accountId = filesAccountId(ctx);
  if (!accountId)
    throw new AccountError(
      "This account has no Files account to hold the directive.",
      502,
      "upstream",
    );
  await writeAppFile(ctx, accountId, PASSWORD_CHANGE_DIRECTIVE, {
    setAt: new Date().toISOString(),
    setBy,
  });
}

/**
 * Remove the directive file from the principal's own app folder. Nothing to
 * do (and nothing done) when it is not there.
 */
export async function clearPasswordChangeDirective(ctx: Ctx): Promise<void> {
  const accountId = filesAccountId(ctx);
  if (!accountId) return;
  const { folderId, file } = await findAppFileAt(
    ctx,
    accountId,
    PASSWORD_CHANGE_DIRECTIVE,
  );
  if (!folderId || !file?.id) return;
  await destroyAppNode(ctx, accountId, String(file.id));
}

/* ------------------------------------------------------------------ */
/* Group label catalog (ADR 0005)                                     */
/* ------------------------------------------------------------------ */

/**
 * A group's label catalog, as its one reader on this tier sees it.
 *
 * Three answers, because they are three different things a caller must not
 * conflate — and a caller about to write would: a group that has no catalog,
 * a catalog whose entries are what the document says they are, and a document
 * that is there but that the validator refuses. Read as `entries | null`, the
 * third one becomes "nothing stored" and a writer overwrites whatever a person
 * put there. Its entries are checked through `isLabelCatalog` rather than
 * returned as they were found: this is the document the agent's keyword guard
 * reads, and a keyword nobody can render is a label nobody sees.
 */
export type GroupLabelsRead =
  | { state: "absent" }
  | { state: "catalog"; labels: LabelCatalogEntry[] }
  | { state: "unreadable" };

export async function readGroupLabels(
  ctx: Ctx,
  accountId: string,
): Promise<GroupLabelsRead> {
  if (!accountId) return { state: "absent" };
  const { file } = await findAppFileAt(ctx, accountId, GROUP_LABELS_FILE);
  if (!file) return { state: "absent" };
  try {
    const text = await downloadBlobText(
      ctx,
      accountId,
      String(file.blobId),
      "application/json",
      GROUP_LABELS_FILE,
    );
    const parsed: unknown = JSON.parse(text);
    return isLabelCatalog(parsed)
      ? { state: "catalog", labels: parsed.labels }
      : { state: "unreadable" };
  } catch {
    return { state: "absent" };
  }
}

/** Write (or replace) a group's label catalog, creating the app folder as needed. */
export async function writeGroupLabels(
  ctx: Ctx,
  accountId: string,
  labels: unknown[],
): Promise<void> {
  if (!accountId)
    throw new AccountError(
      "This account has no Files account to hold the label catalog.",
      502,
      "upstream",
    );
  await writeAppFile(ctx, accountId, GROUP_LABELS_FILE, { labels });
}
