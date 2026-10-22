/**
 * The JMAP proxy and everything that rides beside it: blob upload and
 * download, the push stream, and the image and calendar privacy proxies.
 *
 * The data path — `/api/jmap`, `/upload`, `/blob`, `/events`, `/image` and
 * `/ics` — is where the client's own mail, files and calendars are proxied to
 * Stalwart, rate-limited per session.
 */

import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { gateAdministration } from "../adminGate.js";
import { config } from "../config.js";
import { icsProxyHandler } from "../icsproxy.js";
import { imageProxyHandler } from "../imageproxy.js";
import { followAccount, attach as pushAttach } from "../push.js";
import { forgetRemembered } from "../requestMemory.js";
import { writesTheTree } from "../shared/appFolder.js";
import { CAPABILITIES } from "../shared/capabilities.js";
import { isInlineSafe } from "../shared/media.js";
import { withoutBidiControls } from "../shared/text.js";
import {
  absoluteUpstream,
  expandTemplate,
  forgetUpstreamSession,
  sessionUpstream,
} from "../upstream.js";
import type { Env } from "./shared.js";
import {
  acquireEventsStreamSlot,
  adminAllows,
  administrationRefusal,
  apiRateLimited,
  blobContentType,
  byteCap,
  cookiePath,
  forwardedContentLength,
  GatedBudgetError,
  GatedSizeError,
  gatedReads,
  MAX_GATED_PER_SESSION,
  MAX_GATED_REQUEST,
  passthrough,
  pushOrigin,
  readGated,
  relayPushRaw,
  requireSession,
  resolveInstallationAccount,
  SSE_HEADERS,
  securityHeadersFor,
  sessions,
  upstreamFailure,
} from "./shared.js";

/**
 * Whether the session's own JMAP session holds this account.
 *
 * The upload and download routes take an account id from the client and put it
 * straight into the upstream template. Stalwart checks the permission itself,
 * but it is the only check there is: every other surface that names another
 * account is bounded in Gilbert, and this one answers the same way.
 */
function sessionHoldsAccount(
  session: { accounts?: Record<string, unknown> },
  accountId: string,
): boolean {
  return Object.hasOwn(session.accounts ?? {}, accountId);
}

