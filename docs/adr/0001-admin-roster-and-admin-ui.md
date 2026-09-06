# ADR 0001 — Admin roster and the administration surface

Status: Proposed (2026-09-06)

## Context

Gilbert's direction is centralized administration of many accounts, but today
no account is special: every session is equal, and the only installation-wide
knob is the settings policy, read at boot from a file or the environment
(`readSettingsPolicy` in `server/src/config.ts`) and applied client-side.
There is no concept of "who administers this installation" anywhere durable.

The product direction wants:

- a durable, central list of the account names that administer the installation,
  stored inside Stalwart (architecture law: everything durable lives in
  Stalwart, no own database, disposable container);
- an administration surface inside the product that appears only to those
  admins (manage the roster, and later other functions);
- standard behaviour for everyone else, unchanged.

Facts from the current machinery:

- The browser never holds credentials. Sign-in Basic-auths to Stalwart through
  the Node server, which keeps a sealed session and proxies every JMAP call
  behind `requireSession` (`server/src/app.ts`, `POST /api/jmap`).
- Sessions live in a server-side store (`server/src/sessions.ts`) that already
  has the primitive `destroyAllForUser` (used by "sign out other sessions" and
  on credential change).
- Any 401 from an API call makes the client stop push and settings sync, clear
  signed-in data and return to the sign-in screen by itself
  (`web/src/jmap/client.ts` `handleUnauthenticated`;
  `web/src/store/session.ts` `onUnauthenticated`).
- The client session object carries `username` plus an `ihasmail` extension
  object (`web/src/jmap/types.ts`) — the natural place for an `isAdmin` flag.
- The settings policy is fetched once per page lifetime and cached client-side
  (`web/src/lib/settingsPolicy.ts`); enforced values are re-applied at
  boot/hydrate and on every settings update (`web/src/store/settings.ts`).
- Per-account durable settings live as `settings.json` in the account's own
  JMAP Files (`web/src/lib/settingsSync.ts`).
- JMAP has no cross-account namespace: a system-wide document cannot live in
  every account; it must be owned by one.

## Decision

### 1. A reserved administration account ("the holder") owns the system documents

The holder is a normal Stalwart account, provisioned by the operator. Its own
JMAP Files carry the system documents for the installation. Version 1 has one
document, `admin.json` (no product prefix on app-owned documents, following
the `settings.json` precedent):

```json
{
  "version": 1,
  "admins": ["admin@example.org"]
}
```

`admins` lists canonical principal names — the `username` Stalwart reports in
the JMAP session resource, not whatever string was typed at sign-in. The
document is validated strictly, by a single validator used both at read (boot)
and at write (the admin surface), so a malformed document can never land
silently — though unlike the settings policy a corrupt document must not
refuse boot (see Consequences).

The holder's own principal is admin **by identity, not by list** — the rule
must never depend on `admin.json` existing, or the first boot could lock
everyone out. That identity is the bootstrap: the first admin is chosen by the
operator, never discovered from a document that cannot exist before the first
admin does. A local file of admins was considered and rejected: it would be a
second source of truth next to the document, the two would drift, and a file
inside the container dies with it (architecture law: disposable container,
durable state in Stalwart only).

The first-install sequence:

1. The operator creates the holder account in Stalwart (the same way any
   account is created today) and deploys Gilbert with the holder's name in the
   environment — the one piece of operator configuration, beside
   `STALWART_URL`. The account's own credentials are the server's secret for
   reading the documents.
2. The holder signs in: the server compares the session's canonical username
   to the configured holder and treats it as admin. `admin.json` does not
   exist yet, which is the normal first-boot state.
3. From the administration surface the holder initialises `admin.json`,
   recording the roster (further admins; the holder may record itself too).
4. Afterwards the holder stays admin by identity — like root, it can never
   lock itself out — and every other account is admin only while listed.

An upgrade of an existing installation needs no migration: upstream ihasmail
has no admin concept, so there is no pre-existing list to move; the operator
names the holder and the sequence above starts there.

### 2. The server enforces, per request; the client only shows

`isAdmin` is computed server-side from the roster on every relevant request
(short-TTL in-memory cache), never sealed into the session at sign-in, so a
demotion is effective on the very next privileged request of an already open
session. Admin endpoints get a `requireAdmin` guard beside `requireSession`.
The client receives only `isAdmin: boolean` on the session's `ihasmail`
extension (added to the login and `/api/auth/session` responses), which shows
or hides the admin entry point. UI gating is cosmetic; the server is the door.

