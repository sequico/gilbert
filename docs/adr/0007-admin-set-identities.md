# ADR 0007 — Identity administration

Status: Accepted. The assignment of a group identity to a member is decided
here, and the tree carries it.

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
released. The lock is about **personal mailboxes only**: it governs the
person's own identities in the account that sends for them, and it governs
nothing in a group, where the administration assigns an identity and the
member is offered it read-only whether the lock is set or not. The lock is a
rule about this product's surface, not a Stalwart permission: a principal
using another JMAP client directly can still write its own identity, and the
lock's guarantee is only that this product does not offer the edit. Applying
or releasing a lock takes effect at the next policy read — the writing
session re-reads its own at once, and an already open session on its next
read — so it needs no sign-in either way.

**The list is the server's, and it is read again after a write.** The
administration's write is made as the account rather than by the account's
own session, so the session that asked for it is the one thing that never
hears about the change: an identity it removed would live on in the copy the
client read at sign-in — shown under Identities & signatures with a Delete
button, and offered by the composer as a sender. Two rules keep the two
surfaces one list. A write that succeeds refreshes the identity lists the
session holds, and a read asked for before that write is spent rather than
joined, because its answer describes the account as it was. And the person's
own section reads its list when it opens rather than trusting the copy in
the store, which is what reaches an identity removed in Stalwart's own
administration — a change no route of this product ever sees.

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

**The administration assigns a member their identity, and the assignment is
what binds them.** The binding is a record, not a comparison of names: an
identity's display name is what a recipient reads in the From line, so a name
that is also a key fails the moment either side is written differently — a
rename in the person's own account, a spelling that differs by case, a name
nobody ever set — and the member is then told no identity was set for them in
a group that holds one. Which identity a member sends as in a group is
therefore a fact the administration records, in a document of the **group's
own account** — `identity-assignments.json` in its app folder, whose keys are
member addresses and whose values are ids of that account's identities. The
administration writes it as the agent, in the same action that writes the
identity, so the two cannot disagree; a member with no entry has been
assigned nothing, which is a state and not a failure. That write is one
compare-and-set: the account's FileNode state is read **before** the document
it guards, so a write landing in between leaves the writer holding a token
older than its list — refused, and retried against the list as it then reads
— rather than a token newer than its data, which is the one arrangement that
lets a conditional write land while overwriting an entry it never saw.

**A member sends as themselves, or as the group itself — never as another
member.** Which identity the composer offers in a group's mailbox is one
cascade, in order:

1. the identity the administration **assigned** that member, when there is
   one;
2. else the group's **own** identity — the one the agent sends as, chosen by
   the same rule on the same list, so a member with no assignment and the
   agent send the group's mail identically;
3. else nothing: a group whose account holds no identity at all is the one
   state with nothing to send as, and the composer says so.

The middle step is what keeps a member from being stuck. An identity nobody
is assigned is not an orphan waiting to be cleaned up but the group's own
voice, and the surface that lists them describes them that way. The bottom
step is rare and honest: it is a group holding no identity yet, not a member
the administration has forgotten — which is a distinction the composer can
only make because the assignment is a record rather than a name.

**Which of a person's own identities is theirs** is one rule, and it is about
the person rather than about any group: the identity carrying their **own
address** — an identity is a claim about who is sending, and the one claiming
their own address claims to be them — else the identity their account **sends
from by default**, else the first by address, so the answer does not depend on
the order a list a surface holds arrived in. It lives once, in `ownIdentity`,
and the administration reads it for the one thing it is for: the display name
to write on the identity it creates for a member in a group, read from that
member's own account rather than typed a second time here. It decides no
binding.

The member reads them and does not write them, and the assignment is the
administration's alone: no surface of this product offers a person a way to
say which group identity is theirs, and no surface offers one member another
member's. Their own Identities & signatures section lists their own account's
identities for editing and, in the same place, one read-only block per group
they are a member of, saying that the administration sets them and **which of
them is theirs** — the identity assigned to them, or, with none assigned, the
words that their mail goes out as the group itself. The assignment is written
from another session, so that block reads it as it opens rather than trusting
what the store holds, exactly as the person's own list beside it does. The
composer, writing in a group's mailbox, offers that cascade's answer and
nothing else — the identity assigned to them, else the group's own — never a
guess from a name, and never another member's, which is what a surface that
offered the whole membership would make of the rule. It reaches the
assignment through the member's own door (`memberGroupAccess`), which reads
the group's document as the agent: a member reaches a group's Files through
the group surfaces and never by reading another account directly, and the
step-2 identity is derived from the group's own address rather than answered
beside the assignment, so the rule has one definition on both sides of the
wire.

## Consequences

- No Management API and no second credential anywhere in this feature:
  identities are JMAP objects, written through impersonation or through the
  agent's own session, both doors this product already has.
- An administrator is not universally able to do this: impersonation needs a
  session that is not an app password, and a group additionally needs the
  agent to hold a grant on it.
- Locking removes signature editing along with identity editing in the
  person's own list, and the surface that applies the lock says so. It is
  scoped to personal mailboxes: a group's identities are assigned by the
  administration and read by the member, so the lock has nothing to remove
  there.
- A message sent as a group names the member who sent it when one is assigned
  to them, and the group itself when none is, in the From line and in the
  signature, with no second address and no per-message override for the
  server to honour. Never another member.

## References

- `server/src/identityAdmin.ts` — `setPersonDefaultIdentity`, the lock file,
  the admin identity routes
- `server/src/shared/signature.ts` — the one signature-application path
- `web/src/views/settings/IdentitiesSettings.tsx` — the person's own form,
  reused by the admin surface, and the two things it reads when it opens: their
  list, and each group's assignment
- `web/src/lib/identityVisibility.ts` — `ownIdentity`, the one rule for which
  of a person's identities is theirs, and the display name it reads for the
  identity the administration writes
- `web/src/store/mail.ts` — the per-account identity lists, the assignment a
  group mailbox narrows to and reads again when a surface asks it to, the write
  that spends a read already on its way, and `refreshIdentities`
- `web/src/lib/identities.ts` — `fetchMemberAssignment`, the assignment read as
  the member, and the admin routes, each refreshing those lists once the server
  has accepted the write
- `identity-assignments.json` in a group account's own app folder — the
  member-to-identity assignment, written as the agent and read by the composer
  and by the member's own settings block
- ADR 0001 — impersonation, the identity lock's storage
- ADR 0003 — the agent's grants and its own session
