/**
 * Sessions: what the server knows about who is signed in, and where that
 * knowledge lives.
 *
 * The records live in Stalwart — one document in the master account's own
 * `gilbert` app folder, beside the installation's other documents — because a
 * container is disposable and keeps nothing of its own: see the `IMMUTABLE`
 * refusal in `config.ts`, which exists precisely so that nothing durable is
 * left on a disk that will be replaced. A session held only in this process's
 * memory ends at a restart; a session held in a file inside the container ends
 * at a redeploy. Neither is a property a signed-in person expects of their
 * mail.
 *
 * Three things about the document are deliberate and load-bearing.
 *
 * **It holds a digest of the session id, never the id.** The cookie is
 * `{id}.{secret}`; the store recognises a presented cookie by hashing its id
 * half and looking that up — `StoredSession.idHash` — and validates the secret
 * half against `StoredSession.secretHash`. A digest is exactly enough for the
 * first and useless for anything else, which is the point: the document lies
 * in the account's own Files, where anyone who can read that account with JMAP
 * can read it, and a hash cannot be presented as an id — presenting it would
 * mean hashing *it*, which yields a third value and matches no record. Writing
 * the id down would hand such a reader half of a working cookie.
 *
 * **A record carries an absolute expiry, and an expired record is not a
 * session.** It is dropped on load and refused on resolve, whichever comes
 * first; the renewal on resolve bumps that same absolute value.
 *
 * **Reads are served from memory.** Every request resolves a cookie, and a
 * JMAP round trip per request would put Stalwart in the path of the one thing
 * on the data path that must not depend on it. The records are kept in a map,
 * and the document is written on create, reseal and destroy (coalesced, so a
 * burst of changes is one write). A stale cache — a second instance writing
 * the document, or a session destroyed somewhere this process cannot see — can
 * therefore leave *this* process honouring a session the document no longer
 * holds, until it restarts: a revocation reaches every instance but the one
 * that issued the session. It cannot do more than that. It cannot authenticate
 * anybody who does not hold the cookie, because the secret half is checked
 * against `secretHash` and the sealed credential opens only with the key
 * derived from that same secret; it cannot invent a session that was never
 * created; and it cannot outlive the process that holds it. One writer per
 * installation is assumed here, exactly as one writer per account is assumed
 * by every other document in this repository.
 *
 * A `SessionStore` given no document is the memory-only store: sessions live
 * in this process and are lost when it ends. That is the honest behaviour of a
 * deployment that named no place to keep them, and it is what a caller gets
 * until it hands one over. No file on disk is consulted or written, by this
 * class or any other.
 */

import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { deriveKey, open, randomToken, safeEqual, seal, sha256 } from "./crypto.js";

export interface StoredSession {
  /**
   * sha256 of the session id — the record's identity, and the only form of the
   * id that is ever written down. See the note at the top of this file for why
   * the id itself is stored nowhere.
   */
  idHash: string;
  /** sha256 of the cookie secret; used to validate presented cookies. */
  secretHash: string;
  /** base64 random salt for key derivation */
  salt: string;
  /** sealed JSON {username, password} */
  sealedCredentials: string;
  username: string;
  /**
   * Which account this is; see `accountKey`. Absent on records written before
   * the field existed, where the lower-cased username is the answer.
   */
  account?: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  remember: boolean;
  /**
   * Whether the sealed credential is an app password rather than the account
   * password. Recorded at sign-in (the upstream tells us, see the mock) and
   * kept in step by the 2FA switch-over flows; the forced-password-change
   * door (ADR 0001) exempts app-password sessions, because the wall needs
   * the current password and 2FA accounts can only authenticate with an app
   * password. Older persisted records predate the field and mean "password".
   */
  appPassword: boolean;
  userAgent: string;
  ip: string;
}

export interface LiveSession {
  /**
   * The session's identity: the digest of the id half of the cookie, which is
   * also what the document stores. It is a name for this session and nothing
   * that can be presented — the id and the secret exist only in the cookie.
   */
  id: string;
  username: string;
  /** See `accountKey`; what the session list and "sign out my other sessions" group by. */
  account: string;
  /** Basic Authorization header value for upstream calls. */
  authorization: string;
  remember: boolean;
  /** True when the sealed credential is an app password; see StoredSession. */
  appPassword: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string;
  ip: string;
}

