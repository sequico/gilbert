/**
 * The small helpers this tier's modules kept re-deriving, once each.
 *
 * `clientOf` is the JMAP client for a request's own context, and `basicAuth`
 * is re-exported from `shared/basicAuth.ts` — where the one implementation
 * lives, because the client's program reads it too. `describeSetError` is the
 * reading of Stalwart's `SetError`, and it is not a copy by accident: the
 * classifier is Stalwart's, and only the sentences are the surface's — the
 * administration says "Stalwart", a person's own settings say "The mail
 * server" — so the sentences arrive as an argument and the classification
 * stays in one place.
 */
import type { Ctx } from "./account.js";
import { JmapClient } from "./jmap.js";

export { basicAuth } from "./shared/basicAuth.js";

/** The JMAP client for a request's own context. */
export function clientOf(ctx: Ctx): JmapClient {
  return new JmapClient(ctx);
}

/** The shape Stalwart answers a refused `/set` with. */
export interface SetErrorShape {
  type?: string;
  description?: string;
  properties?: string[];
}

/** How a refusal reads on one surface, in that surface's own words. */
export interface SetErrorPhrases {
  /** What refused, as this surface names it: "Stalwart", "The mail server". */
  server: string;
  /** For `forbidden`, when the server said nothing more. */
  forbidden: string;
  /** For `overQuota`, where the surface has something to say; omitted otherwise. */
  overQuota?: string;
  /** How a list of rejected properties reads. */
  rejected: (properties: string[]) => string;
  /** How a rejected value with no property named reads. */
  rejectedValue: string;
}

/**
 * Stalwart's own words about a refusal, or this surface's when it said nothing.
 *
 * The `description` is the server's own sentence and is preferred wherever it
 * exists; everything below it is the fallback, which is why only the fallback
 * is translated per surface.
 */
export function describeSetError(err: SetErrorShape, phrases: SetErrorPhrases): string {
  if (err.description) return err.description;
  if (err.type === "forbidden") return phrases.forbidden;
  if (err.type === "overQuota" && phrases.overQuota) return phrases.overQuota;
  if (err.type === "invalidProperties") {
    return err.properties?.length
      ? phrases.rejected(err.properties)
      : phrases.rejectedValue;
  }
  return `${phrases.server} refused the change (${err.type ?? "error"}).`;
}
