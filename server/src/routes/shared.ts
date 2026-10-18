/**
 * The door every route group reads its shared helpers through.
 *
 * What every route needs and none of them owns: the session store and its
 * readers, the rate limiters, the CSRF and body guards, the forced-password-
 * change door and the administrator gate, the HTTP facts a request is judged
 * by, and the failure every route answers an upstream refusal with. The route
 * modules under `server/src/routes/` and `app.ts` itself read them from here,
 * so there is one definition and no copy of it.
 *
 * It defines nothing: each helper lives in the job-shaped module beside this
 * one under `server/src/routes/shared/`, and these lines re-export the same
 * names callers already import.
 *
 * Nothing here decides a path or a method: `app.ts` builds the app, wires the
 * middleware in order, and hands each route module the Hono instance to
 * register on.
 */

import type { PublishJob } from "../shared/publishJob.js";

/**
 * What a publish reports is the job it recorded.
 *
 * One document, two names: the route answers it as the outcome of the run it
 * just made, and the same document is what the account holds, so the
 * administration surface reads the identical answer back after a restart
 * (`PublishJob`, `server/src/adminPolicy.ts`).
 */
export type { PublishJob };
export type PublishOutcome = PublishJob;

export {
  accountCtx,
  appPasswordName,
  confirmsPassword,
  resolveInstallationAccount,
  sessionExtras,
} from "./shared/account.js";
export {
  adminAllows,
  administrationRefusal,
  enforceAdmin,
  requireAdmin,
  resolveAdminState,
} from "./shared/admin.js";
export {
  acquireEventsStreamSlot,
  blobContentType,
  byteCap,
  EVENTS_STREAMS_LIMIT,
  forwardedContentLength,
  GATED_BUDGET,
  GatedBudgetError,
  GatedSizeError,
  gatedBytes,
  gatedReads,
  MAX_GATED_PER_SESSION,
  MAX_GATED_REQUEST,
  passthrough,
  readGated,
  relayPushRaw,
  SSE_HEADERS,
  sanitizeContentType,
  securityHeadersFor,
} from "./shared/data.js";
export {
  accountFailure,
  failureFor,
  groupAccessFailure,
  groupDenial,
  refusal,
  upstreamFailure,
} from "./shared/errors.js";
export {
  apiLimiterInstance,
  bindSessions,
  bound,
  durable,
  type Env,
  guarded,
  loginFloodLimiter,
  loginFloodLimiterInstance,
  loginLimiter,
  loginLimiterInstance,
  refundCredentialAttempt,
  sessionDocumentIo,
  sessions,
  store,
  useDurableSessions,
} from "./shared/sessions.js";
export {
  apiRateLimited,
  clientIp,
  compressResponses,
  cookiePath,
  csrfGuard,
  loginBody,
  pushOrigin,
  readJson,
  requireSession,
  securityHeaders,
  setSessionCookie,
  smallBodies,
} from "./shared/transport.js";
export {
  directiveCache,
  forcedFlagsFor,
  forcedPasswordDoor,
  identityLockCache,
  sessionForcedState,
  sessionIdentityLockState,
} from "./shared/verdicts.js";