export function registerMailRoutes(api: Hono<Env>): void {
  // ---------- JMAP API proxy ----------
  api.post("/jmap", requireSession, apiRateLimited, async (c) => {
    const session = c.get("session");
    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) {
      return c.json({ error: "unsupported_media_type" }, 415);
    }
    /*
     * For a session that may not administer -- administration switched off on
     * this installation, or a device not marked as the person's own -- the body
     * is read and checked before it goes anywhere (ADR 0015). A session that may
     * administer streams straight through as it always has, and pays nothing for
     * this.
     */
    let body: ReadableStream<Uint8Array> | string | null = c.req.raw.body;
    if (!adminAllows(session)) {
      /*
       * Bounded three ways, because a body that is read is a body held: at most
       * this many checked reads per session at once, at most
       * `MAX_GATED_REQUEST` each, and at most `GATED_BUDGET` across everyone.
       * The third is what makes a burst cheap to refuse -- a 503 says try
       * again, where letting it through costs the process.
       */
      const held = gatedReads.get(session.id) ?? 0;
      if (held >= MAX_GATED_PER_SESSION) {
        c.header("Retry-After", "1");
        return c.json({ error: "rate_limited" }, 429);
      }
      gatedReads.set(session.id, held + 1);
      let raw: string;
      try {
        if (Number(c.req.header("content-length") ?? "0") > MAX_GATED_REQUEST)
          return c.json({ error: "too_large" }, 413);
        // Counted as it arrives: a chunked body carries no length to refuse up front.
        raw = c.req.raw.body ? await readGated(c.req.raw.body) : "";
      } catch (err) {
        if (err instanceof GatedBudgetError) {
          c.header("Retry-After", "1");
          return c.json({ error: "busy" }, 503);
        }
        if (err instanceof GatedSizeError) return c.json({ error: "too_large" }, 413);
        /*
         * Anything else is the stream itself failing -- the client aborting
         * mid-body, a transport error -- not a size violation. Answering 413
         * for it would name a cause that is not true; the detail stays in the
         * log and the caller is told the failure is upstream.
         */
        console.error("[gilbert] gated read failed:", err);
        return c.json({ error: "upstream_error" }, 502);
      } finally {
        const left = (gatedReads.get(session.id) ?? 1) - 1;
        if (left > 0) gatedReads.set(session.id, left);
        else gatedReads.delete(session.id);
      }
      const gate = gateAdministration(raw);
      if (!gate.ok) {
        if (!gate.method)
          return c.json({ error: "bad_request", message: "Not a JMAP request." }, 400);
        return administrationRefusal(c, config.administration, gate.method);
      }
      body = gate.body;
    }
    try {
      const upstream = await sessionUpstream(session);
      /*
       * This route forwards a call the browser built, so it is a writer of this
       * process exactly as a helper's write is -- and it is the path the web
       * client's own `FileNode/set` takes (`store/files/shared.ts`), not a rare one.
       * `JmapClient` forgets the remembered levels on the writes it sends; a
       * write forwarded here must do the same, or an agent pass running beside
       * this request is handed a listing from before the person saved the file.
       *
       * The body is untrusted text, so the question is asked without trusting
       * its shape: anything naming the FileNode set is enough to forget, and a
       * body that cannot be read for the name is not read for anything else
       * either -- the upstream decides whether the call is well formed.
       */
      if (typeof body === "string" && writesTheTree(body)) forgetRemembered();
      const res = await fetch(absoluteUpstream(upstream.apiUrl, upstream.baseUrl), {
        method: "POST",
        headers: {
          authorization: session.authorization,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        duplex: "half",
        signal: AbortSignal.timeout(config.upstreamTimeout),
      });
      if (res.status === 401) {
        sessions.destroy(session.id);
        forgetUpstreamSession(session.id);
        deleteCookie(c, config.cookieName, { path: cookiePath() });
        return c.json({ error: "unauthenticated" }, 401);
      }
      return passthrough(res);
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- Blob upload ----------
  api.post("/upload/:accountId", requireSession, apiRateLimited, async (c) => {
    const session = c.get("session");
    const accountId = c.req.param("accountId");
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > config.maxUploadBytes) return c.json({ error: "too_large" }, 413);
    // content-length is absent on a chunked request, so the header alone is a
    // suggestion; count the bytes as they go past.
    const body = c.req.raw.body
      ? c.req.raw.body.pipeThrough(byteCap(config.maxUploadBytes))
      : null;
    try {
      const upstream = await sessionUpstream(session);
      if (!sessionHoldsAccount(upstream, accountId))
        return c.json({ error: "not_found" }, 404);
      const url = absoluteUpstream(
        expandTemplate(upstream.uploadUrl, { accountId }),
        upstream.baseUrl,
      );
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: session.authorization,
          "content-type": c.req.header("content-type") ?? "application/octet-stream",
          accept: "application/json",
        },
        body,
        duplex: "half",
        signal: AbortSignal.timeout(Math.max(config.upstreamTimeout, 5 * 60_000)),
      });
      return passthrough(res);
    } catch (err) {
      // The cap fired mid-stream (no content-length, or one that lied): that
      // is an oversized upload, not an unreachable mail server.
      if (err instanceof Error && err.message === "upload too large")
        return c.json({ error: "too_large" }, 413);
      return upstreamFailure(c, err);
    }
  });

  // ---------- Blob download ----------
  api.get("/blob/:accountId/:blobId/:name", requireSession, apiRateLimited, async (c) => {
    const session = c.get("session");
    const { accountId, blobId, name } = c.req.param();
    const accept = c.req.query("accept") ?? "application/octet-stream";
    const inline = c.req.query("inline") === "1";
    const range = c.req.header("range");
    try {
      const upstream = await sessionUpstream(session);
      if (!sessionHoldsAccount(upstream, accountId))
        return c.json({ error: "not_found" }, 404);
      const url = absoluteUpstream(
        expandTemplate(upstream.downloadUrl, { accountId, blobId, name, type: accept }),
        upstream.baseUrl,
      );
      const res = await fetch(url, {
        // Ask for the bytes as they are. undici would otherwise negotiate gzip
        // on our behalf and hand back a decompressed body whose content-length
        // header still describes the compressed one -- see forwardedContentLength.
        //
        // A PDF viewer or a video element asks for pieces, so that request is
        // passed on: a server that ignores it answers with the whole file,
        // which is what happened before this and still works. Only a header
        // that reads as a byte range is forwarded -- it is somebody else's
        // syntax, and one that does not parse is dropped rather than passed on
        // unread.
        headers: {
          authorization: session.authorization,
          "accept-encoding": "identity",
          ...(range && /^bytes=[\d,\s-]+$/.test(range) ? { range } : {}),
        },
        signal: AbortSignal.timeout(Math.max(config.upstreamTimeout, 5 * 60_000)),
      });
      // A 401 is the credential, not the blob: sign the reader out the same
      // way `/api/jmap` does, so the browser's own 401 handling for a blob
      // download is reachable rather than masked as a server error.
      if (res.status === 401) {
        sessions.destroy(session.id);
        forgetUpstreamSession(session.id);
        deleteCookie(c, config.cookieName, { path: cookiePath() });
        return c.json({ error: "unauthenticated" }, 401);
      }
      if (res.status === 416) return c.body(null, 416);
      if (!res.ok) return c.json({ error: "not_found" }, res.status === 404 ? 404 : 502);
      const headers = new Headers();
      const type = blobContentType(res.headers.get("content-type"), accept, name);
      headers.set("Content-Type", type);
      const cl = forwardedContentLength(res.headers);
      if (cl) headers.set("Content-Length", cl);
      const partial = res.status === 206 && res.headers.get("content-range");
      if (partial) headers.set("Content-Range", partial);
      /*
       * Said here because Stalwart does not say it. It honours a single byte
       * range but sends no `Accept-Ranges` (0.16.22, checked live on
       * 2026-09-16), and a PDF viewer reads a file in pieces only when the first
       * response advertises that it can. A server that ignores a range sends the
       * whole file with a 200, which the browser takes just as well -- so this
       * says what the client may try, not what every request will get.
       */
      headers.set("Accept-Ranges", "bytes");
      const safeInline = inline && isInlineSafe(type);
      headers.set(
        "Content-Disposition",
        `${safeInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(withoutBidiControls(name))}`,
      );
      headers.set("X-Content-Type-Options", "nosniff");
      // Sandbox everything except the browser's built-in PDF viewer (which needs scripts to render).
      if (securityHeadersFor(type, safeInline) === "SAMEORIGIN") {
        /*
         * The one response on the server that may be framed.
         *
         * A PDF is shown in an iframe -- it is its own document and the app
         * cannot lay it out -- and the blanket X-Frame-Options: DENY above
         * blocked that, so the preview showed Chrome's "refused to connect"
         * instead of the file. SAMEORIGIN, not a relaxation to any site: the
         * frame is ours, on our origin, and the app's own CSP already says
         * frame-src 'self'. Nothing else here is framed, so nothing else asks.
         */
        headers.set("X-Frame-Options", "SAMEORIGIN");
      } else {
        headers.set(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        );
      }
      // Kept out of the browser's disk cache on a device that is not the
      // person's own: signing out wipes what the app stores, not that.
      headers.set(
        "Cache-Control",
        session.remember ? "private, max-age=3600" : "no-store",
      );
      return new Response(res.body, { status: res.status === 206 ? 206 : 200, headers });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- Push (Server-Sent Events) ----------
  api.get("/events", requireSession, async (c) => {
    const session = c.get("session");
    // One session may hold only EVENTS_STREAMS_LIMIT streams; counting every
    // branch (fan-out, raw relay, direct relay) keeps the upstream sockets a
    // session can pin bounded. The slot is released when the response ends or
    // the request aborts, whichever comes first.
    const release = acquireEventsStreamSlot(session.id);
    if (!release) return c.json({ error: "too_many_streams" }, 429);
    const out = (c.env as { outgoing: import("node:http").ServerResponse }).outgoing;
    out.once("close", release);
    c.req.raw.signal.addEventListener("abort", release, { once: true });
    const types = c.req.query("types") ?? "*";
    const closeafter = c.req.query("closeafter") ?? "no";
    const ping = c.req.query("ping") ?? "30";
    try {
      const upstream = await sessionUpstream(session);
      const url = absoluteUpstream(
        expandTemplate(upstream.eventSourceUrl, { types, closeafter, ping }),
        upstream.baseUrl,
      );
      // Subscribe mode: if this account's subscription is verified, the tab is
      // served by fan-out and holds nothing upstream. Otherwise it gets its own
      // relay, and is moved to fan-out the moment the account verifies.
      const accountId = upstream.primaryAccounts?.[CAPABILITIES.mail];
      const origin = pushOrigin(c);
      /*
       * The tab also follows the installation's own account (ADR 0024).
       *
       * A step an administrator checks on the installation's checklist is
       * written in the Master's account, which no member is a member of, so a
       * member's own subscription never covers it and the fan-out is what
       * reaches them. The subscription is the installation's, made with the
       * credential the deployment already holds and never the tab's; the frame
       * is Stalwart's own StateChange -- an account and a state, no data -- and
       * the reader answers it by re-reading through its own route, which
       * decides what it may see.
       *
       * One resolution answers both this and the session payload (`ADR 0024`'s
       * `installationAccount`), so the id the client filters on and the account
       * subscribed here cannot be different accounts.
       *
       * Resolved before the branch so the fan-out below always has it. The
       * relay path does not follow it directly -- a stream attached to two
       * fan-outs while the relay still writes would interleave frames -- and
       * instead reconnects onto this branch once the subscription verifies,
       * which is what brings the follow. The direct relay (`RAW_PUSH_RELAY=0`)
       * neither reconnects nor follows, and in relay mode there is no fan-out
       * to land on: those tabs hear the switch only through their read.
       */
      const installation = await resolveInstallationAccount(session);
      const follow = installation
        ? {
            id: installation.id,
            username: installation.master.username,
            authorization: installation.master.authorization,
          }
        : null;
      if (
        accountId &&
        pushAttach(session.username, accountId, session.authorization, out, origin)
      ) {
        /*
         * Headers before the first await: the tab is already in the fan-out,
         * and a StateChange (or the sweeper's ping) landing before this write
         * would send an implicit 200 with no `text/event-stream`, after which
         * `writeHead` throws and the browser reconnects in a loop.
         */
        out.writeHead(200, SSE_HEADERS);
        out.flushHeaders();
        out.write(": subscribed\n\n");
        if (follow)
          followAccount(follow.username, follow.id, follow.authorization, out, origin);
        return RESPONSE_ALREADY_SENT;
      }
      if (config.rawPushRelay)
        return relayPushRaw(c, url, session.authorization, session.username);
      const controller = new AbortController();
      c.req.raw.signal.addEventListener("abort", () => controller.abort());
      const res = await fetch(url, {
        headers: { authorization: session.authorization, accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return c.json({ error: "upstream_error" }, 502);
      const headers = new Headers({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      return new Response(res.body, { status: 200, headers });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- Remote image privacy proxy ----------
  api.get("/image", requireSession, apiRateLimited, imageProxyHandler);
  // Behind the session for the same reason the image proxy is: an open fetcher
  // on someone else's server is a gift to whoever finds it.
  api.get("/ics", requireSession, apiRateLimited, icsProxyHandler);
}
