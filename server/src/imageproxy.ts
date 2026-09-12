import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { config } from "./config.js";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const UA = "Mozilla/5.0 (compatible; gilbert-image-proxy)";

export function isPrivateAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const [a, b, c] = addr.split(".").map(Number) as [number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    // Benchmarking (198.18.0.0/15), IETF protocol assignments (192.0.0.0/24)
    // and the deprecated 6to4 relay anycast (192.88.99.0/24). Not residential
    // space, but every one of them is a route to somewhere that is not the
    // public internet.
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a >= 224) return true;
    return false;
  }
  if (v === 6) {
    const lower = addr.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    // fe80::/10 link-local, fec0::/10 site-local (deprecated, still routed)
    // and fc00::/7 unique-local, in any spelling of the first hextet.
    if (/^fe[89a-f]/.test(lower) || lower.startsWith("fc") || lower.startsWith("fd"))
      return true;
    if (lower.startsWith("ff")) return true; // multicast
    // Tunnels that carry an IPv4 address inside an IPv6 one, and so reach the
    // private IPv4 space above through an address that looks public: 6to4
    // (2002::/16) keeps it in bits 17-48, Teredo (2001:0000::/32) in the last
    // 32. Both /32 spellings are written out, since a compressed address
    // reads as `2001::` and an expanded one as `2001:0:`.
    if (lower.startsWith("2002:")) return true;
    if (lower.startsWith("2001:0:") || lower.startsWith("2001::")) return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    if (lower.startsWith("64:ff9b:")) return true; // NAT64, reaches IPv4 space
    return false;
  }
  return true;
}

export class BlockedTarget extends Error {}

/**
 * Settle on one address for `hostname` and refuse it if it is somewhere we
 * should not be reaching.
 */
async function resolveAllowed(hostname: string): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedTarget(host);
    return host;
  }
  const addrs = await lookup(host, { all: true });
  if (!addrs.length) throw new BlockedTarget(host);
  // Every answer has to be acceptable: one bad record is enough to mean the
  // name is not something we should be fetching at all.
  for (const a of addrs)
    if (isPrivateAddress(a.address)) throw new BlockedTarget(a.address);
  return addrs[0]!.address;
}

/**
 * Fetch, connecting to `addr` rather than whatever DNS says at the moment the
 * socket opens.
 *
 * Checking a name and then handing the name to a fetching library leaves a gap:
 * the library resolves again, and an attacker who controls the zone can answer
 * differently the second time — the first answer passes the check, the second
 * points at localhost. Pinning the address closes the gap. TLS is unaffected:
 * the certificate is still validated against the hostname, which is what
 * `servername` and the Host header carry.
 */
