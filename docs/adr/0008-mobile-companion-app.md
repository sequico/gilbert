# ADR 0008 — Mobile companion app: installable Android/iOS notifier, deep-linking into the web client

Status: Proposed (2026-09-09)

> Owner request recorded 2026-09-09: evaluate the effort for a **later**
> project — a minimal installable Android and iOS app, built as a parallel
> project in this repository, that holds multiple Gilbert identities
> (server name, user, password), stays registered to notify on mobile when
> chat and mail messages arrive, and when a notification is tapped opens
> the web client in the mobile system browser — authenticating if needed —
> showing the object that was tapped. Nothing is scheduled; this ADR
> records the design and the effort evaluation so the decision is
> reviewable before any implementation. Status stays Proposed until the
> owner accepts it.

## Context

The full UI of Gilbert is the web client. This ADR is about a **companion**,
not a second client: it never renders mail or chat content, it notifies and
it hands off to the browser.

Mobile OS reality shapes the design more than anything else:

- iOS and Android do not allow an app to stay connected forever in the
  background. A native app cannot "remain authenticated by holding a live
  session"; real-time arrival notifications must come from the OS push
  services (APNs on iOS, FCM on Android). Everything else (periodic
  background polling) is best-effort and OS-scheduled, not real-time.
- A native app also cannot act as an RFC 8030 web-push endpoint. The push
  rail this repository already has (web push with VAPID, subscribed by the
  browser) does not reach a native app directly; the last mile to the phone
  is APNs/FCM.

What Gilbert already has, and the mobile design builds on:

- **RFC 8620 §7.2 `PushSubscription` is implemented and in production**
  (`server/src/push.ts`): the Gilbert server registers one subscription per
  account with Stalwart, Stalwart POSTs `StateChange` objects to an https
  URL on Gilbert's own public origin, and Gilbert fans the change out to
  that account's open tabs over browser-facing streams. The per-account
  subscription is Stalwart's own durable record — it needs no user session
  to keep delivering, and it survives Gilbert container restarts.
  Today it covers mail (`urn:ietf:params:jmap:mail`) only; Stalwart accepts
  `types: ["FileNode"]` as well (verified live 2026-09-07), which is how
  chat arrivals ride (ADR 0006: chat messages are FileNode documents in the
  group account's `gilbert/chat` folder, state changes pushed per account).
- **Per-device web push** for browsers exists end to end
  (`web/src/lib/webpush.ts`, `webpushEnable.ts`: `deviceClientId`, the
  `gilbert-push-verification` path, per-account `PushSubscription/set` with
  `types`), including mock parity. A mobile install is another "device"
  with the same shape — except its last mile is APNs/FCM, not a browser
  push service.

Architecture-law constraints that the design must satisfy:

- Everything durable lives in Stalwart; the Gilbert container is
  disposable. A device registration must therefore survive as Stalwart
  state — the account's own `PushSubscription` records plus a small
  registration document in the account's own Files (the `settings.json`
  precedent in the `gilbert` app folder), never in a Gilbert-side file.
- The server never holds a plaintext credential beyond the sign-in
  exchange. The identity's password lives **only in the phone's OS
  keychain**; the durable push rail is the account-scoped Stalwart
  subscription, which authenticates nobody — it is a delivery record, not
  a session.
- Graceful degradation per capability: an installation whose network
  blocks egress to APNs/FCM (or a server that never verifies an https
  subscription URL) simply has no native push; the app degrades to
  notifications only while it can reach the server.
- Naming law: the app is a Gilbert product surface; folder `mobile/`,
  package `@gilbert/mobile`, visible name "Gilbert".

Scope assumed for the effort evaluation: Expo (React Native, TypeScript,
managed workflow) as a new npm workspace in this repo, one developer, both
platforms from one codebase, the web client and `server/` already built as
described above. No new repository beyond this one, no new durable store.

## Decision

### 1. Companion-only by design

The app stores identities (label, server URL, user, password) in the OS
keychain (`expo-secure-store`) and shows arrival notifications; it never
fetches or renders message bodies. Tapping a notification opens the
identity's web client in the **system browser** at a target route; the web
client performs its own sign-in (this is the "authenticates if needed"
step, unchanged from today) and shows the tapped object. The app's only
network act besides notification plumbing is a lightweight reachability and
capability probe per identity (e.g. the `/api/config` or session shape the
web sign-in already uses) so a mis-typed server fails fast at entry time.

