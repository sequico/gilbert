import { CAPABILITIES } from "@gilbert/shared/capabilities";
import { errorMessage } from "@gilbert/shared/errors";
import {
  fileNodeRequestArguments,
  fileNodeResponseArguments,
} from "@gilbert/shared/filenode";
import {
  GROUP_NOT_ACCESSIBLE,
  GROUP_UNREADABLE,
  type GroupNeed,
} from "@gilbert/shared/groupAccess";
import { GENERIC_TYPES, mediaType, typeFromName } from "@gilbert/shared/media";
import { agentErrorSentence } from "@/lib/agentErrors";
import { withBase } from "@/lib/basePath";
import { DeadlineError, withDeadline } from "@/lib/deadline";
import { groupAccessSentence, groupUnreadableSentence } from "@/lib/groupAccess";
import type {
  Id,
  Invocation,
  JmapResponse,
  JmapSession,
  MethodError,
  SetError,
  SetResponse,
  UploadResponse,
} from "./types";

/*
 * The capabilities this client names, one entry per URN the shared tier
 * defines (`@gilbert/shared/capabilities`): what `usingFor` puts in a
 * request's `using`, and what `primaryAccounts`/`accountCapabilities` are
 * keyed by. The values are references rather than spellings so that a URN
 * exists once in the tree; the test beside this file checks the two directions
 * — nothing shared is missing here, and nothing here is unshared.
 */
export const CAP = {
  core: CAPABILITIES.core,
  mail: CAPABILITIES.mail,
  submission: CAPABILITIES.submission,
  vacation: CAPABILITIES.vacation,
  sieve: CAPABILITIES.sieve,
  contacts: CAPABILITIES.contacts,
  contactsParse: CAPABILITIES.contactsParse,
  calendars: CAPABILITIES.calendars,
  calendarsParse: CAPABILITIES.calendarsParse,
  principals: CAPABILITIES.principals,
  availability: CAPABILITIES.availability,
  quota: CAPABILITIES.quota,
  blob: CAPABILITIES.blob,
  filenode: CAPABILITIES.filenode,
  websocket: CAPABILITIES.websocket,
  webpushVapid: CAPABILITIES.webpushVapid,
  emailpush: CAPABILITIES.emailpush,
} as const;

export class JmapMethodError extends Error {
  constructor(
    public readonly method: string,
    public readonly error: MethodError,
  ) {
    super(
      `${method}: ${error.type}${error.description ? ` - ${error.description}` : ""}`,
    );
    this.name = "JmapMethodError";
  }
  get type() {
    return this.error.type;
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? `${code} (${status})`);
    this.name = "ApiError";
  }
}

/**
 * The server's answer when the forced-password-change door (ADR 0001) stops
 * a data request: 403 with this error code. The client turns it into the
 * full-screen forced-change view, like a 401 turns into the sign-in screen.
 */
const PASSWORD_CHANGE_REQUIRED = "password_change_required";

interface ApiErrorBody {
  error?: string;
  message?: string;
  type?: string;
  detail?: string;
  title?: string;
  /** The section a group-membership refusal names, beside its code. */
  need?: GroupNeed;
}

interface Pending {
  method: string;
  args: Record<string, unknown>;
  using: Set<string>;
  /** Set for a call made inside a cancellable pass; see `call`. */
  signal?: AbortSignal;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  "x-requested-with": "gilbert",
};

/*
 * How long a browser request may stay unanswered.
 *
 * The server leg puts this same deadline on its own call to the mail server
 * (`config.upstreamTimeout`, thirty seconds by default), so a socket that opens
 * and then goes silent -- a proxy holding it, half-open TCP after a suspend --
 * fails here within the same time instead of leaving the promise pending for
 * ever: the store awaiting it would keep `loading: true` with no error to show
 * and no retry, because the catch-up only aborts on `offline`.
 */
export const API_TIMEOUT_MS = 30_000;

