# ADR 0012 — The push subscription covers every live type, at the request's own origin

Status: Proposed (2026-09-11)

## Context

Live updates reach a tab by one of two transports.

The **relay** holds one Server-Sent Events stream per tab, upstream to Stalwart
and back, and asks for `types=*` — every type the account has.

The **push subscription** (`server/src/push.ts`, the fan-out of ADR 0006)
registers one JMAP `PushSubscription` per account and fans Stalwart's POSTs out
to that account's open tabs, holding no upstream connection at all. That is what
makes a reconnect local instead of a fresh dial to Stalwart, and what keeps a
deployment's connection count from tracking its open tabs.

Two things about that subscription decide whether it is equivalent to the relay.

**What it asked for.** Stalwart POSTs a subscriber only the types that
subscription asked for, and the subscription asked for a mail-only list —
`Email`, `Mailbox`, `Thread`, `Identity`, `EmailSubmission`, `VacationResponse`
— plus `FileNode` for a session that held a group mailbox, because chat messages
are FileNodes in the group's app folder (ADR 0006). Every store the client
routes state changes to watches more than that: the calendar and tasks watch
`Calendar` and `CalendarEvent`; contacts watch `AddressBook` and `ContactCard`;
filters watch `SieveScript`; files and chat watch `FileNode`; the storage bar
watches `Quota`. The relay reached all of them, and the subscription reached
none of the last five groups. Fan-out therefore **changed which parts of the app
were live**, invisibly: an account on fan-out got a calendar that stopped
updating, a contact list that stopped updating, and a files view that waited for
a manual refresh, while the mail in the same tab stayed live.

**Where it POSTs back.** A `PushSubscription` names a URL, and RFC 8620 requires
it to be `https`. The address is a fact about the deployment — the hostname
clients reach Gilbert by, which is not necessarily the hostname it listens on,
and not something Gilbert holds anywhere. Naming that origin in configuration
instead puts the deployment's own hostname in a second place, kept in step with
the proxy and the DNS by hand, and it drifts silently: the subscription is
registered once with whatever was written, Stalwart keeps POSTing to an address
that may no longer resolve, and that account stops receiving live updates while
nothing reports an error. A certificate question rides along with it, since
Stalwart must trust Gilbert's certificate and be able to reach it.

## Decision

**The push subscription names every state type a Gilbert surface keeps live,
from one list, for every account.** `PUSH_STATE_TYPES` in
`server/src/shared/push.ts` is that list; `subscribe()` reads it. It is mail and
its quota, files and chat, calendars and tasks, contacts, and filters — the same
set the relay's `types=*` already covered, so which transport a deployment
happens to be on no longer decides which parts of the app update.

**The chat-only `FileNode` condition goes with the mail-only list.** A personal
account's files are as live as a group's. The relay already streamed them.

**The types are state types, not capabilities.** Stalwart parses them from its
`DataType` enum, which has no whitelist, and does not require the matching
`urn:…` in the request's `using` — the FileNode subscription already ships with
core and mail alone. A name outside the enum fails the `PushSubscription/set`,
which leaves that account `failed` and on the relay rather than breaking
anything: the fan-out is an optimisation and the relay is its fallback.

**The relay keeps `types=*` and is deliberately the superset.** It is what a tab
falls back to, so it should carry anything the account has, listed or not.

**The callback origin is derived from the request, and only from a request we
can believe.** `pushOrigin()` in `server/src/app.ts` answers an `https://host`
for the request that carried the session, or `null`, when all of these hold: the
peer address is a proxy we run (`TRUST_PROXY` on and the address inside
`TRUSTED_PROXIES`, loopback and RFC 1918 by default — the rule `clientip.ts`
already applies to attribution); the request arrived over `https`, read from
`X-Forwarded-Proto` for a trusted peer and from the socket otherwise, because
RFC 8620 requires the scheme; and `X-Forwarded-Host` (its first entry, the one
our own proxy observed), falling back to `Host`, is a syntactically valid host.
`null` is not a failure state: the account keeps the per-tab relay it would have
had anyway.

**The subscription names the origin the session arrived on, and a renewal
restates it.** An entry keeps the origin it was created with, and every
`prepare()` refreshes it from the request that just arrived, so a deployment
that moved re-registers against the address actually in use rather than POSTing
into the hostname it left behind.

**`PUSH_MODE` stays the one switch.** `relay` never subscribes; `subscribe`, the
default, uses fan-out wherever an origin can be derived and the relay everywhere
else. `/api/health` reports `pushStatus`, so an operator can read which accounts
verified and how many tabs each path holds instead of guessing.

## Consequences

- Fan-out carries the same live surfaces the relay carried (see
  `PUSH_STATE_TYPES`), so which transport an account is on no longer decides
  which parts of the app update.
- The subscription set is wider, so Stalwart POSTs more. A personal session's
  own `settings.json` saves are `FileNode` changes and now stream back to the
  writing tab as they always did on the relay; the files store reloads its tree
  when it hears one. There is no loop — nothing that writes settings listens for
  the change.
- A type added to a store but forgotten in `PUSH_STATE_TYPES` still reaches a
  relayed tab, and the tests in `server/src/push.test.ts` fail first: one pins
  the subscription to the list, the other reads the stores and fails on a type
  the list does not carry.
- The agent worker is untouched. Its `TYPES_BY_AREA`
  (`server/src/agent/worker.ts`) is a different thing — which types a
  reconciliation pass reads — and is deliberately narrower.
- Nothing about the callback address is configured, so a deployment behind a
  proxy it trusts gets fan-out with nothing to set, and one reached directly, or
  over plain http, keeps the relay: nothing is lost, reconnecting is simply not
  local.
- The callback host is named by a peer that `TRUSTED_PROXIES` admits, so keeping
  that list to the proxies that actually front Gilbert is what keeps the address
  honest. A proxy that forwards the client's own `Host` instead of its own hands
  that choice to the client; the peer check is what still keeps a request that
  is not from a proxy from reaching the branch at all.
- Stalwart must accept Gilbert's certificate and reach it, which is an
  environment fact rather than a setting. A subscription that never verifies
  leaves that account `failed` on the relay, which `/api/health` reports.