/** What `/api/auth/sessions` reports about a session, with nothing secret in it. */
export interface SessionSummary {
  id: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  remember: boolean;
  userAgent: string;
  ip: string;
}

export interface CreateSessionParams {
  username: string;
  password: string;
  remember: boolean;
  userAgent: string;
  ip: string;
  /** Set when the presented credential was an app password (ADR 0001). */
  appPassword?: boolean;
  /** From `accountKey`; defaults to the lower-cased username. */
  account?: string;
}

/**
 * How long a session lives, in seconds.
 *
 * Passed in rather than read from `config` here: the caller owns where the
 * numbers come from (`SESSION_TTL` and `SESSION_REMEMBER_TTL` at boot, a
 * literal in a test), and the store's only business is what they are.
 */
export interface SessionTtls {
  /** Seconds a session that did not ask to be remembered lives. */
  ttlSeconds: number;
  /** Seconds a session that asked to be remembered lives. */
  rememberTtlSeconds: number;
}

/**
 * The installation's session document, as the caller reaches it.
 *
 * This file does no JMAP of its own. Signing in as the master, finding that
 * account and its own `gilbert` app folder is boot wiring, and it stays in
 * `app.ts` beside the rest of it; what the store needs from there is much
 * smaller than the wiring — read this one document, write this one document —
 * and that is the whole of the dependency.
 *
 * `read` answers `null` when nothing has been written yet, which is a new
 * installation rather than a failure. Both halves reject on an upstream
 * failure, and the store tells the two apart: an absent document may be
 * written, an unreadable one may not (see `flush`).
 */
export interface SessionDocumentIo {
  read(): Promise<unknown | null>;
  write(value: unknown): Promise<void>;
}

/**
 * The name of the document, in the master account's `gilbert` app folder.
 *
 * The app folder's top level is where the installation's own documents live —
 * the settings policy, the forced-password-change directive, a group's label
 * catalog — and this one sits beside them.
 */
export const SESSION_DOCUMENT_NAME = "sessions.json";

/** The version of the document's shape, so a later change is recognised. */
export const SESSION_DOCUMENT_VERSION = 1;

/** The document as it lies in the account: `{version, sessions}`. */
export interface SessionDocumentValue {
  version: number;
  sessions: StoredSession[];
}

/**
 * Everything the rest of the server asks of a session store.
 *
 * `SessionStore` below is that interface's one implementation today, and it
 * comes in two shapes: with an injected document (the records live in
 * Stalwart, and survive a restart) and without one (they live in this process
 * and do not). The reason it is named as an interface anyway is that a second
 * implementation is still planned: a stateless backend that carries the whole
 * record in the cookie, so that a replica can serve a session it never issued.
 * Callers written against the concrete class would all have to be revisited
 * then.
 *
 * Five of these are already stateless in shape -- `create`, `resolve`,
 * `reseal` and `destroy` each touch exactly one session, and the sealing key is
 * derived from the cookie secret (see `crypto.ts`), so the record can move into
 * the cookie without the server keeping a map.
 *
 * The other three cannot be. `listForUser` and `destroyAllForUser` have to
 * reach sessions other than the one presenting itself, which means something
 * has to be enumerable somewhere. `destroyAllExcept` reaches every session
 * but one — the kick a rule publish needs (ADR 0001: publish → re-login).
 * `destroyAllForUser` is not only the "sign out my
 * other sessions" button: `app.ts` also calls it when the password or the app
 * password changes, so it carries the guarantee that changing a credential
 * invalidates the sessions still holding the old one. A stateless backend
 * cannot honour that alone; the plan is for OAuth to hand the job to
 * Stalwart's own token registry, which can already answer both questions.
 *
 * One convention holds across this interface: an `id` parameter or return is a
 * session's *identity* — the digest of the cookie's id half, which is what
 * `resolve` and `listForUser` hand out — and never the id half itself, which
 * no method here returns and no durable place holds.
 */
export interface SessionBackend {
  init(): Promise<void>;
  close(): Promise<void>;
  create(params: CreateSessionParams): { cookie: string; session: LiveSession };
  resolve(cookie: string | undefined): LiveSession | null;
  reseal(cookie: string | undefined, password: string, appPassword?: boolean): boolean;
  destroy(id: string): void;
  destroyAllForUser(account: string, exceptId?: string): number;
  destroyAllExcept(exceptId?: string): number;
  /** `account` is an `accountKey`, as carried on `LiveSession.account`. */
  listForUser(account: string): SessionSummary[];
}