/*
 * The blob legs' ceiling, longer than a JMAP call's: a whole attachment or file
 * may take its time, and the server gives both the `/blob` and `/upload` routes
 * five minutes (`app.ts`) rather than the thirty seconds the JSON-RPC route
 * allows. Bounding either at the API deadline would cut a transfer off midway;
 * the deadline here covers the transfer itself, headers and body, so a transfer
 * that stalls after its headers is bounded too.
 */
const BLOB_TIMEOUT_MS = 5 * 60_000;

/**
 * What a response body says, read where the caller's deadline is running.
 *
 * A body that is not JSON is "nothing to learn" rather than a failure of its
 * own, so a refusal's sentence falls back the way it did when the read sat
 * beside the call. The read is inside the deadline because a server that answers
 * the request line and then goes silent leaves it pending, which is the promise
 * the deadline exists for -- and the read's *other* failures, the abort above
 * all, are left to the caller: swallowing them would turn a request that never
 * answered into an empty success.
 */
const jsonBody = async (res: Response): Promise<unknown> => {
  if (res.status === 204) return undefined;
  try {
    return await res.json();
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
};

/**
 * Generic fetch against our same-origin API with CSRF header + auth handling.
 *
 * `path` is written root-absolute at every call site -- `/api/jmap` -- and the
 * mount prefix is added here rather than there. One place to get it right, and
 * the `startsWith` below keeps working on the path as written rather than on
 * whatever the deployment happens to be called.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  /*
   * The whole exchange runs inside the deadline, the body included: what the
   * deadline is for is the promise that never settles, and a proxy that answers
   * the request line and then goes silent leaves the body's read pending. A
   * deadline that bounds only the headers calls that bounded.
   */
  let ok: boolean;
  let status: number;
  let body: unknown;
  try {
    ({ ok, status, body } = await withDeadline(
      API_TIMEOUT_MS,
      init.signal ?? undefined,
      async (signal) => {
        const res = await fetch(withBase(path), {
          ...init,
          headers: {
            ...HEADERS,
            // A caller may hand a `Headers` instance rather than a record, and
            // spreading one yields nothing: its headers would vanish in silence.
            ...(init.headers instanceof Headers
              ? Object.fromEntries(init.headers)
              : (init.headers as Record<string, string> | undefined)),
          },
          credentials: "same-origin",
          // The caller's signal may cancel the request; the deadline bounds it
          // whether or not the caller passed one.
          signal,
        });
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          body: await jsonBody(res),
        };
      },
    ));
  } catch (err) {
    /*
     * A deadline that elapsed is its own answer, not a cancellation: nothing
     * refused this request and the person did not stop it. It arrives here as
     * the browser's `AbortError` otherwise, which is the very object a caller
     * cancelling produces — so a stalled request was reported as one they
     * chose, and a caller branching on `code` fell through its `aborted` case
     * to the generic "something went wrong".
     */
    if (err instanceof DeadlineError) {
      throw new ApiError(
        0,
        "deadline",
        `The server did not answer within ${Math.round(err.ms / 1000)} seconds.`,
      );
    }
    throw err;
  }
  if (status === 401 && !path.startsWith("/api/auth/login")) {
    client.handleUnauthenticated();
    throw new ApiError(
      401,
      "unauthenticated",
      "Your session has expired. Please sign in again.",
    );
  }
  if (!ok) {
    const err = (body ?? {}) as ApiErrorBody;
    if (status === 403 && err.error === PASSWORD_CHANGE_REQUIRED) {
      client.handleForcedPasswordChange();
    }
    /*
     * A body that carries a machine-readable refusal gets its sentence composed
     * from the loaded catalogue: the code and its parameters are what travels,
     * so the sentence is the reader's language rather than the server's. A body
     * that carries prose is read as that prose, and a code this build does not
     * know falls through to it rather than being given a sentence of its own.
     */
    const composed =
      err.need && err.error === GROUP_NOT_ACCESSIBLE
        ? groupAccessSentence(err.need)
        : err.need && err.error === GROUP_UNREADABLE
          ? groupUnreadableSentence(err.need)
          : agentErrorSentence(err as Record<string, unknown>);
    const message =
      composed ?? err.message ?? err.detail ?? err.title ?? "request_failed";
    throw new ApiError(status, err.error ?? err.type ?? "error", message);
  }
  if (status === 204) return undefined as T;
  return body as T;
}

