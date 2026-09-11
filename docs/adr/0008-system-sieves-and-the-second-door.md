# ADR 0008 — System sieves, and the second door to Stalwart

Status: Proposed (2026-09-11)

## Context

This is **gilbertstalwart**, one of the four blocks `README.md` names, and the
first surface of that block to write the server's own configuration.

**A server's own scripts are configuration, not account data.** A system Sieve
script is loaded by Stalwart at boot
(`crates/common/src/config/mailstore/scripts.rs:150`), and that load is what
makes it a *trusted* script — the kind the MTA stages run, at `ehlo`, `mail`,
`rcpt` and `data` (`crates/smtp/src/inbound/data.rs:648` and its siblings). It
is where a script that applies to every message lives rather than to one
account, and no JMAP object carries one: JMAP's `SieveScript` is per-account,
which is what the client already writes for a person's own filters.

**The management API is the door, and it needs no second credential.** The
server's own configuration is written through it, authenticated the way this
product already authenticates — HTTP Basic with the principal's own credential,
on the same HTTP listener (`crates/http/src/api/mod.rs:359`, routed under
`/api/…` in `crates/http/src/request.rs:471`). The administration holds that
credential for the signed-in administrator already (`LiveSession.authorization`,
`server/src/sessions.ts:33-46`). So this is a second door and not a second
secret, and it is the one place in this product where a request to Stalwart is
not JMAP.

**What decides whether the door opens is a permission, not a role name.**
`sysSieveSystemScriptGet`, `Query`, `Create`, `Update` and `Destroy`
(`crates/registry/src/schema/properties_impl.rs:3722`, `:3798`, `:4235-4237`).
By the server's own defaults those land in the superuser set
(`crates/common/src/auth/permissions.rs:300-305`) — but a role is data and not a
ladder: it carries `enabledPermissions` and `disabledPermissions`
(`crates/registry/src/schema/structs.rs:4484-4495`), so an installation that
would rather not hand out superuser grants exactly these and no more.

## Decision

1. **The administration edits the server's system sieves.** A **System sieves**
   section under the Stalwart group lists and edits them: the scripts that run
   for every message, which is what makes them the server's rather than one
   account's.
2. **It writes through the management API, as the administrator who is signed
   in.** No service credential is introduced and none is stored: the request
   carries the session's own authorization, and Stalwart's permission model is
   the whole of the gate. This is the one deliberate exception to "JMAP only",
   written down rather than left to be discovered — one object, because a
   surface the product owns needs it, and not directory administration, which
   stays where ADR 0001 put it.
3. **A section that cannot be used is still shown, and says what it needs.** An
   administrator whose principal does not hold those permissions sees the
   section with the missing privilege named, rather than a section that is not
   there or a failure that reads as a bug. A hidden section cannot be told from
   a product that is broken, and the person who has to ask for the privilege is
   the person looking at the page.
4. **Nothing is implied about the data.** Without `get` there is no list to
   show, so the section carries the sentence and never an empty table: an empty
   table says "this server runs no scripts", which is a different statement and
   an untrue one.

## Consequences

- The product reaches Stalwart by JMAP everywhere except here, and the
  exception is one object wide. A future surface that wants the same door is a
  new decision, not a precedent this one sets by accident.
- Least privilege is available and is the intended path: an installation that
  would rather its Gilbert administrators were not Stalwart superusers grants a
  role carrying `sysSieveSystemScript*` and nothing more. Granting it is
  Stalwart's own administration, once, and not something this product does.
- Nothing durable is added anywhere: the scripts live in Stalwart's own
  configuration, the credential lives in the session, and the container stays
  disposable.
- A script written here is not one account's — it runs wherever it is bound, for
  every message those stages see. That is what the section is for and it is
  also the risk, so the surface says which stages a script will run at, where
  it is written.
