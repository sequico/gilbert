# ADR 0017 — Administration is a door, not a menu

Status: Proposed

Implementation: Built. `server/src/adminGate.ts` holds the allowlist
(`SELF_SERVICE`) and the two rules a session is measured against
(`administrationAllowed`, `gateAdministration`); `server/src/app.ts` refuses an
inspected `/api/jmap` body that names a registry object and enforces the same
two conditions beside `requireAdmin` on every `/api/admin` route
(`administrationRefusal`, `MAX_GATED_REQUEST`, `sessionExtras`);
`server/src/upstream.ts` compares two permission lists (`outranks`) and
`/api/admin/force-password-change` refuses with `target_outranks`;
`server/src/configuration.ts` reads `ADMINISTRATION` and
`ADMINISTRATION_NEEDS_OWN_DEVICE` for a process with no boot and
`server/src/shared/installation.ts` carries `server.administration` and
`server.administrationNeedsOwnDevice` in the installation's document; the
client follows the session's two flags (`web/src/views/AppShell.tsx`, the
`gilbert` extension in `web/src/jmap/types.ts`).

## Context

Administration is offered to a principal exactly when Stalwart's own permission
list says so (ADR 0001), and the client decides what to draw from that flag.
Two things follow from the client being the only place the decision is made,
and both are the same mistake seen from different sides.

**A menu is not a door.** The browser holds a live credential for the whole
session, and `/api/jmap` forwards whatever the browser sends — any method, any
object — authenticated as that credential. Stalwart answers each call according
to the principal's role, which is the correct and only authority; but it means
the client's restraint is the *only* thing standing between an operator's
decision and a browser console. Stalwart's registry is dozens of objects —
accounts, domains, roles, tenants, listeners, stores, tracers, system settings —
and any of them can be named in a request body by anyone the role allows.

**An operator needs a switch that means something.** A deployment may want an
installation that signs people in and offers no administration at all — a
hosted instance, an installation administered entirely through Stalwart's own
interface. Saying so has to be a fact about the installation (ADR 0011) rather
than a deployment's environment, and it has to hold against the browser, not
against the drawing of a sidebar.

A third condition is the operator's own rule rather than either of these:
administration is a session's most consequential capability, and a session is
not always on a machine its owner controls. An installation may therefore want
the session to have been signed in on a device marked as its owner's — the one
question the sign-in form already asks that says where it is being used. It is a
*restriction*, not a protection the product needs, and it is off unless the
installation states it: the sign-in form's box is about how long a session
lasts ("stay signed in"), and a shorter session is not a less trusted one. An
installation that turns it on gets the rule; one that says nothing keeps what
every installation did before this decision existed.

## Decision

**The decision is made where the request is, and the menu only announces it.**
`server/src/adminGate.ts` (**gilbertserver**) holds both halves:

- `administrationAllowed(enabled, needsOwnDevice, remember)` — the
  installation offers administration, and, *where the installation asked for
the rule*, the session was signed in on a device marked as the person's own.
- `gateAdministration(raw)` — the body of a request to `/api/jmap`, refused when
  it names a registry method the session may not reach.

**An allowlist, not a list of forbidden objects.** `SELF_SERVICE` names the
objects that are about the signed-in account itself — `AccountSettings`,
`AccountPassword`, `AppPassword`, `ApiKey`, `PublicKey`, `MaskedEmail`. Every
other `x:` object is refused without being named, so a registry object that
Stalwart adds in a later release is refused by default: the gate errs toward the
operator's decision rather than toward the next release's object list. The
standard JMAP methods — mail, calendars, contacts, files, sharing — are not
inspected at all: they act on what the account can already reach.

**What is forwarded is what was checked.** A body that could name a registry
method is parsed, and the body that goes upstream is serialised from the parsed
form. A duplicate key is read one way by `JSON.parse` and could be read the
other way by the server; forwarding the inspected form means that cannot happen.
A body that could not contain a registry method at all — no `"x:` and no `\u`,
the overwhelming majority of traffic from such a session — is passed through
byte for byte, unparsed. The check costs nothing on the path that does not need
it.

**A session that may administer pays nothing.** The gate runs only for a session
that may not: everyone else streams straight through as before, which is why the
restriction is a boundary around an exceptional case rather than a filter in
front of every request.

**The refusal names which of the two rules applied.** `administration_disabled`
or `administration_needs_own_device`, with the refused method named in the
message, because the two are fixed differently: one by the operator's
configuration, the other by signing in again on your own device. A body that is
not a JMAP request at all is a plain `bad_request` (400) rather than a refusal
about devices, so a malformed request is not reported as a policy. A body that
runs past the gate's read bound answers `too_large` (413).