/**
 * Rebuild a session's Basic authorization as Stalwart 0.16's composite
 * impersonation username `{target}%{admin}`: authenticate as the target
 * using the administrator's own credential, which the seal holds.
 *
 * App passwords are refused for impersonation by Stalwart (its source,
 * `authentication.rs`, checked 2026-09-07; re-verify against a live server
 * with a dated comment per repo convention), so an app-password session gets
 * null rather than an authorization that would fail upstream. Used only by
 * the admin write path (ADR 0001).
 */
export function impersonationAuthorization(
  session: LiveSession,
  target: string,
): string | null {
  if (session.appPassword) return null;
  // The header was built from the decrypted `{username, password}`; decoding
  // it back is how the admin path reaches the password without a new
  // decryption surface.
  const raw = session.authorization.startsWith("Basic ")
    ? session.authorization.slice("Basic ".length)
    : "";
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  const password = decoded.slice(sep + 1);
  const composite = `${target}%${session.username}`;
  return `Basic ${Buffer.from(`${composite}:${password}`, "utf8").toString("base64")}`;
}

/**
 * One normaliser for an account name.
 *
 * An account name is an address, and addresses do not differ by case or by
 * surrounding space. Every place that has only the typed name to go on goes
 * through this -- the keys `app.ts` caches per account, and the fallback for a
 * record written before sessions carried their account. Where the session
 * knows which account it is, `accountKey` is the answer instead, because a
 * bare `alice` and `Alice@example.com` are one account to Stalwart and must be
 * one to this store too.
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * The key sessions are grouped by: which account this is, on which server.
 *
 * Not the username as typed. Stalwart takes `Alice@example.com` and a bare
 * `alice` as the same account, so grouping by the typed string left the bare
 * session out of the list and alive through "sign out my other sessions" —
 * the one case where the answer has to be right. Hence the server's own name
 * for the account, lower-cased (`UpstreamSession.username`), qualified by the
 * server, because the same name on two configured servers is two accounts.
 */
export function accountKey(upstream: string, canonicalUsername: string): string {
  return `${upstream}|${normalizeUsername(canonicalUsername)}`;
}

/** Which account a stored record belongs to, for records written before the field. */
function accountOf(s: StoredSession): string {
  return s.account ?? normalizeUsername(s.username);
}

/**
 * The records a stored document holds, checked rather than trusted.
 *
 * The document lies in an account's own Files, where the account's owner can
 * edit it with any JMAP client: an entry that is not a record is skipped
 * rather than allowed to make the store throw at boot, and an entry is
 * accepted only when it carries what the store needs to recognise a presented
 * session. A field that is merely missing takes its older meaning — a record
 * written before `appPassword` existed is a password session (ADR 0001).
 */
function readRecords(value: unknown): StoredSession[] {
  if (!value || typeof value !== "object") return [];
  const list = (value as { sessions?: unknown }).sessions;
  if (!Array.isArray(list)) return [];
  const out: StoredSession[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.idHash !== "string" || !r.idHash) continue;
    if (typeof r.secretHash !== "string" || !r.secretHash) continue;
    if (typeof r.salt !== "string" || typeof r.sealedCredentials !== "string") continue;
    if (typeof r.username !== "string") continue;
    if (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)) continue;
    out.push({
      idHash: r.idHash,
      secretHash: r.secretHash,
      salt: r.salt,
      sealedCredentials: r.sealedCredentials,
      username: r.username,
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
      lastSeenAt: typeof r.lastSeenAt === "number" ? r.lastSeenAt : 0,
      expiresAt: r.expiresAt,
      remember: r.remember === true,
      appPassword: r.appPassword === true,
      userAgent: typeof r.userAgent === "string" ? r.userAgent : "",
      ip: typeof r.ip === "string" ? r.ip : "",
    });
  }
  return out;
}

const COOKIE_SEP = ".";

