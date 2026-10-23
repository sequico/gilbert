/**
 * The failure one of this product's own classes answers with, and the fixed
 * sentence every upstream failure carries.
 *
 * The machine `error` code is the contract the client reads; the sentence
 * beside it is ours and fixed rather than the mail server's own, while the
 * detail is logged server-side.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AccountError } from "../../account.js";
import { AppFolderError } from "../../appFolder.js";
import { GroupAccessError } from "../../groupAccess.js";
import { UpstreamError } from "../../upstream.js";

/**
 * The fixed sentence an upstream failure carries, one per machine code.
 *
 * `upstreamFailure` answers every authenticated caller, so it never repeats the
 * mail server's own message: the `error` code says which kind of failure it was
 * and this says it in words, while the detail is logged server-side.
 */
function upstreamFailureMessage(error: string): string {
  switch (error) {
    case "invalid_credentials":
      return "The mail server rejected these credentials.";
    case "forbidden":
      return "The mail server refused this request for this account.";
    case "not_found":
      return "The mail server has nothing at that address.";
    case "upstream_quota":
      return "The mail server's upload allowance is full right now, so nothing was written. Try again later.";
    default:
      return "The mail server could not complete the request. This is not a problem with your password.";
  }
}

/**
 * The answer to a failure talking to the mail server: the machine `error` code
 * is the contract the client reads, and the sentence beside it is fixed (see
 * `upstreamFailureMessage`) rather than the mail server's own message. The one
 * exception is a 4xx this server raised about a path — an `AppFolderError`
 * carries its own code and sentence, both ours — which is answered as it
 * stands.
 */
export function upstreamFailure(c: Context, err: unknown) {
  /*
   * This server's own refusal about a path is not an upstream failure: an
   * `AppFolderError` carries its own code and status (`bad_path`, 400), and
   * answering it as 502 both misnames the cause and tells the caller to retry
   * something that will never work. Only the 4xx half is taken here — a 5xx
   * from the same class is an upstream failure wearing it, and keeps the fixed
   * sentence every other upstream failure gets, with the detail in the log.
   */
  if (err instanceof AppFolderError && err.status >= 400 && err.status < 500)
    return c.json(...refusal(err));
  if (err instanceof UpstreamError) {
    // A 403 is a permission, a 404 a missing object and a 429 an exhausted
    // allowance: the code keeps the reason the mail server distinguished, rather
    // than collapsing all of them into a generic upstream failure.
    const status =
      err.status === 401 || err.status === 403 || err.status === 404 || err.status === 429
        ? err.status
        : 502;
    const error =
      status === 401
        ? "invalid_credentials"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not_found"
            : status === 429
              ? "upstream_quota"
              : "upstream_error";
    // The message can carry a refusal detail read from the mail server's own
    // answer; it belongs in the log, not in the response.
    console.error(`[gilbert] upstream failure (${status}):`, err.message);
    return c.json({ error, message: upstreamFailureMessage(error) }, status);
  }
  const name = (err as Error)?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") {
    return c.json(
      {
        error: "upstream_timeout",
        message:
          "The mail server did not respond in time. This is not a problem with your password.",
      },
      504,
    );
  }
  console.error("[gilbert] upstream failure:", err);
  return c.json(
    {
      error: "upstream_error",
      message:
        "Could not reach the mail server. This is not a problem with your password.",
    },
    502,
  );
}

/**
 * The answer to a group the caller does not hold, and the 403 that carries it.
 *
 * Seventeen guards ask this question — the group access the agent surfaces
 * resolve, the member views beside them and the identity assignment — and each
 * wrote the two fields out beside its own narrowing. What they carry is one
 * shape: a code the surface composes its sentence from, and the need it was
 * refused for.
 */
export const groupDenial = (c: Context, denied: { error: string; need: string }) =>
  c.json({ error: denied.error, need: denied.need }, 403);

/**
 * The answer to a **thrown** group-access refusal, or upstream's.
 *
 * `groupDenial` above is the door's own *return* — a group the Master is not
 * granted on, with the section that was asked for. This is the same refusal
 * thrown rather than returned: the Master could not be reached as the
 * installation at all, so the reason carries the server's own detail where it
 * has one. The codes are the client's to speak (`@/lib/groupAccess`,
 * `@/lib/agentErrors`), never a sentence from here.
 */
export const groupAccessFailure = (c: Context, err: unknown) => {
  if (!(err instanceof GroupAccessError)) return null;
  const { code } = err.reason;
  const detail = "detail" in err.reason ? err.reason.detail : undefined;
  return c.json(
    detail ? { error: code, detail } : { error: code },
    err.status as ContentfulStatusCode,
  );
};

/**
 * The body and status of a refusal from one of this product's own error classes.
 *
 * Six surfaces answer with it — identities, the system Sieve registry, the
 * knowledge base, workorders, the account itself and the installation
 * document — and each had the shape written out beside the refusal it was
 * making. A copy of a refusal shape is a copy that can drift, and the five that
 * differ only in the class they test are exactly the ones that would: what
 * they share is `code`, `message` and `status`, and that is all this reads.
 *
 * Hono types a status as a union of literals; a class carries the number its
 * own code chose (400 for a refusal, 401/403 for a boundary, 409 for a
 * conflict, 413 for a document too large, 502 for an upstream one), so it is
 * narrowed to that type rather than asserted as one particular value. Every
 * surface that answers with a status it did not type narrows it this way.
 */
export const refusal = (err: { code: string; message: string; status: number }) =>
  [
    { error: err.code, message: err.message },
    err.status as ContentfulStatusCode,
  ] as const;

/**
 * The dispatcher a surface answers a failure with: its own class, or upstream's.
 *
 * Five surfaces test one error class each and hand every other failure to the
 * upstream mapper, and the two lines were written out beside each
 * `instanceof`. What they share is the decision — this class is ours, anything
 * else is the mail server's — so the dispatcher is made from the class rather
 * than beside it. A surface whose failure is not that shape keeps its own.
 */
export const failureFor =
  (own: new (...args: never[]) => { code: string; message: string; status: number }) =>
  (c: Context, err: unknown) =>
    err instanceof own ? c.json(...refusal(err)) : upstreamFailure(c, err);

export const accountFailure = failureFor(AccountError);