### 2. Native push rides the existing per-account PushSubscription

Extend the fan-out of `server/src/push.ts` with a **mobile leg**
(implemented in a new `server/src/mobilePush.ts` beside it):

- The per-account Stalwart subscription whose URL is Gilbert's own origin
  already names every type a surface watches (ADR 0012), so mail (`Email`)
  and chat (`FileNode`) StateChanges both arrive at the same Gilbert
  endpoint (per-account subscriptions, one per
  account the user session sees — personal plus each group mailbox — the
  same account set the web client already subscribes).
- When a StateChange lands, the existing fan-out keeps serving open tabs
  unchanged; the new mobile leg looks up the account's registered devices
  and forwards a **content-free alert** (account id, object type + id,
  display name of the mailbox/thread) to the device's OS push token.
- First implementation should use the Expo Push Service as the APNs/FCM
  bridge (no raw Apple/Google plumbing, one token per install), with the
  direct APNs/FCM sender as a follow-up for store builds — the transport
  behind the Gilbert server endpoint stays the same either way.

The payload carries an object reference only; full content is never pushed
through any third party. The web client is the only renderer, and it
re-authenticates on its own before showing anything.

### 3. Registration and durability

- The app signs in normally (Basic over TLS against the identity's server,
  app-password semantics for 2FA accounts, per the Stalwart quirk already
  documented) — long enough to register; it holds no session afterwards.
- A new authenticated endpoint, `/api/mobile-push/register`, records the
  device in the account's own Files (`mobile-push.json` in the `gilbert`
  app folder, next to `settings.json`; account-synced semantics, deleted
  on device removal) and ensures the account's Stalwart subscription is in
  place with the right `types`. The record stores the OS push token and a
  per-install `deviceId` (reusing the `deviceClientId` pattern), never a
  password.
- One identity may register several devices; one app install holds several
  identities, each with independent registration and per-identity
  notification settings (mail on/off, chat on/off, mute).

### 4. Tap-to-object

The web client gets a small deep-link mechanism: a route/URL carrying a
pending target (a mail message id or a chat thread) that the SPA resolves
after its own sign-in, mirroring the existing per-account route structure.
The message view and chat panel already exist; wiring a target parameter
and a post-auth redirect is the whole web-side change.

### 5. Non-goals for v1

Reading or sending mail/chat inside the app; background sync beyond
notifications; smartwatch support; App Store / Play Store publication and
store CI (releases stay manual per standing rule). Android side-loading and
iOS TestFlight are the v1 distribution paths unless the owner says
otherwise.

### 6. Effort estimate (owner-requested evaluation, 2026-09-09)

Assumptions: one full-stack developer; Expo managed workflow, both
platforms, one codebase; existing `server/src/push.ts` rail reused;
notifications via the Expo Push Service in development; no store
publication in the estimate; mock parity and the repo's prepush gate
included; surprises in the Stalwart open questions below excluded.

| Phase | Work | Dev-days |
| --- | --- | --- |
| P1 | `mobile/` npm workspace scaffold, Expo app booting on Android + iOS, keychain plumbing, navigation | 2–3 |
| P2 | Identity vault: add/edit/list/remove multiple identities, server/user/password entry, reachability + capability probe, validation UX | 2–3 |
| P3 | Server: `/api/mobile-push` endpoints, `mobile-push.json` in the account's Files, per-account subscription types incl. FileNode, mobile leg in the fan-out, mock parity, tests | 4–6 |
| P4 | App notifications: OS push token registration, foreground/background/killed handlers, tap → system browser at the target route, per-identity settings | 2–3 |
| P5 | Web deep-link target: pending-target route + post-auth redirect for a mail message and a chat thread, verified on `dev:mock` | 2–3 |
| P6 | End-to-end on real devices against a real Stalwart; device removal/revocation and token rotation; multiple identities and devices; docs, ADR finalization, FEATURES.md | 3–5 |

