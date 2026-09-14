# ADR 0007 — Identity administration

An identity belongs to the account and is written by it: display name,
address, `replyTo` and a signature (text and HTML, the latter capped by
Stalwart at 2 KB of UTF-8, with a longer one kept in the account's own Files
behind a marker). A person edits their own under Settings → Identities &
signatures, and a message's signature is applied by the same function
(`server/src/shared/signature.ts`) whether the writer is a person composing
or the agent sending on a group's behalf — a message written in another
client carries that client's own body and signature, and nothing of
Gilbert's is added to it.

**A person's own list is the account that sends for them** — the one the
session names for `urn:ietf:params:jmap:submission` — and not the mailbox
the client happens to have on screen. A mailbox on screen is where a message
is written; an identity is a claim about who is sending, and that claim does
not change because the reader opened a share or a group's mail. The person's
own section and the administration therefore address that account and no
other, and read one list of the same objects.

The administration gains **Enforce Identities**, under the **Stalwart**
group of the admin navigation, with two tabs: **User identities** and
**Group identities**.

## User identities

A person's identity is set by an administrator through the same form the
person's own settings use, so an identity means one thing wherever it is
written. The write is an impersonation from the administrator's own session
(ADR 0001) — no new credential, no second door. A person may hold several
identities; the surface edits the full list, including ones the person
created before an administrator took over the account, and nothing is left
behind that the administrator cannot see. Removal respects each identity's
own `mayDelete` flag, the same one the person's own settings already read,
rather than a rule of the surface's own invention about the last identity.

**A locked account has no path to change it.** Locking a person (ADR 0001,
`identity-lock.json`) hides their own Identities & signatures section
entirely — no add, change or remove, and no signature of their own — so
what the administrator set is what the product sends until the lock is
released. The lock is a rule about this product's surface, not a Stalwart
permission: a principal using another JMAP client directly can still write
its own identity, and the lock's guarantee is only that this product does
not offer the edit. Applying or releasing a lock takes effect at the next
policy read — the writing session re-reads its own at once, and an already
open session on its next read — so it needs no sign-in either way.

The **default sending identity** is not a Stalwart property — the server has
no such field — so it is one key, `defaultIdentityByAccount`, of the
client's own `settings.json` in the account's app folder, the same key the
account's own Identities section reads and writes. The administration reads
and writes it by impersonation (`POST /api/admin/identities/user/default`);
`null` clears it, the same state as never having chosen, and the client
falls back to the first identity it holds. Because this key lives inside a
document the client itself whole-file-rewrites on every save, a client save
landing between the administration's read and write can overwrite the
administration's choice — the only value that can lose this particular
race, since every other administered fact here lives in its own file.

An identity's signature is written whole from this surface; a signature
larger than the server's cap is stored in the account's own Files with a
marker pointing at it, exactly as that account's own client reads it back. A
signature's picture is the one field this surface does not set: a picture
lives in the account's own Files and renders through the writer's own
session, which the administrator's impersonated session is not — so the form
offers the signature without pictures and says why.

## Group identities

A group's identity is set through the agent (ADR 0003), which is already a
member of every group the installation grants it on. The write is always
made **as the agent** — one actor that exists for this purpose and is named
in Stalwart's own record — rather than as a member the administrator happens
to borrow: an administrator could otherwise reach a group's account by
impersonating one of its members, since Stalwart refuses to impersonate the
group mailbox itself (403) but not a member of it, and the product
deliberately does not take that road. Where the agent is not granted on a
group, the surface says so and names the missing grant.

A group's account holds **one identity per member of that group**, all
carrying the group's own address and each carrying that member's own display
name and signature. Mail sent by one member and mail sent by another leave
the same mailbox and read differently: the From line names the person and
the signature is theirs. One identity for everyone could not do that — name
and signature are fields of the identity, so sharing it means sharing them.
A member is bound to their identity by the display name, which is that
member's own identity name, read from the member's own account rather than
typed a second time here.

The member reads them and does not write them. Their own Identities &
signatures section lists their own account's identities for editing and, in
the same place, one read-only block per group they are a member of, saying
that the administration sets them. The composer, writing in a group's
mailbox, offers a member their own identity and nothing else: never another
member's name to send under, and none at all while the administration has
not yet created theirs — which is what a surface that offers everybody's
identity would make of the rule.

## Consequences

- No Management API and no second credential anywhere in this feature:
  identities are JMAP objects, written through impersonation or through the
  agent's own session, both doors this product already has.
- An administrator is not universally able to do this: impersonation needs a
  session that is not an app password, and a group additionally needs the
  agent to hold a grant on it.
- Locking removes signature editing along with identity editing, and the
  surface that applies the lock says so — the group blocks go with the
  section, which is that rule applied to the whole entry.
- A message sent as a group names the member who sent it, in the From line
  and in the signature, with no second address and no per-message override
  for the server to honour.

## References

- `server/src/identityAdmin.ts` — `setPersonDefaultIdentity`, the lock file,
  the admin identity routes
- `server/src/shared/signature.ts` — the one signature-application path
- `web/src/views/settings/IdentitiesSettings.tsx` — the person's own form,
  reused by the admin surface
- ADR 0001 — impersonation, the identity lock's storage
- ADR 0003 — the agent's grants and its own session
