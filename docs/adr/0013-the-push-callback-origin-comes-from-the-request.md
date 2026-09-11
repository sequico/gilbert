# ADR 0013 — The push callback origin comes from the request, under proxy trust

Status: Proposed (2026-09-11)

## Context

A JMAP `PushSubscription` names a URL, and Stalwart POSTs its change
notifications there. RFC 8620 requires that URL to be `https`, and the address
is a fact about the deployment -- the hostname clients reach Gilbert by, which
is not necessarily the hostname it listens on, and not something Gilbert can
compute from anything it holds.

Naming that origin in configuration instead puts the deployment's own hostname
in a second place, kept in step with the proxy and the DNS by hand. It drifts
silently: the subscription is registered once with whatever was written,
Stalwart keeps POSTing to an address that may no longer resolve, and that
account stops receiving live updates while nothing reports an error. A
certificate question rides along with it, since Stalwart must trust Gilbert's
certificate and be able to reach it.

## Decision

**The origin is derived from the request, and only from a request we can
believe.** `pushOrigin()` in `server/src/app.ts` answers an `https://host` for
the request that carried the session, or `null`, when all of these hold:

- the peer address is a proxy we run -- `TRUST_PROXY` is on and the address is
  inside `TRUSTED_PROXIES` (loopback and RFC 1918 by default), the same rule
  `clientip.ts` already applies to attribution;
- the request arrived over `https` -- from `X-Forwarded-Proto` for a trusted
  peer, from the socket otherwise -- because RFC 8620 requires the scheme;
- `X-Forwarded-Host` (its first entry, the one our own proxy observed), falling
  back to `Host`, is a syntactically valid host.

`null` is not a failure state. The account keeps the per-tab relay it would have
had anyway: fan-out is an optimisation and the relay is its fallback.

**The subscription names the origin the session arrived on, and a renewal
restates it.** An entry keeps the origin it was created with, and every
`prepare()` refreshes it from the request that just arrived, so a deployment
that moved re-registers against the address actually in use rather than POSTing
into the hostname it left behind.

**`PUSH_MODE` stays the one switch.** `relay` never subscribes. `subscribe`,
the default, uses fan-out wherever an origin can be derived and the relay
everywhere else. `/api/health` reports `pushStatus`, so an operator can read
which accounts verified and how many tabs each path holds instead of guessing.

## Consequences

- A deployment behind a proxy it trusts gets fan-out with nothing to configure,
  and one that is reached directly, or over plain http, keeps the relay: nothing
  is lost, reconnecting is simply not local.
- The callback host is named by a peer that `TRUSTED_PROXIES` admits, so keeping
  that list to the proxies that actually front Gilbert is what keeps the address
  honest. A proxy that forwards the client's own `Host` instead of its own hands
  that choice to the client; the peer check is what still keeps a request that
  is not from a proxy from reaching the branch at all.
- Stalwart must accept Gilbert's certificate and reach it, which is an
  environment fact rather than a setting. A subscription that never verifies
  leaves that account `failed` on the relay, which `/api/health` reports.
- <!-- owed: push-origin-live-probe -->
