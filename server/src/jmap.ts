/**
 * The server tier's JMAP client: one request shape, one error mapping.
 *
 * Every server-side call to Stalwart goes through here — the account registry
 * (`account.ts`), the app-folder primitives (`appFolder.ts`) and the agent's
 * worker (`agent/`) — so the `using` set, the timeout, the 401/403 mapping and
 * the blob upload/download templates are decided once.
 *
 * The web client has its own transport (`web/src/jmap/client.ts`) because it
 * is built to talk through Gilbert's proxy with a browser's error surface;
 * this one talks to Stalwart directly with a server's.
 */

import { config } from "./config.js";
import { CAPABILITIES, STALWART_REGISTRY } from "./shared/capabilities.js";
import {
  absoluteUpstream,
  expandTemplate,
  UpstreamError,
  type UpstreamSession,
} from "./upstream.js";

/**
 * This tier's names for the shared vocabulary (`shared/capabilities.ts`), kept
 * because the agent and admin code names a capability by its tier's word.
 */
export const JMAP_CORE = CAPABILITIES.core;
export const JMAP_MAIL = CAPABILITIES.mail;
export const JMAP_SUBMISSION = CAPABILITIES.submission;
export const JMAP_CONTACTS = CAPABILITIES.contacts;
export const JMAP_PRINCIPALS = CAPABILITIES.principals;
export const STALWART_CAP = STALWART_REGISTRY;

/*
 * Declared once, in `./shared/jmap`: the client builds one of these per call it
 * makes through this proxy, and the shape is the protocol's rather than either
 * tier's.
 */
import type { Invocation, MethodResponses } from "./shared/jmap.js";

export type { Invocation, MethodResponses };

/** A JMAP method that answered with an error object. */
export class JmapError extends UpstreamError {
  constructor(
    public readonly type: string,
    public readonly description: string,
    public readonly callId: string,
  ) {
    super(description || `Stalwart refused the request (${type})`, 502);
    this.name = "JmapError";
  }
}

/**
 * The responses of one request, looked up by call id.
 *
 * A JMAP request is a batch: several methods, each answering under the id it
 * was called with. Returning the batch and letting the caller pick keeps the
 * `#ids` back-references (`resultOf`) working — they name a call id, not a
 * method name.
 */
export class JmapResult {
  constructor(private readonly responses: MethodResponses) {}

  /** The raw response for a call id, or undefined when it is absent. */
  raw(callId: string): MethodResponses[number] | undefined {
    return this.responses.find((r) => r[2] === callId);
  }

  /** A response's arguments. Throws when the method answered with an error. */
  args(callId: string): Record<string, unknown> {
    const found = this.raw(callId);
    if (!found)
      throw new JmapError("missingResponse", `no response for ${callId}`, callId);
    const [name, body] = found;
    if (name === "error")
      throw new JmapError(
        String(body.type ?? "error"),
        String(body.description ?? ""),
        callId,
      );
    return body;
  }

  /**
   * A `list` from a `/get` or `/query` response; empty when the response
   * carries none.
   *
   * A response that is **absent** and one that **errored** are not empty lists:
   * returning `[]` for either turns "the server refused this query" — or never
   * answered it at all — into "the account holds nothing", and the caller,
   * which is usually about to create what it could not find, then makes a
   * second copy of something that is already there. Both throw instead, which
   * is what the caller already handles for every other failure.
   */
  list<T>(callId: string): T[] {
    const found = this.raw(callId);
    if (!found)
      throw new JmapError("missingResponse", `no response for ${callId}`, callId);
    if (found[0] === "error") {
      const described = found[1] as { description?: unknown; type?: unknown };
      throw new UpstreamError(
        `the server refused the call: ${String(described.type ?? "error")} ${String(
          described.description ?? "",
        )}`.trim(),
        502,
      );
    }
    const list = found[1].list;
    return Array.isArray(list) ? (list as T[]) : [];
  }
}

/**
 * The store's compare-and-set refusal, as one predicate.
 *
 * A conditional write that lost the race answers `stateMismatch`; everything
 * that writes conditionally — the document store, the lease, the executor —
 * has to recognise it, and one definition of "lost the race" beats three.
 */
