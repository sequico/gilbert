/**
 * The small helpers this tier's modules kept re-deriving, once each.
 *
 * Each one is a line or three, and each had grown a second copy in a second
 * module — the JMAP client built from a context, the Basic header for a
 * principal's own credential, the constant-time string comparison, the token
 * count a provider did or did not report, and the reading of Stalwart's
 * `SetError`. The copies had not drifted yet; that is the whole of the
 * argument, and it is the same argument SSOT makes everywhere: a rule with two
 * homes acquires two behaviours silently.
 *
 * `describeSetError` is the one that is not a copy by accident: the classifier
 * is Stalwart's, and only the sentences are the surface's — the administration
 * says "Stalwart", a person's own settings say "The mail server" — so the
 * sentences arrive as an argument and the classification stays in one place.
 */
import type { Ctx } from "./account.js";
import { JmapClient } from "./jmap.js";

/** The JMAP client for a request's own context. */
export function clientOf(ctx: Ctx): JmapClient {
  return new JmapClient(ctx);
}

/** The `Authorization` header a plain principal authenticates with. */
export function basicAuth(address: string, password: string): string {
  /* `btoa` over the UTF-8 bytes rather than `Buffer`: this module is read by
     files the client's program type-checks too, and a node built-in here pulls
     node's globals into that program. */
  const bytes = new TextEncoder().encode(`${address}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/** One count a provider reported, or null: a provider that says nothing says nothing. */
export function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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