export class SessionStore implements SessionBackend {
  private sessions = new Map<string, StoredSession>();
  /**
   * Whether what is in memory differs from what the document holds.
   *
   * Cleared only by a write that succeeded (see `flushOnce`): a write that
   * failed leaves the change marked, which is what makes the next flush a retry
   * rather than a fresh start from a store that believes it has nothing to do.
   */
  private dirty = false;
  /**
   * Which change the memory is at, counted by `scheduleSave`.
   *
   * The flag above says *that* something is unwritten; this says *which*
   * something, and it is what a flush compares against to know whether the
   * write it just made covered everything the process had when it started. A
   * change that arrives while a write is in flight moves this on, and the flag
   * alone would then be cleared by that write's completion — the change would
   * sit in memory, marked written, and end at the next restart.
   */
  private revision = 0;
  /** The write in flight, so two flushes are two writes in order and never two at once. */
  private writing: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  /**
   * Set when the document exists but could not be read — as opposed to not
   * having been written yet, which is a new installation. The difference
   * decides whether this store may write: see `flush`.
   */
  private unreadable = false;

  /**
   * @param document where the records live between requests: the injected
   *   document in the master account's app folder, or `undefined` for a store
   *   that holds them in this process only. Nothing on disk is read or written
   *   either way.
   * @param ttls how long a session lives; see `SessionTtls`. The caller owns
   *   where the numbers come from.
   * @param onDestroy called with the identity of every session this store
   *   destroys, whatever the reason (expiry sweep, lazy expiry on resolve,
   *   logout, revocation, a rejected credential). app.ts wires it to
   *   forgetUpstreamSession, so a session that dies here does not leave its
   *   upstream session/info cache entries behind for the life of the process.
   *   The identity is what those caches are keyed by, so it is what they are
   *   forgotten by.
   */
  constructor(
    private readonly document: SessionDocumentIo | undefined,
    private readonly ttls: SessionTtls,
    private readonly onDestroy?: (id: string) => void,
  ) {}

  async init(): Promise<void> {
    if (this.document) await this.load();
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.flush();
  }