export function isStateMismatch(err: unknown): boolean {
  return err instanceof JmapError && err.type === "stateMismatch";
}

/**
 * A create refused because a sibling already carries the name.
 *
 * `onExists` defaults to `Reject` on 0.16, and the refusal arrives **inside**
 * `notCreated` -- it is one object in an otherwise successful response, not a
 * request-level error -- carrying the existing node's id in `existingId`
 * (`FileNodeSetArguments` and `find_sibling_collision`,
 * `crates/jmap-proto/src/object/file_node.rs` / `crates/jmap/src/file/set.rs`,
 * v0.16.21; `tests/src/jmap/files/node.rs` asserts the id). A read-then-write
 * that found the name missing and lost the race gets exactly this back, so it
 * is the answer "somebody made it while you were deciding" rather than a failure
 * to report.
 */
export function isAlreadyExistsRefusal(
  err: { type?: unknown; existingId?: unknown } | undefined,
): boolean {
  return err?.type === "alreadyExists";
}

/**
 * The server's own words about a refusal, bounded.
 *
 * A non-2xx body says what was wrong — the filter it did not accept, the
 * account it would not read — and dropping it leaves "502" as the whole
 * diagnosis for a person who now has to guess. Read once, truncated, and
 * appended to the message.
 */
async function refusalDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    if (!text) return "";
    return `: ${text.slice(0, 300)}`;
  } catch {
    return "";
  }
}

/**
 * The last time a mail server told us it was, from its own `Date` header.
 *
 * Leases are compared against a clock, and two processes comparing their own
 * clocks is how one of them decides a live lease has expired. Every JMAP
 * response carries the server's date; this keeps the most recent one, so the
 * answer to "has this lease lapsed" comes from the machine both agents already
 * agree on rather than from whichever laptop has the wrong time. It is the
 * anchor `serverNow()` hands out, and it is only as fresh as the last call.
 */
let serverDateMs: number | null = null;

/** Read the server's `Date` header off a response, when it carries one. */
export function noteServerDate(res: Response): void {
  const header = res.headers.get("date");
  if (!header) return;
  const at = Date.parse(header);
  if (Number.isFinite(at)) serverDateMs = at;
}

/**
 * Now, as the mail server last told us. Falls back to this process's clock
 * before anything has been asked of the server (a worker's first pass), which
 * is the one window where no server time exists yet.
 */
export function serverNow(): Date {
  return serverDateMs === null ? new Date() : new Date(serverDateMs);
}

/**
 * What a JMAP client needs to reach the server: the credential it speaks with
 * and the session it speaks to.
 *
 * A `Ctx` is one, and so is anything else carrying the two fields. The client
 * holds the *source*, never a copy of either, so a session that is re-read —
 * which is what a worker does once a poll interval in case a grant was
 * withdrawn underneath it — is the one every later call goes to, and there is
 * no second session object beside it to go stale and disagree.
 */
export interface SessionSource {
  readonly authorization: string;
  readonly session: UpstreamSession;
}

export class JmapClient {
  constructor(private readonly source: SessionSource) {}

  private get authorization(): string {
    return this.source.authorization;
  }

  private get session(): UpstreamSession {
    return this.source.session;
  }

  /** The JMAP session this client is bound to. */
  get upstream(): UpstreamSession {
    return this.session;
  }

  /** The account that owns a capability, personal accounts preferred. */
  accountFor(capability: string): string {
    const primary = this.session.primaryAccounts?.[capability];
    if (primary) return primary;
    for (const [id, account] of Object.entries(this.session.accounts ?? {})) {
      const caps = (account as { accountCapabilities?: Record<string, unknown> })
        .accountCapabilities;
      if (caps?.[capability]) return id;
    }
    return "";
  }