**Total: 15–23 dev-days** (roughly 3–5 weeks for one developer working
full-time) for a working, tested v1 on both platforms without store
publication. Two external, non-estimable calendar items sit on top when the
owner wants store distribution: an Apple Developer Program account and an
APNs key / FCM project (or Expo's managed credentials) and their approval
latency; budgeting 1–2 calendar weeks of waiting is realistic, plus a few
more dev-days for store signing, screenshots and review compliance.
Direct APNs/FCM instead of the Expo Push Service adds roughly 2–3 dev-days
and is only needed for store builds.

## Consequences

- The web client remains the only surface that renders content; the phone
  holds identities and alerts. Losing the phone (or the app) leaks account
  *names* at most — credentials sit in the OS keychain, and device
  removal/revocation is a server-side delete of the Files record plus the
  Stalwart subscription cleanup.
- `server/src/push.ts` grows a second fan-out leg and its subscription
  gains `FileNode` for chat-capable accounts; the codebase keeps the
  discipline already proven there — one subscription per account, nothing
  held upstream, mock parity in `server/src/mock/index.ts`.
- Native push requires egress from the Gilbert server to APNs/FCM (or the
  Expo Push Service). Installations that block that egress degrade to
  no-native-push (app-side notifications only while the app can reach the
  server) — consistent with the degrade-gracefully value; this is a
  deployment fact the release docs must state, not a bug.
- A new small durable document shape (`mobile-push.json`, per account) and
  a new authenticated API surface join the security review surface; both
  follow existing patterns (account Files, settings-file semantics) and
  add no new standing secret.
- App copy and its languages are a **new i18n surface** outside the web
  catalogs (`web/src/locales`); the app strings follow the same
  English-source-key rule but need their own mechanism — decide with
  `gilbert-i18n` when implementation starts.

## Alternatives considered

- **A pure web/PWA notification path (no native app)**: cheapest by far,
  but rejected against the request — web push delivers only while the
  browser's push service reaches the device, works unreliably on iOS
  Safari, and cannot be an "installed app that stays registered" surface
  with a keychain vault.
- **The app polls each identity's server in the background and shows local
  notifications**: no server change and no APNs/FCM dependency, but iOS
  schedules background refreshes opportunistically, so "arrival"
  notifications are delayed by OS policy — not real-time. Recorded as the
  fallback for installs where native push is impossible (no egress), which
  is exactly the graceful-degradation case in Consequences.
- **A third-party hosted bridge** (push gateway as a service): rejected —
  the identity's credentials or its push rail would cross a party the user
  did not choose; the design above keeps the bridge inside the user's own
  Gilbert server.

## Open questions (recorded; each changes the estimate if answered
differently)

- **Stalwart subscription URL on Gilbert's own origin, extended with
  `FileNode`**: the pattern is proven for mail (push.ts), and Stalwart
  accepts `FileNode` in `types` (live 2026-09-07); confirm on a real 0.16.x
  server that one subscription can carry both types and that chat group
  accounts deliver while the user holds no open session (they should — the
  subscription is account-scoped, not session-scoped).
- **Expo Push Service vs direct APNs/FCM**: the estimate assumes Expo in
  v1; a store build needs the direct path. Decide when store publication
  is actually scheduled.
- **Two-factor accounts**: registration uses app passwords (Basic + `$<totp>`)
  per the documented quirk; confirm the UX wording so users understand why
  their main password may be refused.
- **Web deep-link shape**: the SPA's route structure needs a pending-target
  parameter and post-auth redirect; confirm against the real router before
  P5.
- **App strings/i18n**: which languages ship in the app's own catalog
  mechanism (see Consequences).
- Whether the app is also expected to notify for **directly-shared**
  (non-group) content the user added deliberately — out of scope for v1
  unless the owner says otherwise; group chat and the user's own mail are
  the requested targets.

## References

- ADR 0006 — group chat (FileNode documents in the group account; chat
  arrivals = FileNode StateChanges)
- ADR 0007 — Stalwart admin is the Gilbert admin (future relation if the
  companion ever becomes an agent surface; not required for this design)
- `server/src/push.ts` — the per-account RFC 8620 §7.2 PushSubscription
  rail this design extends
- `web/src/lib/webpush.ts`, `web/src/lib/webpushEnable.ts` — the per-device
  registration pattern (`deviceClientId`,
  `/gilbert-push-verification`) the mobile registration mirrors
- `web/src/lib/settingsSync.ts` — the account-Files document precedent
  (`settings.json` in the `gilbert` app folder) reused for
  `mobile-push.json`
- `web/src/store/session.ts`, `server/src/account.ts` — sign-in and the
  account set (personal + group mailboxes) the registration iterates
