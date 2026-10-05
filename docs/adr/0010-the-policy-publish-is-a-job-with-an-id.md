# ADR 0010 — The policy publish is a job with an id

Status: Accepted

Implementation: Built. One id per publish, carried by every copy it writes, with
the job recorded as one document in the publishing administrator's own app folder
(`server/src/adminPolicy.ts`, which reads and writes it). The shape is shared with
the surface that shows it (`server/src/shared/publishJob.ts`), including
`record: "failed"` for a publish whose own report could not be stored — the one
field the browser used to describe a document without, so the answer it held was
never shown.

## Context

The installation policy is per account (ADR 0001): `installation-policy.json`
in each individual account's own `gilbert` app folder, written by impersonation
from **Administration → Installation policy**. Publishing it is the most
expensive administrative action the product has — one impersonated write per
account the directory lists — and it is not atomic: one account can refuse while
the rest are written.

What an administrator has to be able to ask afterwards is not how many accounts
were reached, but whether this installation carries this policy: which publish
wrote it, which accounts hold it, which do not and why. A count answers none of
that, and an answer that lives in the process that made it is gone as soon as
that process is replaced — which, for a disposable container, is the ordinary
case rather than the exception.

## Decision

**A publish is a job with an id** (**gilbertserver**, resting on
**gilbertstalwart**'s directory of principals, which is the population it is
measured against).

- **One id per publish**, minted before the first copy goes out. Every copy the
  publish writes carries the id and the moment beside the policy —
  `published: { id, at }` (`PolicyPublished`, `server/src/adminPolicy.ts`) — so
  any account an administrator opens says which publish reached it. A copy a
  conditional write refused keeps the id of the publish that really wrote the
  copy the account holds.

- **The job is a document in the account, not state in the process**: one file,
  `gilbert/publish-job.json` (`PUBLISH_JOB_FILE`, `server/src/adminPolicy.ts`),
  in the publishing administrator's own app folder. It holds the id, when the
  publish started, who published, the population the directory reported (how
  many accounts it listed, whether that listing was the whole directory, and the
  total when the server stated one), the addresses the policy was written to,
  the ones it was not written to with a code each and what the server said, and
  whether the installation can be said to carry the policy. `GET /admin/policy`
  answers it, so a later read — by another instance, or by one that never made
  that publish — returns the same record. Each publish replaces the last one:
  the question the document answers is what the last publish did, and a history
  of publishes is a different document with a different retention rule.

- **Every per-account write is conditional.** The token is that account's own
  file state, read **after** its app folder is known to exist — creating that
  folder is itself a write, so a token read before it would make the publish
  lose a race with its own call — and it rides the policy write as `ifInState`.
  An account that will not state the state of its Files is named as unreached
  rather than written to blind: a write that cannot be told the account moved is
  a write that can replace a copy this publish never saw. A refusal is a code
  rather than a sentence — `impersonation-refused`, `no-files-account`,
  `write-failed` and `policy-moved` (`PublishRefusal`, `server/src/adminPolicy.ts`),
  with `directory-denied` beside them on `PublishUnreached` for a directory the
  server would not list — and JMAP's own `stateMismatch` is told apart from any
  other failure (`refusalCodeFor`), so a surface composes the sentence in the
  reader's own language. The publishing administrator's own account is
  written in the same pass and named among the reached; one account's refusal
  does not stop the rest.

- **The outcome cannot claim more than it reached.** `complete` is true only
  when the directory's listing *was* the whole directory and every account it
  listed received the copy. An account named in `unreached`, a listing that was
  not the whole directory, or a directory the server would not list at all
  leaves it false, and `population` and `directory` sit beside it so the surface
  can say what was not covered instead of letting a count of successes stand for
  the installation.

- **A publish that cannot store its own record says so.** The job is written
  after every copy, and a write that fails leaves the returned job with
  `record: "failed"` and the server's message beside it. The copies are already
  in their accounts, so the report of what was reached is not thrown away with
  the note about it — and a job no later read can find is never answered as
  though it had been kept.

**A publish answers with a job.** Everything around it is ADR 0001's: Gilbert
admin is Stalwart admin, the policy is a per-account document written by
impersonation, its three powers are `defaults`, `enforced` and `changes`, it
applies at once, and the other signed-in sessions are kicked so their next
sign-in reads it. What this record decides is the record of what a publish did.

## Consequences

- The administration reads one answer and reads it back: the Policy editor shows
  the last publish's id, when it started and who published it, with the
  population that was read and the accounts that were not reached — read from
  the account itself rather than remembered by a process.
- Coverage is a claim an administrator can check account by account: every copy
  names the publish that wrote it, and a copy a refused write left behind names
  the publish it really came from.
- One extra document per publish, in the publisher's own app folder. Nothing
  here needs a volume, so publishing holds under `IMMUTABLE=1`.
- A job document that cannot be read is treated as no job at all rather than as
  a failure of the surface: `readPublishJob` answers null for missing,
  unreadable and not-a-job alike (`isPublishJob` decides), so a corrupt file
  cannot take the administration down.
- The job is the last publish's record, not an audit trail: an administrator who
  needs the history of publishes is asking a different question, and this
  document is deliberately not where it is answered.

## References

- `server/src/app.ts` — `publishAccountPolicy`, `deliver`, `GET`/`POST
  /admin/policy`
- `server/src/adminPolicy.ts` — `PublishJob`, `PublishRefusal`,
  `PublishUnreached`, `PolicyPublished`, `PUBLISH_JOB_FILE`, `readPublishJob`,
  `writePublishJob`, `refusalCodeFor`
- `web/src/views/admin/AdminPolicy.tsx` — `publishNotice`, and the job the
  editor shows
- ADR 0001 — administration, the per-account policy, impersonation
- ADR 0003 — *Coordination: leases, claims and fencing*, whose
  conditional-write discipline the publish follows
- `scripts/probe-conditional-writes.mjs` — the live probe that asks whether
  `FileNode/set` honours `ifInState` and what a stale token is refused as
- ADR 0011 — the installation's own configuration document, and the door that
  publishes it