  /**
   * Send one JMAP request. Returns the batch; a method-level error is not an
   * exception here (use `call` for that), because a batch may carry several
   * responses and the caller decides what a partial failure means.
   */
  async request(
    methodCalls: Invocation[],
    using: ReadonlyArray<string> = [],
  ): Promise<MethodResponses> {
    const res = await fetch(absoluteUpstream(this.session.apiUrl, this.session.baseUrl), {
      method: "POST",
      headers: {
        authorization: this.authorization,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        using: [...new Set([JMAP_CORE, STALWART_CAP, ...using])],
        methodCalls,
      }),
      signal: AbortSignal.timeout(config.upstreamTimeout),
    });
    noteServerDate(res);
    if (res.status === 401) throw new UpstreamError("Invalid credentials", 401);
    // 403 is a permission, not a password: telling somebody their credentials
    // are wrong sends them to re-enter a password that was never the problem.
    if (res.status === 403)
      throw new UpstreamError(
        `the mail server refused this request for this account (403)${await refusalDetail(res)}`,
        403,
      );
    if (!res.ok)
      throw new UpstreamError(
        `Stalwart rejected the request (${res.status})${await refusalDetail(res)}`,
        502,
      );
    const body = (await res.json()) as { methodResponses?: MethodResponses };
    return body.methodResponses ?? [];
  }

  /** Send a batch and return it addressable by call id. */
  async chain(
    methodCalls: Invocation[],
    using: ReadonlyArray<string> = [],
  ): Promise<JmapResult> {
    return new JmapResult(await this.request(methodCalls, using));
  }

  /** Send a single method call and return its arguments. */
  async call<T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
    using: ReadonlyArray<string> = [],
  ): Promise<T> {
    const result = await this.chain([[name, args, "r"]], using);
    return result.args("r") as T;
  }

  /** Upload a blob for an account and return its blob id. */
  async upload(
    accountId: string,
    body: string | Uint8Array,
    type: string,
  ): Promise<string> {
    const url = absoluteUpstream(
      expandTemplate(this.session.uploadUrl, { accountId }),
      this.session.baseUrl,
    );
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: this.authorization,
        "content-type": type,
        accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(config.upstreamTimeout),
    });
    if (res.status === 401) throw new UpstreamError("Invalid credentials", 401);
    if (res.status === 403)
      throw new UpstreamError(
        `the mail server refused this upload for this account (403)${await refusalDetail(res)}`,
        403,
      );
    if (!res.ok)
      throw new UpstreamError(
        `Stalwart rejected the upload (${res.status})${await refusalDetail(res)}`,
        502,
      );
    const parsed = (await res.json()) as { blobId?: unknown };
    if (typeof parsed.blobId !== "string")
      throw new UpstreamError(
        "Stalwart accepted the upload but returned no blob id",
        502,
      );
    return parsed.blobId;
  }

  /**
   * Read a blob over the principal's own download path, bytes intact.
   *
   * Attachments are not text — a signature image re-encoded through a string
   * comes back corrupted — so the byte form is the primitive and the text
   * form is built on it.
   */
  async downloadBlob(
    accountId: string,
    blobId: string,
    name: string,
    type: string,
  ): Promise<Uint8Array> {
    const url = absoluteUpstream(
      expandTemplate(this.session.downloadUrl, { accountId, blobId, name, type }),
      this.session.baseUrl,
    );
    const res = await fetch(url, {
      headers: { authorization: this.authorization },
      signal: AbortSignal.timeout(config.upstreamTimeout),
    });
    if (res.status === 401) throw new UpstreamError("Invalid credentials", 401);
    // 403 is a permission, not a password: the same distinction `request` makes.
    // Reporting it as a 401 would sign the reader out of the browser rather than
    // tell them the account cannot read this blob.
    if (res.status === 403)
      throw new UpstreamError(
        `the mail server refused this download for this account (403)${await refusalDetail(res)}`,
        403,
      );
    if (!res.ok)
      throw new UpstreamError(
        `Stalwart refused the download (${res.status})`,
        res.status === 404 ? 404 : 502,
      );
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Read a blob back as text over the principal's own download path. */
  async downloadText(
    accountId: string,
    blobId: string,
    name: string,
    type: string,
  ): Promise<string> {
    const bytes = await this.downloadBlob(accountId, blobId, name, type);
    return new TextDecoder().decode(bytes);
  }
}
