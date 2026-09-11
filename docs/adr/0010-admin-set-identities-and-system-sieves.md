# ADR 0010 — Admin-set identities, and the server's system sieves

Status: Proposed (2026-09-11)

> **Owner direction (2026-09-11):** an administrator sets a principal's
> identity — display name, address, reply-to and signature — through the same
> form the person's own settings use, and a principal the administrator has
> taken over is not offered that section at all.

## Context

**An identity belongs to the account and is written by it.** A principal's
identity carries a display name, an address, a `replyTo` and a signature — text
and HTML, the latter capped by Stalwart at 2 KB of UTF-8, with longer ones kept
in the account's own Files behind a marker. A person edits their own in
Settings → Identities & signatures.

**The signature is put on the message by whoever writes it.** The composer and
the agent go through one function (`server/src/shared/signature.ts`), so the
same rule applies to a person's mail and to a group's. The consequence is the
shape of this feature: an identity reaches the mail **composed in Gilbert**. A
message written in another client carries that client's own body and that
client's own signature, and nothing of ours is added to it — there is no
server-side footer here, and none is planned.

**An identity is a JMAP object, so no second door is needed to write one.** An
account writes its own; an administrator writes a person's by impersonating
them from their own live session — the door app-password rotation already uses
(`openAgentSession`, `impersonateAs` in `server/src/agentAdmin.ts`). The gate is
Stalwart's own permission model, and nothing about this feature reaches the
server's configuration.

**Two refusals are Stalwart's, and this repository already models both.**

- **A group mailbox cannot be impersonated.** The composite `{group}%{admin}`
  answers 403 (live-verified 2026-09-09, `server/src/agentAdmin.ts:189`); group
  principals never authenticate, directly or as an impersonation target
  (`server/src/mock/index.ts:3835`, which reproduces the refusal so no surface
  can lean on it). What reaches a group's account instead is **membership**: a
  member already holds the group's account in their own session, and its
  documents are read and written with their own credentials — the door
  `resolveGroupAccess` implements, with a refusal that names the membership.
  (Membership is the door the product takes; it is not a boundary against an
  administrator, as decision 6 records.)
- **An app-password session cannot impersonate at all.** Stalwart refuses it,
  and `impersonationAuthorization` returns `null` for one
  (`server/src/sessions.ts:119`) rather than trying. An administrator who
  signed in with an app password — which is how a 2FA account signs in — cannot
  use the person-identity surface.

**One link is assumed rather than observed.** That a member reaches a group's
account is verified live — Files, calendars and address books are written with
the member's own credentials. That the same member may write that account's
**`Identity`** object is an assumption: every group surface this feature
resembles works, so there is no reason to expect otherwise, and the first run
against a live server is what settles it. If it refuses, the surface reports
the refusal where a person will see it rather than failing quietly.

**Writing the server's own scripts is not JMAP, and needs no new credential.**
A system Sieve script is a configuration object, not account data: Stalwart
loads it at boot (`crates/common/src/config/mailstore/scripts.rs:150`, which is
what makes it a *trusted* script, one the MTA stages can run) and it is managed
through the server's **management API**, which authenticates the way this
product already authenticates — HTTP Basic with the principal's own credential,
on the same HTTP listener (`crates/http/src/api/mod.rs:359`, routed under
`/api/…` in `crates/http/src/request.rs:471`). The administration holds that
credential for the signed-in administrator already (`LiveSession.authorization`,
`server/src/sessions.ts:33-46`), so this is a second door and not a second
secret. What decides whether it opens is a **permission**, not a role name:
`sysSieveSystemScriptGet`, `Query`, `Create`, `Update`, `Destroy`
(`crates/registry/src/schema/properties_impl.rs:3722`, `:3798`, `:4235-4237`).
By the server's own defaults those land in the superuser set
(`crates/common/src/auth/permissions.rs:300-305`), and a role is data, so an
installation that does not want to hand out superuser grants a role carrying
exactly those (`enabledPermissions`/`disabledPermissions`,
`crates/registry/src/schema/structs.rs:4484-4495`).

## Decision

The administration gains **User identities** and **Group identities**, under
the existing **Stalwart** group of the admin navigation.

1. **A person's identity is set by an administrator, through the person's own
   form.** Display name, address, `replyTo` and signature are edited in the
   same form a person's own settings use, so an identity means the same thing
   wherever it is written and there is one definition of it. The write is an
   impersonation from the administrator's own session: no new credential, no
   second door, and Stalwart's permission model stays the whole of the gate.
   A person may hold **several** identities, and the surface edits them as a
   list: **every** identity the account holds, including ones the person
   created before the administrator took it over. The administrator may add,
   change and remove them — nothing is left behind as an identity the
   administrator cannot see and the composer still offers.

   Removal asks the server first: an identity carries `mayDelete`, which is
   Stalwart's own answer to whether it may go, and the surface respects that
   flag rather than inventing a rule of its own about the last one — the same
   flag the person's own settings already read
   (`web/src/views/settings/IdentitiesSettings.tsx:119`).