`/api/config` stays unauthenticated and must never carry the roster — no
anonymous disclosure of who administers the installation.

### 3. Propagation semantics

- **Privilege change**: enforcement is immediate (the next privileged request
  is judged against the live roster). Visible UI follows at the next session
  refresh (`GET /api/auth/session?refresh=1`, already exposed as
  `session.refresh()` in `web/src/store/session.ts`), triggered on window
  focus and after roster edits. No reload needed; a grant appears at the next
  refresh, a revocation is denied server-side at once.
- **Settings-policy change**: unchanged for now — it takes effect at the next
  full page load, because the client keeps the policy in cache for the page
  lifetime and there is no channel that pushes a policy change to open tabs
  (JMAP push only carries the user's own account state). A live push or a
  focus-based re-fetch is a possible later refinement, not v1.
- **Forced sign-out ("kick")**: an admin endpoint destroys the target user's
  sessions through the existing session-store primitive. The open client lands
  on the sign-in screen on its next request via the existing
  401 → `handleUnauthenticated` path — immediate on interaction, and for an
  idle background tab within the push reconnect backoff (≤ ~60 s) or on the
  next visibility change. No new client machinery is required in v1.
- Reload or refresh propagates changes; kick terminates sessions. The two
  tools are kept distinct on purpose.

### 4. Administration surface, version 1

Roster management (add/remove admins) and forced sign-out. Editing the
settings policy through the surface is a later step and depends on a separate
ADR that moves the policy document itself into the holder's Files; until then
the policy stays file/env as today.

## Consequences

- The server gains one new secret: the holder account's credentials (an env),
  used to read `admin.json`. Same handling class as the settings policy file.
- A **missing** `admin.json` is the normal first-boot state, not an error:
  the holder is admin by identity and initialises the document from the
  surface.
- A **corrupt** `admin.json` must not refuse boot: the holder stays admin
  (the rule never depends on the document), the server logs loudly at boot,
  the administration surface shows a permanent error banner and refuses
  roster writes until the holder rewrites the document through the surface —
  the one person who can repair it keeps the path open. This follows the
  values as the settings policy does, but loud *degradation* here instead of
  boot refusal, because the document is repaired by a product user through
  the UI, not by an operator editing a file.
- Roster changes are durable in Stalwart; the container stays disposable.
- Settings remain per-account conveniences, client-enforced; admin *actions*
  are server-enforced. Nothing in this ADR turns settings into a security
  boundary.
- New operational identifiers (holder account name, env names) follow the
  repo naming rule at implementation time; the ADR deliberately does not mint
  them.

## Alternatives considered

- **Env/file list of admins** (like the policy today): simplest, but a second
  configuration surface, not durable in Stalwart, no self-service, and a
  file/env source plus a document source would drift.
- **Roster inside the settings policy document**: wrong — different concern,
  different validator, different change cadence.
- **Client-side gating only** (an `isAdmin` flag on the session, no server
  check): rejected; anything a client can assert another client can fake.
- **The roster in every account**: rejected; per-account copies drift.

## Open questions (recorded, not blocking v1)

- Multi-Stalwart installs (`STALWART_SERVERS_FILE`): is the roster per holder
  account per server, or does one nominated holder serve the whole install?
- Stalwart account provisioning (create users, aliases, quotas) is not
  reachable over JMAP — it would take the Stalwart Management API and a
  deliberate bend of the "JMAP only" law. Explicitly out of scope here;
  revisit as a separate ADR if an admin v2 needs it.
- A document to hold the settings policy in the holder's Files (the follow-up
  that unblocks the policy editor in the surface).

## References

- `server/src/app.ts` — `requireSession`, `POST /api/jmap`, sign-out-others
- `server/src/sessions.ts` — sealed sessions, `destroyAllForUser`
- `server/src/config.ts` — `readSettingsPolicy` (file/env boot-read precedent)
- `web/src/jmap/client.ts` — 401 → `handleUnauthenticated`
- `web/src/store/session.ts` — `refresh()`, `onUnauthenticated`
- `web/src/lib/settingsPolicy.ts` — per-page policy cache
- `web/src/store/settings.ts` — `DEFAULT_SETTINGS`, enforcement door
- `web/src/lib/settingsSync.ts` — `settings.json` in the account's Files
- `web/src/jmap/types.ts` — `JmapSession.username`, `ihasmail` extension
