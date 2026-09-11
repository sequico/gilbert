# ADR 0012 — The push subscription covers every type a surface keeps live

Status: Proposed (2026-09-11)

## Context

Live updates reach a tab by one of two transports, and they do not carry the
same types.

The **relay** holds one Server-Sent Events stream per tab, upstream to Stalwart
and back, and asks for `types=*` — every type the account has.

The **push subscription** (`server/src/push.ts`, the fan-out of ADR 0006)
registers one JMAP `PushSubscription` per account and fans Stalwart's POSTs out
to that account's open tabs, holding no upstream connection at all. That is what
makes a reconnect local instead of a fresh dial to Stalwart, and what keeps a
deployment's connection count from tracking its open tabs.

Stalwart POSTs a subscriber **only the types that subscription asked for**, and
that subscription asked for a mail-only list — `Email`, `Mailbox`, `Thread`,
`Identity`, `EmailSubmission`, `VacationResponse` — plus `FileNode` for a
session that held a group mailbox, because chat messages are FileNodes in the
group's app folder (ADR 0006).

Every store the client routes state changes to watches more than that. The
calendar and tasks watch `Calendar` and `CalendarEvent`; contacts watch
`AddressBook` and `ContactCard`; filters watch `SieveScript`; files and chat
watch `FileNode`; the storage bar watches `Quota`. The relay reached all of
them. The subscription reached none of the last five groups.

So fan-out **changed which parts of the app were live**, and the change was
invisible: an account on fan-out got a calendar that stopped updating, a contact
list that stopped updating, and a files view that waited for a manual refresh,
while the mail in the same tab stayed live. The two transports disagreed, and
nothing said so.

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
- <!-- owed: push-types-live-probe -->