export class JmapClient {
  session: JmapSession | null = null;
  private pending: Pending[] = [];
  private flushScheduled = false;
  private callCounter = 0;
  private unauthHandlers = new Set<() => void>();
  private forcedHandlers = new Set<() => void>();
  private stateHandlers = new Set<(sessionState: string) => void>();

  get maxCallsInRequest(): number {
    const core = this.session?.capabilities[CAP.core] as
      | { maxCallsInRequest?: number }
      | undefined;
    return core?.maxCallsInRequest ?? 16;
  }

  get maxObjectsInGet(): number {
    const core = this.session?.capabilities[CAP.core] as
      | { maxObjectsInGet?: number }
      | undefined;
    return core?.maxObjectsInGet ?? 500;
  }

  get maxObjectsInSet(): number {
    const core = this.session?.capabilities[CAP.core] as
      | { maxObjectsInSet?: number }
      | undefined;
    return core?.maxObjectsInSet ?? 500;
  }

  get maxSizeUpload(): number {
    const core = this.session?.capabilities[CAP.core] as
      | { maxSizeUpload?: number }
      | undefined;
    return core?.maxSizeUpload ?? 50_000_000;
  }

  hasCapability(cap: string): boolean {
    return Boolean(this.session?.capabilities && cap in this.session.capabilities);
  }

  accountHasCapability(accountId: Id, cap: string): boolean {
    const acc = this.session?.accounts[accountId];
    return Boolean(acc && cap in acc.accountCapabilities);
  }

  /**
   * Whether the server carries a capability at all, wherever it chose to
   * advertise it.
   *
   * Stalwart hands `urn:stalwart:jmap` out per-account rather than putting it
   * in the session-level `capabilities`, so `hasCapability` alone reports every
   * real 0.16 server as though it were older. Look in all three places.
   */
  hasCapabilityAnywhere(cap: string): boolean {
    if (this.hasCapability(cap)) return true;
    if (this.session?.primaryAccounts && cap in this.session.primaryAccounts) return true;
    return Object.values(this.session?.accounts ?? {}).some(
      (a) => cap in (a.accountCapabilities ?? {}),
    );
  }

  /**
   * The capability object itself, for the capabilities that carry limits.
   * Stalwart puts the interesting half of `urn:ietf:params:jmap:submission`
   * here and leaves the session-level copy empty.
   */
  accountCapability<T>(accountId: Id, cap: string): T | undefined {
    const acc = this.session?.accounts[accountId];
    return acc?.accountCapabilities[cap] as T | undefined;
  }

  primaryAccount(cap: string): Id | null {
    return this.session?.primaryAccounts[cap] ?? null;
  }

  onUnauthenticated(fn: () => void): () => void {
    this.unauthHandlers.add(fn);
    return () => this.unauthHandlers.delete(fn);
  }

  /**
   * Fired when the forced-password-change door stops a request (ADR 0001).
   * The session is still valid — this is a wall, not a sign-out — but the app
   * must stop its data loops and show the forced-change view.
   */
  onForcedPasswordChange(fn: () => void): () => void {
    this.forcedHandlers.add(fn);
    return () => this.forcedHandlers.delete(fn);
  }

  onSessionState(fn: (s: string) => void): () => void {
    this.stateHandlers.add(fn);
    return () => this.stateHandlers.delete(fn);
  }

  handleUnauthenticated(): void {
    for (const fn of this.unauthHandlers) fn();
  }