**The second door.** Every route under `/api/admin` sits behind `requireAdmin`,
which enforces the same two conditions beside the Stalwart marker it already
reads fresh on every privileged call (ADR 0001). The proxy gate and the admin
routes are one decision with two entrances; an installation that turned
administration off leaves neither open, in the same change.

**An account is not acted on by one it outranks.** The admin marker answers "is
this account an administrator", which is a question about one permission —
`sysAccountCreate` by default. It does not answer the question a privileged
write has to ask: whether the account about to be acted on may hold *more* than
the account acting. Stalwart checks that a caller holds every permission they
grant when roles change and when an account is created, but not for every write,
so an account allowed to act on others could reach into one carrying a richer
custom role — a tenant administrator's, say — and force a change on it.
`outranks(viewer, target)` (`server/src/upstream.ts`) makes that comparison
against the two permission lists the server resolved for the two accounts, and
`/api/admin/force-password-change` refuses with `target_outranks` where it
holds. The caller's own list is read by the same introspection `requireAdmin`
already makes and handed to the route rather than fetched a second time.

This is a client-side comparison in the sense that matters: Stalwart remains the
authority for every call that is actually made. Its purpose is that this product
does not build a path to acting on an account more privileged than the one
acting, and the second reason is that Stalwart does not re-check the
comparison for every write. A target whose list cannot be read is a failed
introspection and is refused as an upstream failure, which is the same answer
the route gives when the acting administrator's own list cannot be read.

**The switch is the installation's, in the installation's document.** The
`ADMINISTRATION` environment variable is the reading a process with no boot
uses, and `server.administration` in `installation.json` is the same value in a
booted deployment — one field, two readings (ADR 0011). The default is on: an
installation that has said nothing offers administration the way it always has.
The own-device rule follows the same shape (`ADMINISTRATION_NEEDS_OWN_DEVICE`,
`server.administrationNeedsOwnDevice`) and defaults to off, which is what makes
it a deployment's stated choice rather than a change to everyone's sign-in.

**The client is told which case it is in, and says so.** The session extension
carries `administration` (whether this session may administer at all) and
`administrationNeedsOwnDevice` (an administrator whom the own-device rule
stopped, which is false wherever the installation did not ask for it), the
latter derived from the same admin test the menu makes rather than from the
permissions themselves. The admin entry point follows `administration`; where
the second flag holds, the menu shows the entry disabled, with the reason in
words — losing an entry without a word is how an administrator concludes the
product is broken. Neither flag is a grant: the server is the door and the
client is cosmetic, exactly as in ADR 0001.

## Consequences

- Turning administration off is a property of the installation, not of the
  deployment's environment, and it holds against the browser's console rather
  than only against the interface. Stalwart's own administration interface is
  unaffected either way: the switch is a statement about what *this product*
  offers, not about the server.
- An administrator on a forbidden machine is a reader with a session and no
  administrative reach. They are told why, and signing in on their own device
  restores it; a session already open is not promoted. An installation that did
  not ask for the rule notices nothing: the default is unchanged behaviour.
- The gate is a boundary on the registry, not a capability system: it says
  nothing about what Stalwart will agree to, and every call still passes
  Stalwart's own permission checks. A request the gate lets through is a request
  whose object is about the account, not one that is known to be allowed.
- A registry object that is genuinely self-service and not in `SELF_SERVICE` is
  refused until it is listed, which is the direction the list is built to fail
  in.
- The gate reads a request body into memory up to a fixed bound. Uploads do not
  travel this route, and Stalwart's own default request bound is smaller.

## References

- The administration has a floor as well as a ceiling: a marker decides whether
  an account may act at all, and the comparison decides which accounts it may
  act on. An installation whose administration is a single role sees no change —
  the marker and the comparison agree on every account there.
- `server/src/upstream.ts` — `isStalwartAdmin`, `outranks`
- `server/src/app.ts` — the `/api/jmap` gate, `administrationRefusal`,
  `requireAdmin`, `MAX_GATED_REQUEST`, `sessionExtras`, the force-password route
- `server/src/adminGate.ts` — `administrationAllowed`, `gateAdministration`,
  `mayNameRegistryMethod`, `SELF_SERVICE`
- `server/src/configuration.ts` — `ADMINISTRATION` and
  `ADMINISTRATION_NEEDS_OWN_DEVICE`, the readings with no boot
- `server/src/shared/installation.ts` — `server.administration` and
  `server.administrationNeedsOwnDevice`, the document's fields
- `web/src/views/AppShell.tsx` — the admin entry point and the disabled
  explanation
- ADR 0001 — the admin grant, `requireAdmin`, and the client's cosmetic flag
- ADR 0011 — the installation's configuration, its document and its environment
