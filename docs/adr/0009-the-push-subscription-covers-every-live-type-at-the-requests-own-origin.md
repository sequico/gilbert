# ADR 0009 — The push subscription covers every live type, at the request's own origin

Live updates reach a tab by one of two transports.

The **relay** holds one Server-Sent Events stream per tab, upstream to
Stalwart and back, asking for `types=*` — every type the account has.

The **push subscription** (`server/src/push.ts`) registers one JMAP
`PushSubscription` per account and fans Stalwart's POSTs out to that
account's open tabs, holding no upstream connection of its own. That is what
makes a reconnect local instead of a fresh dial to Stalwart, and what keeps
a deployment's connection count from tracking its open tabs.

## What the subscription covers

`PUSH_STATE_TYPES` in `server/src/shared/push.ts` names every state type a
Gilbert surface keeps live, in one list, for every account: mail and its
quota, files and chat, calendars and tasks, contacts, and filters — the same
set the relay's `types=*` already covers, so which transport an account
happens to be on no longer decides which parts of the app stay live. A
personal account's own Files are as live as a group's; the condition that
once limited `FileNode` to chat-capable accounts is gone. The relay keeps
`types=*` regardless, since it is what a tab falls back to and should carry
whatever the account has.

The names are Stalwart's own `DataType` values, not capability URIs — a name
outside that enum simply fails `PushSubscription/set`, which leaves that
account on the relay rather than breaking anything. Fan-out is an
optimisation; the relay is its fallback.

## Where it POSTs

A `PushSubscription` names an `https` callback URL. `pushOrigin()` in
`server/src/app.ts` derives it from the request that carried the session,
never from configuration, answering `https://host` only when the peer is a
trusted proxy (`TRUST_PROXY`, `TRUSTED_PROXIES`), the request arrived over
`https` (from `X-Forwarded-Proto` for a trusted peer, the socket otherwise),
and the forwarded host is syntactically valid. `null` is not a failure state
— the account simply keeps the per-tab relay it would have had anyway. A
subscription keeps the origin it was created with, and every renewal
restates it from the request that just arrived, so a deployment that moves
re-registers against the address actually in use.

`PUSH_MODE` is the one switch: `relay` never subscribes; `subscribe`, the
default, uses fan-out wherever an origin can be derived and the relay
everywhere else. `/api/health` reports `pushStatus` per account, so an
operator can read which accounts verified and which path each is on.

## Consequences

- Fan-out and the relay carry the same live surfaces, so the transport a
  deployment happens to be on no longer decides which parts of the app
  update.
- The subscription set is wider, so Stalwart POSTs more: a personal
  session's own `settings.json` saves are `FileNode` changes that now
  stream back to the writing tab, as they always did on the relay — nothing
  that writes settings listens for the change, so there is no loop.
- A type added to a store but forgotten in `PUSH_STATE_TYPES` still reaches
  a relayed tab; `server/src/push.test.ts` pins the list against the stores
  that read state changes and fails first.
- The agent fleet is untouched: `TYPES_BY_AREA` in `server/src/agent/agent.ts`
  is a separate, deliberately narrower list — which types a reconciliation
  pass reads, not which types a tab is pushed.
- Nothing about the callback address is configured. A deployment behind a
  trusted proxy gets fan-out with nothing to set; one reached directly, or
  over plain http, keeps the relay — reconnecting simply is not local.
- Stalwart must accept Gilbert's certificate and be able to reach it, which
  is an environment fact rather than a setting; a subscription that never
  verifies leaves that account on the relay, reported by `/api/health`.

## References

- `server/src/shared/push.ts` — `PUSH_STATE_TYPES`
- `server/src/push.ts` — subscription lifecycle, `pushOrigin`
- `server/src/app.ts` — `pushOrigin()`, `TRUSTED_PROXIES`
- `server/src/push.test.ts` — the list pinned against the stores
- ADR 0003 — `TYPES_BY_AREA`, the agent's own narrower read
- ADR 0005 — chat's `FileNode` documents