  handleForcedPasswordChange(): void {
    for (const fn of this.forcedHandlers) fn();
  }

  /**
   * Queue a single method call; calls made within the same tick under the same
   * signal are batched into one HTTP request (up to maxCallsInRequest).
   *
   * `signal` makes the call cancellable: the HTTP request carries it beside
   * the deadline `apiFetch` adds, and an already-aborted signal rejects without
   * a request at all. A catch-up pass hands one signal to every call it makes,
   * so a dropped line can abort the whole pass instead of letting its requests
   * run against nothing.
   */
  call<T = Record<string, unknown>>(
    method: string,
    args: Record<string, unknown>,
    using: string[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ApiError(0, "aborted", "Request aborted"));
        return;
      }
      this.pending.push({
        method,
        args,
        using: new Set([CAP.core, ...usingFor(method), ...using]),
        signal,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    const batch = this.pending;
    this.pending = [];
    /*
     * One HTTP request carries one signal, so the batch is grouped by the
     * signal its calls were made under before it is chunked. A catch-up pass
     * makes its calls under its own signal and a live refresh under none, and
     * the two must not share a request: aborting the pass would otherwise
     * cancel the live call with it.
     */
    const groups = new Map<AbortSignal | null, Pending[]>();
    for (const p of batch) {
      const key = p.signal ?? null;
      const group = groups.get(key);
      if (group) group.push(p);
      else groups.set(key, [p]);
    }
    const max = this.maxCallsInRequest;
    for (const [signal, group] of groups) {
      for (let i = 0; i < group.length; i += max) {
        void this.sendBatch(group.slice(i, i + max), signal ?? undefined);
      }
    }
  }

  private async sendBatch(batch: Pending[], signal?: AbortSignal): Promise<void> {
    const using = new Set<string>();
    const calls: Invocation[] = batch.map((p, idx) => {
      for (const u of p.using) using.add(u);
      return [p.method, p.args, `c${this.callCounter++}_${idx}`];
    });
    try {
      const res = await this.request(calls, [...using], undefined, signal);
      const byId = new Map<string, Invocation[]>();
      for (const inv of res.methodResponses) {
        const arr = byId.get(inv[2]) ?? [];
        arr.push(inv);
        byId.set(inv[2], arr);
      }
      /*
       * A request-level refusal comes back as a single `error` response whose
       * call id is `"0"` (RFC 8620 §3.6.1), which matches no invocation here —
       * `invalidArguments`, `unknownMethod`, `limit`, `serverFail`. It is the
       * request that failed, not the calls in it, so every pending takes that
       * refusal as it is. Left to the per-call loop it matched nothing, and each
       * call was rejected with a fabricated `serverFail: No response for call`:
       * the server's own type thrown away, a type that meant something else
       * attributed to a method that was never run, and a sentence about an
       * internal failure shown to whoever asked.
       */
      const requestError = res.methodResponses.find(
        ([name, , id]) =>
          name === "error" && !calls.some(([, , callId]) => callId === id),
      );
      if (requestError) {
        const refusal = requestError[1] as MethodError;
        for (const p of batch) p.reject(new JmapMethodError("<request>", refusal));
        return;
      }
      batch.forEach((p, idx) => {
        const responses = byId.get(calls[idx]![2]);
        const first = responses?.[0];
        if (!first) {
          p.reject(
            new JmapMethodError(p.method, {
              type: "serverFail",
              description: "No response for call",
            }),
          );
          return;
        }
        if (first[0] === "error")
          p.reject(new JmapMethodError(p.method, first[1] as MethodError));
        else p.resolve(first[1]);
      });
    } catch (err) {
      for (const p of batch) p.reject(err);
    }
  }

  /**
   * Drop capabilities this session never advertised.
   *
   * A server MUST reject the whole request with `unknownCapability` when
   * `using` names something it does not implement (RFC 8620), which would take
   * down every call in the batch — not just the one that wanted the capability.
   * Core always stays: it is the one urn every server has.
   */
  private supportedUsing(using: string[]): string[] {
    if (!this.session?.capabilities) return using;
    // Anywhere counts: a capability advertised per-account is one the server
    // has, and Stalwart advertises its own that way and no other.
    return using.filter((u) => u === CAP.core || this.hasCapabilityAnywhere(u));
  }

  /** Low-level request: send invocations verbatim, return raw response. */
  async request(
    methodCalls: Invocation[],
    using: string[] = [CAP.core, CAP.mail],
    createdIds?: Record<string, Id>,
    signal?: AbortSignal,
  ): Promise<JmapResponse> {
    if (signal?.aborted) throw new ApiError(0, "aborted", "Request aborted");
    /*
     * The one boundary that speaks Stalwart 1.0's FileNode: `nodeType`/`type`
     * become `@type`/`mediaType` on the way out and back (`shared/filenode.ts`),
     * so a store or a view keeps the tree's own words.
     */
    const wireCalls = methodCalls.map(
      ([name, args, id]): Invocation => [name, fileNodeRequestArguments(name, args), id],
    );
    const body: Record<string, unknown> = {
      using: this.supportedUsing(using),
      methodCalls: wireCalls,
    };
    if (createdIds) body.createdIds = createdIds;
    const res = await apiFetch<JmapResponse>("/api/jmap", {
      method: "POST",
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    res.methodResponses = res.methodResponses.map(
      ([name, args, id]): Invocation => [name, fileNodeResponseArguments(name, args), id],
    );
    if (res.sessionState && this.session && res.sessionState !== this.session.state) {
      /*
       * Advance the baseline here, where the change is seen, and not leave it
       * to whoever refreshes next: the signal is edge-triggered, so "the state
       * moved" must become "and the state is now this". Left where it was, the
       * comparison stays true until some other code path replaces the whole
       * session — and while the refresh the handler triggers keeps failing,
       * **every** response re-fires it, at two extra requests per request.
       */
      this.session.state = res.sessionState;
      for (const fn of this.stateHandlers) fn(res.sessionState);
    }
    return res;
  }

  /**
   * Run a chain of invocations (which may use result references) and return
   * responses keyed by call id. Throws if any call errored, unless `allowErrors`.
   */
  async chain(
    calls: Array<[method: string, args: Record<string, unknown>, id: string]>,
    opts: { using?: string[]; allowErrors?: boolean } = {},
  ): Promise<Map<string, Record<string, unknown>[]>> {
    const using = new Set<string>([CAP.core]);
    for (const [m] of calls) for (const u of usingFor(m)) using.add(u);
    for (const u of opts.using ?? []) using.add(u);
    const res = await this.request(calls, [...using]);
    const out = new Map<string, Record<string, unknown>[]>();
    for (const [name, args, id] of res.methodResponses) {
      if (name === "error" && !opts.allowErrors) {
        const method = calls.find((c) => c[2] === id)?.[0] ?? id;
        throw new JmapMethodError(method, args as MethodError);
      }
      const arr = out.get(id) ?? [];
      arr.push(name === "error" ? { __error: args } : args);
      out.set(id, arr);
    }
    return out;
  }

  uploadUrl(accountId: Id): string {
    return withBase(`/api/upload/${encodeURIComponent(accountId)}`);
  }

  downloadUrl(
    accountId: Id,
    blobId: Id,
    name: string,
    type: string,
    inline = false,
  ): string {
    const safeName = (name || "attachment").replace(/[/\\?#%]/g, "_");
    // Generic means the sender said nothing: let the name answer, so a PDF
    // stored as octet-stream is requested as the PDF it is.
    const resolved = mediaType(type);
    const accept =
      (GENERIC_TYPES.has(resolved) ? typeFromName(name) : null) ||
      type ||
      "application/octet-stream";
    const u = withBase(
      `/api/blob/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}/${encodeURIComponent(safeName)}?accept=${encodeURIComponent(accept)}`,
    );
    return inline ? `${u}&inline=1` : u;
  }

  /**
   * Upload a blob with progress reporting (XHR because fetch lacks upload
   * progress).
   *
   * The request carries the blob legs' deadline like the download legs do, so
   * a connection that opens and then goes silent -- a proxy holding the socket
   * -- rejects instead of leaving the composer waiting on it for ever; the
   * caller's own signal cancels it just the same.
   */
  upload(
    accountId: Id,
    data: Blob,
    opts: {
      type?: string;
      onProgress?: (loaded: number, total: number) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<UploadResponse> {
    return withDeadline(
      BLOB_TIMEOUT_MS,
      opts.signal,
      (signal) =>
        new Promise<UploadResponse>((resolve, reject) => {
          // A caller that changed its mind before the upload started is answered,
          // as `request` does, rather than sending the bytes anyway.
          if (signal.aborted) {
            reject(new ApiError(0, "aborted", "Upload aborted"));
            return;
          }
          const xhr = new XMLHttpRequest();
          xhr.open("POST", this.uploadUrl(accountId));
          xhr.setRequestHeader(
            "content-type",
            opts.type || data.type || "application/octet-stream",
          );
          xhr.setRequestHeader("x-requested-with", HEADERS["x-requested-with"]);
          xhr.responseType = "json";
          const onAbort = () => xhr.abort();
          // Every terminal handler detaches the listener, so a settled upload does
          // not leave the request's signal holding this request.
          const detach = () => signal.removeEventListener("abort", onAbort);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
          };
          xhr.onload = () => {
            detach();
            if (xhr.status === 401) {
              this.handleUnauthenticated();
              reject(new ApiError(401, "unauthenticated"));
              return;
            }
            if (
              xhr.status === 403 &&
              (xhr.response as ApiErrorBody)?.error === PASSWORD_CHANGE_REQUIRED
            ) {
              this.handleForcedPasswordChange();
            }
            if (xhr.status >= 200 && xhr.status < 300 && xhr.response)
              resolve(xhr.response as UploadResponse);
            else
              reject(
                new ApiError(
                  xhr.status,
                  (xhr.response as ApiErrorBody)?.error ?? "upload_failed",
                  (xhr.response as ApiErrorBody)?.message ?? "Upload failed",
                ),
              );
          };
          xhr.onerror = () => {
            detach();
            reject(new ApiError(0, "network_error", "Network error during upload"));
          };
          xhr.onabort = () => {
            detach();
            reject(new ApiError(0, "aborted", "Upload aborted"));
          };
          signal.addEventListener("abort", onAbort);
          xhr.send(data);
        }),
    ).catch((err) => {
      /*
       * The deadline's own error, raised where every other request raises it.
       * `withDeadline` answers it instead of the browser's `AbortError` so the
       * two are separable, and this maps it into the vocabulary the rest of this
       * client uses — the same code and the same sentence shape `apiFetch`
       * gives, so a caller reads one answer for "it never answered", whether the
       * bytes were going out or coming back.
       */
      if (err instanceof DeadlineError)
        throw new ApiError(
          0,
          "deadline",
          `The upload did not complete within ${Math.round(err.ms / 1000)} seconds.`,
        );
      throw err;
    });
  }

  /** Fetch a blob's content as text (via the download proxy). */
  async fetchBlobText(accountId: Id, blobId: Id, type = "text/plain"): Promise<string> {
    const { status, text, body } = await withDeadline(
      BLOB_TIMEOUT_MS,
      undefined,
      async (signal) => {
        const res = await fetch(this.downloadUrl(accountId, blobId, "blob.txt", type), {
          credentials: "same-origin",
          signal,
        });
        // Both the bytes and the refusal are read inside the deadline: a
        // transfer that stalls after its headers would otherwise hold the
        // promise for ever, which is the failure the deadline names.
        return res.ok
          ? {
              status: res.status,
              text: res.status === 204 ? "" : await res.text(),
              body: undefined,
            }
          : { status: res.status, text: "", body: await jsonBody(res) };
      },
    );
    if (status === 401) {
      this.handleUnauthenticated();
      throw new ApiError(401, "unauthenticated");
    }
    this.forcedIfNeeded(status, body);
    if (status < 200 || status >= 300) throw new ApiError(status, "download_failed");
    return text as string;
  }

  async fetchBlob(
    accountId: Id,
    blobId: Id,
    type = "application/octet-stream",
    signal?: AbortSignal,
  ): Promise<Blob> {
    const { status, blob, body } = await withDeadline(
      BLOB_TIMEOUT_MS,
      signal,
      async (deadline) => {
        const res = await fetch(this.downloadUrl(accountId, blobId, "blob", type), {
          credentials: "same-origin",
          signal: deadline,
        });
        // The bytes are read inside the deadline too: a transfer that stalls
        // after its headers would otherwise hold the promise for ever, which is
        // the failure the deadline names.
        return res.ok
          ? {
              status: res.status,
              blob: (await res.blob()) as Blob | null,
              body: undefined,
            }
          : { status: res.status, blob: null, body: await jsonBody(res) };
      },
    );
    if (status === 401) {
      this.handleUnauthenticated();
      throw new ApiError(401, "unauthenticated");
    }
    this.forcedIfNeeded(status, body);
    if (!blob) throw new ApiError(status, "download_failed");
    return blob;
  }

  /**
   * A blob download that the forced-password-change door stopped (403) must
   * switch the app to the wall like any other data request.
   */
  private forcedIfNeeded(status: number, body: unknown): void {
    if (status !== 403) return;
    if ((body as ApiErrorBody | undefined)?.error === PASSWORD_CHANGE_REQUIRED) {
      this.handleForcedPasswordChange();
    }
  }
}

/** Map method name prefix → required capability URNs. */
function usingFor(method: string): string[] {
  const type = method.split("/")[0] ?? "";
  switch (type) {
    case "Mailbox":
    case "Thread":
    case "Email":
    case "SearchSnippet":
      return [CAP.mail];
    // Identity belongs to the submission capability (RFC 8621), not mail:
    // Stalwart >= 0.16 rejects Identity/get and Identity/set outright when
    // "using" names only mail. Keep mail as well, so the filter in
    // supportedUsing() still leaves a usable urn on servers that predate
    // advertising submission.
    case "Identity":
    case "EmailSubmission":
      return [CAP.mail, CAP.submission];
    case "VacationResponse":
      return [CAP.mail, CAP.vacation];
    case "SieveScript":
      return [CAP.sieve];
    case "AddressBook":
    case "ContactCard":
      return [CAP.contacts, CAP.contactsParse];
    case "Calendar":
    case "CalendarEvent":
    case "ParticipantIdentity":
    case "CalendarEventNotification":
      return [CAP.calendars, CAP.calendarsParse];
    case "Principal":
      return [CAP.principals, CAP.availability];
    case "Quota":
      return [CAP.quota];
    case "Blob":
      return [CAP.blob];
    case "FileNode":
      return [CAP.filenode];
    case "PushSubscription":
      return [];
    default:
      return [];
  }
}

export const client = new JmapClient();

/** Chunk ids so a /get or /set call stays under the server's per-call maximum. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** What a batched write landed, across every batch it took. */
interface BatchedSetResult {
  created: number;
  updated: number;
  destroyed: Id[];
  refused?: SetError;
}

/**
 * A `/set` the server will take, sent `maxObjectsInSet` objects at a time.
 *
 * The server counts every object in a call against one ceiling -- creates,
 * updates and destroys together -- and refuses the call whole past it, taking
 * none of it: an import, a selection or a folder emptying that crosses the
 * ceiling writes nothing at all. One budget for all three kinds is the whole
 * point, because a call is refused for the objects it carries together: batching
 * the kinds apart would only hide how much one write really sends. The ceiling
 * is the session's own, so a deployment that has tuned it is followed.
 *
 * A batch that fails after earlier ones landed is reported with the `noun` it
 * was given, so a half-finished write says how much of it is already on the
 * server rather than only that it failed. Without a `noun` the failure is
 * thrown as it came, for a caller that answers instead of throwing.
 *
 * `onSettled` is told how much landed whenever the loop ends, thrown or not,
 * for a caller that has to show a partial write either way.
 */
export async function batchedSet<T>(opts: {
  /** The object type, not the call: `ContactCard` goes out as `ContactCard/set`. */
  method: string;
  accountId: Id;
  create?: Record<string, unknown>;
  update?: Record<Id, unknown>;
  destroy?: Id[];
  /** What the method needs besides the three kinds, such as `sendSchedulingMessages`. */
  extra?: Record<string, unknown>;
  noun?: string;
  onSettled?: (written: number) => void;
}): Promise<BatchedSetResult> {
  const { method, accountId, create = {}, update = {}, destroy = [], extra, noun } = opts;
  const work = [
    ...Object.keys(create).map((k) => ["create", k] as const),
    ...Object.keys(update).map((k) => ["update", k] as const),
    ...destroy.map((k) => ["destroy", k] as const),
  ];
  let created = 0;
  let updated = 0;
  const gone: Id[] = [];
  let refused: SetError | undefined;
  try {
    for (const part of chunk(work, client.maxObjectsInSet)) {
      const subCreate: Record<string, unknown> = {};
      const subUpdate: Record<Id, unknown> = {};
      const subDestroy: Id[] = [];
      for (const [kind, k] of part) {
        if (kind === "create") subCreate[k] = create[k];
        else if (kind === "update") subUpdate[k] = update[k];
        else subDestroy.push(k);
      }
      const res = await client.call<SetResponse<T>>(`${method}/set`, {
        accountId,
        ...(Object.keys(subCreate).length ? { create: subCreate } : {}),
        ...(Object.keys(subUpdate).length ? { update: subUpdate } : {}),
        ...(subDestroy.length ? { destroy: subDestroy } : {}),
        ...extra,
      });
      created += Object.keys(res.created ?? {}).length;
      updated += Object.keys(res.updated ?? {}).length;
      gone.push(...(res.destroyed ?? []));
      refused ??=
        Object.values(res.notCreated ?? {})[0] ??
        Object.values(res.notUpdated ?? {})[0] ??
        Object.values(res.notDestroyed ?? {})[0];
    }
  } catch (err) {
    const written = created + updated + gone.length;
    if (noun && written)
      throw new Error(
        `${written} of ${work.length} ${noun} were imported before this happened: ${errorMessage(err)}`,
      );
    throw err;
  } finally {
    opts.onSettled?.(created + updated + gone.length);
  }
  return { created, updated, destroyed: gone, refused };
}

/**
 * A readable message for a JMAP SetError.
 *
 * Servers name the offending field in `properties`, which is usually the whole
 * answer to "why was this rejected" — Stalwart's description alone is often
 * just "Invalid property or value." Keep both.
 *
 * Takes the shared `SetError` rather than a shape written out here: this
 * declaration used to spell out the first three fields and drop the rest, and
 * the one it dropped is the one with behaviour behind it — `existingId`, the
 * node already carrying a name on an `alreadyExists` refusal, which is what
 * lets a caller that lost a create race adopt it instead of reporting a name
 * nobody can see. A copy can drift from the shared type without failing to
 * compile; an import cannot.
 */
export function setErrorMessage(err: SetError | null | undefined): string {
  if (!err) return "Unknown error";
  const base = err.description ?? err.type;
  const props = err.properties?.length ? ` (${err.properties.join(", ")})` : "";
  return `${base}${props}`;
}
