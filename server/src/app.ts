/**
 * The app: one place that decides the order a request is judged in, and
 * nothing else.
 *
 * `createApp` binds the session store, builds a Hono app, wires the middleware
 * in the order a request meets it, and hands each route group the instance to
 * register its own paths on (`server/src/routes/`). Everything the groups
 * share — the session store and its readers, the rate limiters, the CSRF and
 * body guards, the forced-password-change door and the administrator gate, the
 * upstream failure every route answers with — is one definition in
 * `routes/shared.ts`, which `app.ts` and the groups both read.
 */
import { Hono } from "hono";
import { config } from "./config.js";
import { MAX_PUSH_BODY_BYTES, receive as pushReceive } from "./push.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerContactRoutes } from "./routes/contacts.js";
import { registerGroupLabelRoutes } from "./routes/groupLabels.js";
import { registerIdentityRoutes } from "./routes/identities.js";
import { registerInstallationRoutes } from "./routes/installation.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { registerMailRoutes } from "./routes/mail.js";
import { registerOutboundRoutes } from "./routes/outbound.js";
import type { Env } from "./routes/shared.js";
import {
  bindSessions,
  compressResponses,
  csrfGuard,
  forcedPasswordDoor,
  securityHeaders,
  smallBodies,
} from "./routes/shared.js";
import { registerStaticRoutes } from "./routes/static.js";
import { registerWorkorderRoutes } from "./routes/workorder.js";

/**
 * The names callers reach for on this module.
 *
 * The boot imports the session store and the two hooks that install it
 * (`server/src/index.ts`), and the tests reach for the store, the event-stream
 * counter and the proxy's own readers. Those live in `routes/shared.ts` with
 * everything else the routes share; these lines are the door callers use, so a
 * boot or a test does not have to know where the routes keep them.
 */
export type { PublishJob, PublishOutcome } from "./routes/shared.js";
export {
  acquireEventsStreamSlot,
  blobContentType,
  clientIp,
  EVENTS_STREAMS_LIMIT,
  forwardedContentLength,
  securityHeadersFor,
  sessionDocumentIo,
  sessions,
  upstreamFailure,
  useDurableSessions,
} from "./routes/shared.js";

/**
 * `basePath` is a parameter rather than read straight from the config so the
 * tests can mount the same app twice, at the root and under a prefix, without
 * re-importing the module to change one environment variable.
 */
export function createApp(basePath = config.basePath): Hono<Env> {
  // The store this app will serve with, bound before a single route exists --
  // the whole of what makes the in-memory default impossible to reach without
  // asking for it (see `bindSessions`).
  bindSessions();

  const app = new Hono<Env>();
  app.use("*", securityHeaders);
  app.use("*", compressResponses(basePath));

  const api = new Hono<Env>();
  api.use("*", csrfGuard);
  api.use("*", smallBodies);
  api.use("*", forcedPasswordDoor(basePath));

  /*
   * Stalwart's push delivery. Authenticated by the token in the path -- 32
   * random bytes, one per account, known only to us and to Stalwart -- and by
   * nothing else, since Stalwart carries no credential when it POSTs. An
   * unknown token is a 404 that looks like any other. See push.ts.
   */
  app.post(`${basePath}/api/push/:token`, async (c) => {
    if (
      !(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")
    )
      return c.body(null, 415);
    // The declared length is the cheap first refusal; `pushReceive` bounds what
    // it is handed, and the two share one number so they cannot drift.
    const len = Number(c.req.header("content-length") ?? "0");
    if (!len || len > MAX_PUSH_BODY_BYTES) return c.body(null, 413);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.body(null, 400);
    }
    return c.body(
      null,
      (await pushReceive(c.req.param("token"), body)) as 200 | 400 | 404 | 413 | 500,
    );
  });

  registerAccountRoutes(api);
  registerAdminRoutes(api);
  registerAgentRoutes(api);
  registerGroupLabelRoutes(api);
  registerIdentityRoutes(api);
  registerContactRoutes(api);
  registerKnowledgeRoutes(api);
  registerOutboundRoutes(api);
  registerWorkorderRoutes(api);
  registerInstallationRoutes(api);
  registerMailRoutes(api);

  /*
   * What an unmatched `/api/*` path answers, as a route rather than `notFound`.
   * `app.route()` copies a sub-app's routes into the parent but not its
   * not-found handler, so a `notFound` here never ran: an unmatched `GET`
   * fell through to the static catch-all below and came back as the SPA
   * shell, and a non-`GET` as Hono's plain-text 404 — neither the JSON error
   * contract `/api/*` answers everywhere else. The catch-all is a real route
   * and does carry across.
   */
  api.all("*", (c) => c.json({ error: "not_found" }, 404));
  api.onError((err, c) => {
    console.error("[gilbert] api error:", err);
    return c.json({ error: "internal_error" }, 500);
  });

  app.route(`${basePath}/api`, api);

  registerStaticRoutes(app, basePath);
  return app;
}
