# ADR 0007 — Identities an administrator sets

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

## Decision

The administration gains **Enforce Identities**, one section under the existing
**Stalwart** group of the admin navigation — **gilbertstalwart**, one of the
four blocks `README.md` names, because what these surfaces write is held by the
server itself. It holds a person's identities and a group's as its two tabs,
**User identities** and **Group identities**. The door here is JMAP, a person's identity being a
JMAP object the server keeps and sends with: no server configuration is
written and no second credential appears.

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
2. **A group's identity is set through the Master.** The agent
   is a principal the installation already has; ADR 0003 makes it a member of
   every group the installation is granted on, and the administration can act
   as it by impersonation — `openAgentSession`, the door the agent's own
   surfaces already use. The write is therefore made **as the agent**, always:
   one actor that exists for this purpose and is named in the record, rather
   than a member the administrator happens to borrow for the occasion.

   No new credential and no second door: the Master's session is a JMAP session
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
   set stays what the product sends. It is written and given back from the
   section that holds it, as two controls — **Enforce**, shown as **Enforced**
   while it holds, and **Release** — and it takes effect where the policy is
   read: the session that writes one re-reads its own at once, and a session
   already open does so the next time it asks, so applying a lock ends no
   session and needs no sign-in. Beside the account picker, **Reload
   identities** reads the account's list and the directory again from the
   server — for an identity deleted in Stalwart's own administration — and
   leaves a draft in progress where it is.
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

7. **The default sending identity is one key of the client's own document.**
   Which identity an account sends from by default is not a Stalwart property:
   the server has no such field, so a copy this product kept beside it would be
   a value free to disagree with the one the account itself reads. It is one
   key of the client's settings document, `settings.json`, in that account's
   app folder, keyed by account id — the key the account's own **Identities &
   signatures** section reads and sends from. The administration reads it and
   writes it there, by impersonating the account, at
   `POST /api/admin/identities/user/default`; `null` clears the entry, which is
   the same state as never having chosen, and the client falls back from it to
   the first identity it holds. The surface shows what it read and writes what
   it was given: **one stored value, not two**.

   **Residual risk, stated because the mechanism carries it.** The write is a
   read-modify-write of a document the client also writes wholesale, so a
   client save landing between the read and the write loses the
   administration's write: that save is the value that survives, and the
   administrator's choice is gone without either side reporting it. Nothing
   else can lose it: the key belongs to the client's schema, so every save
   written by a client that read the document after this write carries the
   value forward.

## Consequences
- The feature fits the architecture it lands in: JMAP only, no Management API,
  no server configuration written by the product, no new credential, and
  nothing that has to survive a container restart outside Stalwart.
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
- An identity's **signature** is written whole from either surface. When it is
  larger than the server's cap, the full copy is stored in the **account's own**
  Files — the impersonated account's, or the group's — and the identity carries
  the marker that points at it, which is the shape that account's own client
  already reads back. A signature's **picture** is the one thing the
  administration does not set: a picture is stored in the account's Files and
  rendered back through the writer's own session, and the administrator's
  session does not hold that account — so the form offers the signature without
  pictures and says why, rather than embedding a reference that would render for
  nobody.