export function fetchPinned(
  url: URL,
  addr: string,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  const family = isIP(addr) === 6 ? 6 : 4;
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        /*
         * Called instead of a real resolution, so the socket goes exactly where
         * we decided it should. Node asks for every address at once when it is
         * picking a family itself (autoSelectFamily), and for a single one
         * otherwise; answer in whichever shape was asked for.
         */
        lookup: (
          _hostname: string,
          opts: { all?: boolean },
          cb: (
            err: Error | null,
            address: string | { address: string; family: number }[],
            family?: number,
          ) => void,
        ) => (opts?.all ? cb(null, [{ address: addr, family }]) : cb(null, addr, family)),
        servername: isIP(url.hostname) ? undefined : url.hostname,
        // A pooled socket is keyed by host and port, not by the address we
        // pinned, so a connection opened earlier would be reused and the pin
        // never consulted. Take a fresh socket every time.
        agent: false,
        headers: {
          accept: "image/avif,image/webp,image/*,*/*;q=0.8",
          "user-agent": UA,
          host: url.host,
        },
        signal,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Gmail-style remote content proxy: hides the reader's IP address and
 * user-agent from tracking pixels, and blocks SSRF to internal networks.
 */
/** Why a guarded fetch refused, in the words the handlers answer with. */
export type SafeFetchError =
  | "bad_url"
  | "bad_scheme"
  | "forbidden_target"
  | "dns_failure"
  | "fetch_failed"
  | "bad_redirect";

export interface SafeFetchResult {
  res: IncomingMessage;
  /** The URL actually fetched, which is not the one asked for if it redirected. */
  url: URL;
  done: () => void;
}

/**
 * Fetch a URL nobody here chose, with every check the image proxy has always
 * made — and made in one place, because a second copy of an SSRF guard is how
 * one of them ends up missing a case.
 *
 * The name is resolved first and *every* answer has to be acceptable, the
 * connection is pinned to the address that was checked, and each redirect hop
 * is re-resolved and re-pinned rather than handed to the socket library.
 */
export async function safeFetch(
  raw: string,
  timeoutMs = 15_000,
): Promise<SafeFetchResult | SafeFetchError> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "bad_url";
  }
  // webcal: is an http URL wearing a different word; nothing else is allowed.
  if (url.protocol === "webcal:")
    url = new URL(`https:${raw.slice(raw.indexOf(":") + 1)}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") return "bad_scheme";
  if (url.username || url.password) return "bad_url";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const done = () => clearTimeout(timer);
  try {
    let addr: string;
    try {
      addr = await resolveAllowed(url.hostname);
    } catch (err) {
      done();
      return err instanceof BlockedTarget ? "forbidden_target" : "dns_failure";
    }
    let res = await fetchPinned(url, addr, controller.signal);

    let hops = 0;
    while (
      res.statusCode &&
      [301, 302, 303, 307, 308].includes(res.statusCode) &&
      hops < 3
    ) {
      const loc = res.headers.location;
      if (!loc) break;
      res.resume(); // discard the redirect body
      const next = new URL(loc, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        done();
        return "bad_redirect";
      }
      try {
        addr = await resolveAllowed(next.hostname);
      } catch (err) {
        done();
        return err instanceof BlockedTarget ? "forbidden_target" : "dns_failure";
      }
      url = next;
      res = await fetchPinned(url, addr, controller.signal);
      hops++;
    }
    return { res, url, done };
  } catch {
    done();
    return "fetch_failed";
  }
}

const SAFE_FETCH_STATUS: Record<SafeFetchError, number> = {
  bad_url: 400,
  bad_scheme: 400,
  bad_redirect: 400,
  forbidden_target: 403,
  dns_failure: 502,
  fetch_failed: 502,
};

export function safeFetchStatus(err: SafeFetchError): number {
  return SAFE_FETCH_STATUS[err];
}

/**
 * Hand an upstream image to the client.
 *
 * The upstream's `Content-Length` is deliberately *not* forwarded. The limiter
 * below can end the stream early, and a declared length over a body that was
 * cut short is a response the client cannot tell from a complete one -- issue
 * #76, which is why the other proxy routes decide this in
 * `forwardedContentLength`. Left off, the response goes out chunked, which
 * promises nothing and so cannot lie.
 *
 * `signal` is the client's. An aborted request means nobody downstream is
 * reading any more, so the upstream response is destroyed here rather than
 * left streaming megabytes of image into a dead socket.
 */
export function imageResponse(
  res: IncomingMessage,
  type: string,
  signal: AbortSignal,
  done: () => void,
): Response {
  // Enforce the size limit while streaming.
  let total = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller2) {
      total += chunk.byteLength;
      if (total > MAX_IMAGE_BYTES) controller2.error(new Error("too large"));
      else controller2.enqueue(chunk);
    },
  });
  const abandoned = () => {
    res.destroy();
    done();
  };
  if (signal.aborted) abandoned();
  else signal.addEventListener("abort", abandoned, { once: true });
  res.on("close", () => {
    signal.removeEventListener("abort", abandoned);
    done();
  });
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
  return new Response(body.pipeThrough(limiter), { status: 200, headers });
}

export async function imageProxyHandler(c: Context) {
  if (!config.imageProxy) return c.json({ error: "disabled" }, 404);
  const got = await safeFetch(c.req.query("url") ?? "");
  if (typeof got === "string") return c.json({ error: got }, safeFetchStatus(got) as 400);
  const { res, done } = got;
  if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
    done();
    res.resume();
    return c.json({ error: "fetch_failed" }, 502);
  }
  const type = (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (!type.startsWith("image/") || type === "image/svg+xml") {
    done();
    res.resume();
    return c.json({ error: "not_image" }, 415);
  }
  const len = Number(res.headers["content-length"] ?? "0");
  if (len > MAX_IMAGE_BYTES) {
    done();
    res.resume();
    return c.json({ error: "too_large" }, 413);
  }
  return imageResponse(res, type, c.req.raw.signal, done);
}
