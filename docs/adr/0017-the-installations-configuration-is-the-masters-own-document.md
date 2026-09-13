# ADR 0017 — The installation's configuration is the Master's own document

Status: Proposed

## Context

Four kinds of value a running Gilbert reads are not the installation's to
decide: the way Stalwart is reached at all, what the container was given, what
the image is, and the one statement only the operator may make. Everything else
is the installation's own configuration — how long a session lives, how large an
upload may be, which domains sign in where, what the fleet's bounds are, the
name the installation shows.

An environment is the wrong home for that. An environment belongs to a process,
so every redeploy of a disposable container is a chance to lose the
installation, and two replicas of one installation can disagree about which
environment is the installation. The durable state Gilbert has is Stalwart's, so
the installation's configuration is one document there — and what follows is
where it lives, who reads it at which moment, who may write it, and when a write
is in force.

## Decision

**One document, in the Master's own account.** `installation.json`
(`INSTALLATION_FILE`, `server/src/shared/installation.ts`) in the `gilbert` app
folder of the account `GILBERT_AGENT_ADDRESS` names — the Master (ADR 0003),
which is also the account a boot signs in as and the principal the fleet acts
as. It carries a schema `version` and an `epoch`, and the sections `server`,
`limits`, `sessions`, `push`, `upstreams`, `agent`, `branding` and `secret`. A
key this build does not know decides nothing and does not refuse the document,
so an installation that carries one keeps booting and a later publish drops it;
a `version` this build does not know *is* refused, because a document written by
a newer Gilbert may mean something else by the same field name.

**The boot is its reader** (**gilbertserver**). The process signs in as the
Master, reads the document whole, and resolves it against the container's own
facts into the configuration every served request runs on
(`server/src/bootstrap.ts` → `server/src/config.ts`'s `useConfiguration`). A
process that never boots — a test, a tool, a development server started without
a sign-in — runs on the same names read from the environment
(`server/src/configuration.ts`), which is why a knob has one definition and two
readings rather than two implementations. The **first boot creates** the
document: the defaults and a freshly generated app secret, and it reads back
what the account holds before trusting its own write, because two boots starting
at once can both create one. A document that is there but unreadable is refused
and left exactly as it is: booting from the defaults instead would silently
discard the installation's routing table, its fleet and its secret — the one
outcome worse than not starting.

**Two things the document may not decide.**

- **The served prefix** (`BASE_PATH`) is the image's fact, and it is one value
  in two places: the build argument bakes it into the web bundle's asset URLs,
  and the container's own `BASE_PATH` tells the server which prefix to serve
  (`""` is the domain root). A document that could move the prefix could
  disagree with the bundle the server is serving, and that symptom is a blank
  page. `assertServable`
  (`server/src/config.ts`) refuses a production process whose environment states
  no prefix at all, next to the refusal for a secret no restart would find.
- **Whether the installation's model may sit inside the deployment's own
  network** (`GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER`) is the operator's
  statement. It is read from the environment and nowhere else, because an
  installation must not grant itself the right to aim its model at the network
  the deployment runs in: the document does not carry the field, and one that
  still carries it is read as though it did not.

**The secret travels with its source.** The document's `secret` is the key every
stored session is sealed with. It is generated on the first boot and written
there, because a secret the container holds is a secret a redeploy loses, and
sessions that cannot be read after a redeploy are the very thing this document
exists to prevent. `appSecretSource` — `"document"`, `"environment"` or
`"ephemeral"` — says where the running configuration's secret came from, and
`assertServable` refuses a production process that would serve on an ephemeral
one. `APP_SECRET` is what a process with no boot runs on; in a
booted deployment the document's value is the one in force, so rotating it signs
nobody out.

**The door is the Master's account, reached by impersonation.**
`GET` and `POST /api/admin/installation` (**gilbertserver**) act on that account
through the same impersonation the policy publish uses, so an administrator
whose own account is somewhere else administers *the installation's* document
rather than one in their own Files. A deployment that names no Master is refused
as a value, with its own code, rather than opened onto the account of whoever is
asking. The publish validates the text with the boot's own validator before
anything is written, and writes conditionally on the account's file state, from
the epoch the **stored** document carries rather than the one submitted — so a
save from an editor opened before somebody else's publish cannot move the stored
epoch backwards, and a document that moved while the publish was in flight is
refused with its own code, leaving the stored document byte for byte as it was.
The answer says when it applies: the running process keeps the configuration it
booted with and the next boot reads what was just written, because "saved" and
"in force" are different claims and only the second is what an administrator is
being asked to believe.

## Consequences

- A redeploy loses nothing: everything the installation decided is in the
  account, so the container is replaceable and `IMMUTABLE=1` costs nothing.
- A change has two visible moments — published, and in force at the next boot —
  and the surface reports the second as a value (`applies: "next-boot"`) rather
  than reporting a save as a change already in force.
- Administering the installation needs impersonation rights on the Master's
  account, and a deployment that names no Master has no installation document to
  administer at all. That state is reported as its own refusal rather than
  papered over.
- The environment stays small enough to reason about: the handshake, and
  whether the URL Stalwart advertises is followed (a statement about the
  deployment's own proxy); the container's own facts; the image's facts; the
  operator's own switch; and the `NODE_ENV` fact that decides whether the
  production refusals apply. Every other name the environment carries is a
  field of the document in a booted deployment — `APP_SECRET`'s counterpart is
  the document's `secret` — so setting one in a deployment's environment
  changes nothing.
- A key that must leave the document — a field the image owns, or the operator's
  switch — is read from the environment in the same change, and a document that
  still carries the retired key keeps booting with that key ignored.

## References

- `server/src/bootstrap.ts` — `readHandshake`, `readContainerFacts`,
  `signInAsMaster`, `configurationFrom`, `bootInstallation`
- `server/src/installation.ts` — the document's store, the first boot, the
  conditional write
- `server/src/shared/installation.ts` — the document's shape, its defaults and
  its validator, shared with the web tier
- `server/src/configuration.ts` — the same configuration read from the
  environment, for a process with no boot
- `server/src/config.ts` — `useConfiguration`, `assertServable`,
  `assertImmutable`
- `server/src/installationAdmin.ts` — the administration's read and publish
- `server/src/app.ts` — `GET`/`POST /api/admin/installation`
- `.env.example` — the environment's own list, in the words a deployment reads
- ADR 0001 — administration, impersonation, and the admin permission marker
- ADR 0003 — the Master, and the agent fleet that acts as it
- ADR 0016 — the policy publish, the other document the administration writes