  /**
   * Read the document into memory, dropping what has expired.
   *
   * It merges rather than replaces, because a store whose document failed to
   * read retries here before writing (see `flush`), with sessions of its own
   * already in hand.
   */
  private async load(): Promise<void> {
    const document = this.document;
    if (!document) return;
    let value: unknown;
    try {
      value = await document.read();
      this.unreadable = false;
    } catch (err) {
      this.unreadable = true;
      console.warn(
        `[gilbert] could not read ${SESSION_DOCUMENT_NAME}:`,
        (err as Error).message,
      );
      return;
    }
    const now = Date.now();
    for (const record of readRecords(value)) {
      if (record.expiresAt <= now) continue;
      this.sessions.set(record.idHash, record);
    }
    if (this.sessions.size)
      console.log(
        `[gilbert] restored ${this.sessions.size} session(s) from ${SESSION_DOCUMENT_NAME}`,
      );
  }

  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= now) {
        this.sessions.delete(id);
        this.onDestroy?.(id);
        removed++;
      }
    }
    if (removed) this.scheduleSave();
  }

  private scheduleSave(): void {
    this.dirty = true;
    this.revision += 1;
    this.armSaveTimer();
  }

  /** One debounced write, whether it is the first or a retry of one that failed. */
  private armSaveTimer(): void {
    if (!this.document || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 1000);
    this.saveTimer.unref();
  }

  /**
   * Write what is in memory into the document, one flush at a time.
   *
   * `flush` can be reached from the debounce timer, from `close` and from a
   * retry, and two writes overlapping over one document would each believe they
   * had stored what the process holds. Chaining them is what makes "the next
   * flush" a real order rather than a hope: the second one runs after the
   * first, sees whatever the first left marked, and writes it.
   */
  private flush(): Promise<void> {
    this.writing = this.writing
      .then(() => this.flushOnce())
      /*
       * The belt to `flushOnce`'s braces: it answers a failed *write* itself,
       * and anything else it could throw would leave a rejected promise here
       * that every later flush is queued behind — a store that never writes
       * again, and nothing saying why.
       */
      .catch((err: unknown) =>
        console.warn("[gilbert] session flush failed:", (err as Error).message),
      );
    return this.writing;
  }

  /**
   * One flush: write until what is in memory is what the document holds.
   *
   * The flag is cleared **after** a successful write and never before it. A
   * write that failed — the account briefly unreachable, a credential refused —
   * leaves the change marked and re-arms the timer, so a session created,
   * resealed or destroyed in that window is stored by the next attempt instead
   * of ending in silence. And the write is compared against the revision it
   * started from: a change that arrived while it was in flight is *not* covered
   * by that write, so this flush loops and writes again rather than clearing
   * the flag over a change it never stored.
   */
  private async flushOnce(): Promise<void> {
    const document = this.document;
    if (!document) return;
    while (this.dirty) {
      if (this.unreadable) {
        /*
         * A store that could not read its document holds nothing, and a write
         * from that state would replace every session in it with the ones this
         * process happens to hold — everyone else signed out by one transient
         * read failure at boot. So the write asks the document again first, and
         * only a document that answers is written to.
         */
        await this.load();
        if (this.unreadable) {
          // The one case where a change is dropped on purpose, and said so:
          // there is no document to write it into that would not end every
          // session in it.
          this.dirty = false;
          console.warn(
            `[gilbert] not writing ${SESSION_DOCUMENT_NAME}: it could not be read, and a write from an empty store would end every session in it`,
          );
          return;
        }
      }
      const startedAt = this.revision;
      try {
        const value: SessionDocumentValue = {
          version: SESSION_DOCUMENT_VERSION,
          sessions: [...this.sessions.values()],
        };
        await document.write(value);
      } catch (err) {
        console.warn(
          `[gilbert] could not persist sessions to ${SESSION_DOCUMENT_NAME}:`,
          (err as Error).message,
        );
        // Still dirty — the change is not lost — and something has to come back
        // for it, since this attempt is over.
        this.armSaveTimer();
        return;
      }
      if (this.revision === startedAt) {
        this.dirty = false;
        return;
      }
    }
  }

  /** Create a session; returns the cookie value to hand to the client. */
  create(params: CreateSessionParams): { cookie: string; session: LiveSession } {
    const id = randomToken(18);
    const secret = randomToken(32);
    const salt = randomBytes(16);
    const key = deriveKey(secret, config.appSecret, salt);
    const now = Date.now();
    const ttl =
      (params.remember ? this.ttls.rememberTtlSeconds : this.ttls.ttlSeconds) * 1000;
    const stored: StoredSession = {
      idHash: sha256(id),
      secretHash: sha256(secret),
      salt: salt.toString("base64"),
      sealedCredentials: seal(
        JSON.stringify({ u: params.username, p: params.password }),
        key,
      ),
      username: params.username,
      account: params.account ?? normalizeUsername(params.username),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + ttl,
      remember: params.remember,
      appPassword: params.appPassword ?? false,
      userAgent: params.userAgent.slice(0, 200),
      ip: params.ip,
    };
    this.sessions.set(stored.idHash, stored);
    this.scheduleSave();
    const cookie = `${id}${COOKIE_SEP}${secret}`;
    return { cookie, session: this.toLive(stored, params.username, params.password) };
  }

  /** Resolve a cookie to a live session (with decrypted upstream credentials). */
  resolve(cookie: string | undefined): LiveSession | null {
    if (!cookie) return null;
    const idx = cookie.indexOf(COOKIE_SEP);
    if (idx <= 0) return null;
    const id = cookie.slice(0, idx);
    const secret = cookie.slice(idx + 1);
    // The id half of the cookie is never a key anywhere: it is hashed, and the
    // digest is what the record is filed under.
    const stored = this.sessions.get(sha256(id));
    if (!stored) return null;
    const now = Date.now();
    if (stored.expiresAt <= now) {
      this.sessions.delete(stored.idHash);
      this.onDestroy?.(stored.idHash);
      this.scheduleSave();
      return null;
    }
    if (!safeEqual(stored.secretHash, sha256(secret))) return null;
    const key = deriveKey(secret, config.appSecret, Buffer.from(stored.salt, "base64"));
    const json = open(stored.sealedCredentials, key);
    if (!json) return null;
    let creds: { u: string; p: string };
    try {
      creds = JSON.parse(json) as { u: string; p: string };
    } catch {
      return null;
    }
    /*
     * Sliding expiry, held where the activity is.
     *
     * `lastSeenAt` is a fact about a process — somebody is using this session
     * now — and it moves for as long as the process lives; `expiresAt` is a
     * fact about the session and is what the document keeps. The extension is
     * therefore bumped here and **not** written here: the document already
     * carries every live session's current window whenever it is written for a
     * reason of its own (a sign-in, a reseal, a sign-out), so the extension
     * rides along with that write instead of buying one of its own.
     *
     * A write caused by the clock is what an account pays for and never gets
     * back — a blob a minute, while anybody is signed in, is the quota of the
     * account that holds this document gone in a day. The trade this makes:
     * after a restart, a session's window is the one last written rather than
     * the one last used, so a session idle longer than that window ends, which
     * is the safe direction for an idle timeout to err.
     */
    if (now - stored.lastSeenAt > 60_000) {
      stored.lastSeenAt = now;
      const ttl =
        (stored.remember ? this.ttls.rememberTtlSeconds : this.ttls.ttlSeconds) * 1000;
      stored.expiresAt = now + ttl;
    }
    return this.toLive(stored, creds.u, creds.p);
  }

  /**
   * Re-seal this session's stored credentials.
   *
   * The upstream password is what every proxied call authenticates with, so a
   * password change (or swapping in an app password when 2FA is switched on)
   * would otherwise leave the session holding a credential the server no
   * longer accepts. Needs the cookie: the sealing key is derived from the
   * secret half of it, which the server never keeps.
   *
   * The session keeps its identity — the same cookie resolves to the same
   * record — because a session is not its credential: what moves is the sealed
   * password behind it.
   */
  reseal(cookie: string | undefined, password: string, appPassword?: boolean): boolean {
    if (!cookie) return false;
    const idx = cookie.indexOf(COOKIE_SEP);
    if (idx <= 0) return false;
    const id = cookie.slice(0, idx);
    const secret = cookie.slice(idx + 1);
    const stored = this.sessions.get(sha256(id));
    if (!stored) return false;
    if (!safeEqual(stored.secretHash, sha256(secret))) return false;
    const key = deriveKey(secret, config.appSecret, Buffer.from(stored.salt, "base64"));
    stored.sealedCredentials = seal(
      JSON.stringify({ u: stored.username, p: password }),
      key,
    );
    // 2FA switch-over changes the kind of credential the session holds; a
    // plain password change keeps the kind it had.
    if (appPassword !== undefined) stored.appPassword = appPassword;
    this.scheduleSave();
    return true;
  }

  /** End one session, by the identity `resolve` and `listForUser` hand out. */
  destroy(id: string): void {
    if (this.sessions.delete(id)) {
      this.onDestroy?.(id);
      this.scheduleSave();
    }
  }

  /**
   * End every session of one account, whoever typed the address.
   *
   * An account name is an address, and addresses do not differ by case: a
   * person who signed in as `Bob@example.com` holds the same account as one
   * who typed `bob@example.com`. Comparing the two exactly would leave that
   * session signed in — which is how a lock, or a revocation, would quietly
   * miss the one session it was meant for.
   */
  destroyAllForUser(account: string, exceptId?: string): number {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (accountOf(s) === account && id !== exceptId) {
        this.sessions.delete(id);
        this.onDestroy?.(id);
        n++;
      }
    }
    if (n) this.scheduleSave();
    return n;
  }

  /**
   * Destroy every session but the one presenting itself (ADR 0001): what a
   * rule publish does so the next sign-in applies the new policy at boot.
   */
  destroyAllExcept(exceptId?: string): number {
    let n = 0;
    for (const [id] of this.sessions) {
      if (id === exceptId) continue;
      this.sessions.delete(id);
      this.onDestroy?.(id);
      n++;
    }
    if (n) this.scheduleSave();
    return n;
  }

  listForUser(account: string): SessionSummary[] {
    const out = [];
    for (const s of this.sessions.values()) {
      if (accountOf(s) !== account) continue;
      const {
        secretHash: _h,
        salt: _s,
        sealedCredentials: _c,
        appPassword: _a,
        account: _k,
        idHash,
        ...rest
      } = s;
      // The digest is the identity the rest of the server knows this session
      // by, and the whole of what is handed out.
      out.push({ id: idHash, ...rest });
    }
    return out;
  }

  private toLive(s: StoredSession, username: string, password: string): LiveSession {
    return {
      id: s.idHash,
      username,
      account: accountOf(s),
      authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
      remember: s.remember,
      appPassword: s.appPassword ?? false,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      userAgent: s.userAgent,
      ip: s.ip,
    };
  }
}