2. **A group's identity is set through the installation's agent.** The agent
   is a principal the installation already has; ADR 0003 makes it a member of
   every group the installation is granted on, and the administration can act
   as it by impersonation — `openAgentSession`, the door the agent's own
   surfaces already use. The write is therefore made **as the agent**, always:
   one actor that exists for this purpose and is named in the record, rather
   than a member the administrator happens to borrow for the occasion.

   No new credential and no second door: the agent's session is a JMAP session
   like any other. Where the agent is **not granted** on a group, the surface
   says so and names the grant that is missing, the way the group surfaces
   already name what a person lacks, rather than a permission error that would
   read as a bug.
3. **A group holds one identity; a person may hold several.** This is a rule
   of the product, not of the server, and the record says so: Stalwart allows
   several identities per account, including a group's. The group surface
   offers one and keeps it that way, because a group mailbox sends as itself;
   the person's surface is a list because a person sends as several.
4. **A principal the administrator has taken over is locked.** The lock is
   recorded in the installation's policy document, beside the settings policy,
   and its effect is that the person's **Identities & signatures** section is
   not shown: the product offers them no path to add, change or remove an
   identity, and no path to a signature of their own. What the administrator
   set stays what the product sends.
5. **The lock is a rule about the surface, and the record says so rather than
   implying otherwise.** Stalwart has no per-field permission on an identity,
   so a principal who uses a JMAP client directly can still write one; what the
   lock guarantees is that this product does not offer the edit, and that what
   the administrator set is what the product shows and sends until somebody
   changes it on purpose.
6. **Membership is the same kind of rule, and is stated as the same kind.** An
   administrator who holds Stalwart's `impersonate` right can reach a group's
   account another way: impersonate any member of that group, whose own session
   already holds it — one impersonation, and no chaining, because the composite
   username has no third part. The parser drops everything between the first
   and the last `%` (`crates/common/src/auth/authentication.rs:578-600`), so
   `{group}%{user}%{admin}` is read as impersonating the group as the
   administrator: what is refused anyway, only less visibly.

   The product does not take that road. It writes as the **agent**, whose
   membership of a group is a grant the installation made on purpose and whose
   name in the record is the right one, instead of a person the administrator
   picked. What the rules here guarantee is what the product offers and **who
   it says did it** — not what an administrator determined to reach an account
   can reach.
7. **The administration edits the server's system sieves.** A **System sieves**
   section under the Stalwart group lists and edits the server's system Sieve
   scripts — the trusted ones the MTA stages run, which is where a script that
   applies to every message lives rather than to one account.

   Writing them is server configuration and JMAP has no object for it, so the
   section writes through Stalwart's **management API**, as the signed-in
   administrator and with the credential the session already holds: a second
   door, and not a second secret. The gate is Stalwart's permission on the
   object (`sysSieveSystemScript*`), which the defaults put in the superuser
   set — an installation that would rather not hand that out grants a role
   carrying exactly those permissions, and that is Stalwart's administration to
   do, once. This is the one place the product reaches the server by something
   other than JMAP, and the record says so: one object, because a surface the
   product owns needs it — not directory administration, which stays where ADR
   0001 put it.
8. **A section that cannot be used is still shown, and says what it needs.** An
   administrator whose principal does not hold those permissions sees the
   section with the missing privilege named, rather than a section that is not
   there or a failure that reads as a bug. Two reasons, and the second is the
   one that decided it: a hidden section cannot be told from a product that is
   broken, and the person who has to ask for the privilege is the person
   looking at the page. Nothing is implied about the data — without `get` there
   is no list to show, so the section carries the sentence and never an empty
   table that would read as "this server runs no scripts".

## Consequences
- The feature is JMAP with one deliberate exception: the system sieves are
  server configuration, written through Stalwart's management API as the
  administrator who is signed in. No server configuration is written anywhere
  else, no new credential exists, and nothing has to survive a container
  restart outside Stalwart.
- Least privilege is available and is the intended path: an installation that
  does not want its Gilbert administrators to be Stalwart superusers grants a
  role carrying `sysSieveSystemScript*` and nothing more, and every other
  surface here needs no permission beyond the ones an administrator already
  holds.
- Reach is stated instead of assumed: identities shape the mail **composed in
  Gilbert**. Mail written in another client is that client's business, and
  there is no server-side footer that would have reached it.
- An administrator is not universally able to do this, and which limit
  applies is said on the surface: impersonation needs a session that is not an
  app password, and a group needs the **agent** to be granted on it.
- Locking a person removes their signature editing along with their identity
  editing, which is the point of the lock and is said in the surface that
  applies it.
- Nothing here reads or writes Stalwart's configuration, so an installation
  needs no permission beyond the ones its administrators already hold.
