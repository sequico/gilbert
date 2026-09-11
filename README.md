<p align="center">
  <img src="web/public/img/logo.png" alt="Gilbert" width="150">
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: AGPL-3.0-or-later" src="https://img.shields.io/badge/licence-AGPL--3.0--or--later-2dd4bf?style=flat-square"></a>
  <a href="https://stalw.art" target="_blank" rel="noreferrer"><img alt="Requires Stalwart 0.16 or newer; tested against 0.16.21" src="https://img.shields.io/badge/Stalwart-0.16.21-6366f1?style=flat-square"></a>
</p>

# Gilbert

**G**eneral-purpose **I**ntelligent **L**ifecycle **B**utler for **E**nterprise
**R**esource **T**raceability.

Gilbert manages an organisation's *resources* — mail, contacts, calendars,
files and the documents that move between people — through their whole
lifecycle, with [Stalwart Mail Server](https://stalw.art) as the single store
that keeps the trace. Concretely, in rough order: shared group accounts on
Stalwart for mail, contacts and calendars; chat between the members of a
group; AI agents that act inside mail and file storage, for a person or a
group — Gilbert's own agents now, external agent fleets later; and a workflow
engine for delivery orders with checklists and to-do lists. Part of this
already ships — the group accounts, the chat, the calendars, contacts, address
books and task lists, and the agent fleet; the rest is the direction the code
is being pointed.

What runs today is Gilbert: a Gmail-class, JMAP-only **mail client** for
Stalwart, and an **agent fleet** — a second process that acts inside mail and
file storage on a group's behalf, with its own identity, its own permissions
and its own audit trail. Both run in a disposable container, and everything
durable lives in Stalwart (see [What's in it](#whats-in-it) and
[Architecture](#architecture)). The mail client is based on
[ihasmail](https://github.com/Coffey-Labs/ihasmail), Coffey Labs' immutable
webmail for Stalwart; Gilbert is a distinct product around it, and its own
layer is the groups, the chat and the agents.

**Four blocks, named once — in [The blocks, and the line to
upstream](#the-blocks-and-the-line-to-upstream).** Every document here uses
those names and no others.

> **Try it locally:** `npm run dev:mock` runs a complete instance against an
> in-memory mock Stalwart — open http://localhost:5173 and sign in with
> `demo@example.com` / `demo`.

**Licence and lineage.** Gilbert is AGPL-3.0-or-later, and its copyright is
**Sequi Company's**. Its mail client is a derivative work of
[ihasmail](https://github.com/Coffey-Labs/ihasmail) by **Coffey Labs**, used and
modified under the same licence: they are *attributed* — in
[NOTICE](NOTICE) and in the table below — and upstream's code and docs are
linked where they are still accurate. The source offer for *this* build points
at this repository (Settings › About, or the sign-in page).

| | |
| --- | --- |
| 📋 **[FEATURES.md](FEATURES.md)** | Everything the client does today, feature by feature, with the capability each one needs |
| 🧪 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)** | What was verified live, and where Stalwart departs from a spec |
| 🛣 **[ROADMAP.md](ROADMAP.md)** | What Gilbert does not do yet, and why |
| ⬆ **[ihasmail](https://github.com/Coffey-Labs/ihasmail) upstream** | The project Gilbert derives from — [site](https://ihasmail.org) · [docs](https://docs.ihasmail.org) · [demo](https://demo.ihasmail.com), all theirs, linked for attribution and because most install and usage detail still lives there |

This file is for people working *on* Gilbert and for the people running it.

## What's in it

Gilbert's own work, in the order it matters here. The long version, feature by
feature, is in [FEATURES.md](FEATURES.md).

- **Groups** — a group mailbox is an account of its own on Stalwart, and what it owns lives in that account and belongs to it: its chat, its label catalog, its calendars and files, its agent's documents. Membership *is* the grant, and the grant is administered on the server, never in the product
- **Chat** — one conversation per group mailbox, stored in the group's own account so a member added later finds all of it (ADR 0006)
- **Agents** — a worker fleet that acts inside mail and file storage on a group's behalf. Each automation is a document in the group's own account — when it reacts, which messages it looks at, what it then does — with a tier that decides how much model it uses (T0 deterministic, T1 a category, T2 the model's own judgement), a review policy that can pause a run for a person, a capability allowlist that bounds every answer, and the approval itself happening in the group's chat. Every run is audited, one document per month per group, and an administrator can export that trail before the retention prunes it. The installation's agent has an **address an administrator sets in the product**, and each group can be **narrowed to the kinds of work** (mail, files, tasks, calendars, contacts) it is served for. It runs as its own process, holds its claims in the documents themselves, and no model can widen what a rule was granted
- **Nothing of its own to keep** — no database, no search index, no cache tier: every durable thing lives in the mail store, under the account's quota, and the container is disposable (`IMMUTABLE=1` needs no writable root)
- **Platform** — installable PWA, Web Push with Gilbert closed, `mailto:` handler, no credentials in the browser, strict CSP, SSRF-safe image proxy
- **Everything else is upstream's** — the mail client, calendar, contacts, files, sharing and Sieve editing come from [ihasmail](https://github.com/Coffey-Labs/ihasmail), renamed for this build. This project does not re-document them; upstream's own documentation is the reference — [Using ihasmail](https://docs.ihasmail.org/using/). What this build adds on top: twelve themes, nine interface languages (beta), signature checking, and a container that can run read-only

The feature-by-feature inventory, with Gilbert's own part first, is
[FEATURES.md](FEATURES.md).

## The blocks, and the line to upstream

Gilbert is four blocks. They are areas of the product and not directories — one
code tree holds several of them — and every document here names them this way
and no other:

- **gilbertmailer** — the mail suite: mail, calendars, contacts, files, sharing
  and the Sieve editor. This is the block that came from upstream.
- **gilbertserver** — the Node process that runs beside the browser: sign-in,
  the sealed sessions, the JMAP forwarding, the policy, the image and calendar
  proxies. It is also where the agent fleet runs. Part of it came from
  upstream — the layer that serves the mail client — and the fleet inside it is
  Gilbert's.
- **gilbertagents** — the agents: the principal, the worker fleet, the
  automations, the approvals and the audit.
- **gilbertstalwart** — what is set inside Stalwart itself: the server's own
  configuration and system scripts, written through its management API, and the
  objects the server holds and sends with, an account's identities among them,
  written through JMAP. Which door carried the write does not decide the block;
  what the write fixes inside the server does.

The word *server* is the one worth pinning down: **Stalwart** is the mail
server that holds every durable byte, and **gilbertserver** is this product's
own Node process. This document says which one it means every time.

These are the documentation's names for what the product is made of, and not
UI labels. The administration's navigation presents three of the blocks under
its own headings — *Gilbert Mailer*, *Gilbert Assistant*, *Stalwart* — which is
that surface labelling them rather than a second set of names; the server
process has no navigation of its own, because it is what serves it.

**The line.** One block and part of another came from
[ihasmail](https://github.com/Coffey-Labs/ihasmail), Coffey Labs' immutable
webmail for Stalwart. Everything else is Gilbert's, written here. That is the
whole of the upstream relationship, stated so a reader can tell which is which
without reading the tree:

- **From upstream**: the mail client — `gilbertmailer` — and inside
  `gilbertserver` the parts that serve it: sign-in and sessions, the JMAP
  forwarding, the image and calendar proxies, the rate limiting. Renamed for
  this build and changed here.
- **Gilbert's own**: the groups, the chat, the agent fleet, the administration,
  the settings policy, the app folder, and every Stalwart configuration
  surface. None of it exists upstream, and none of it is contributed back
  (ADR 0002).

Where this matters: an upstream release is a delta to the first list only, and
the merge that takes one in renames it before it lands. Everywhere else there
is nothing to merge.

## Agents, in detail

An agent is an ordinary account on the server that Gilbert acts as. The fleet is
what acts through it — and it is the largest thing this project owns, so this is
the short version of how to turn it on, what it does, and what holds it back. The
long version is the first part of [FEATURES.md](FEATURES.md).

**Turning it on.** The operator creates the agent's account in **Stalwart's own
administration** and grants it on the groups it may work in: membership *is* the
grant, and no switch in the product can replace it. The administrator then names
it in Gilbert — **Admin → Agents → Overview**, an address field whose value the
installation records — and may narrow what it does in each group (**Admin → Group
workers**: the kinds of work, per group, for as many groups as are selected at
once). The worker is its own process, from the same image:

```
GILBERT_AGENT_ADDRESS=gilbert@example.com \
GILBERT_AGENT_PASSWORD=<its app password> \
npm run agent
```

`GILBERT_AGENTS_FILE` holds several addresses and their passwords instead, and
`GILBERT_AGENT_AREAS`, `GILBERT_AGENT_POLL_MS`, `GILBERT_AGENT_LEASE_MS` and
`GILBERT_AGENT_HEALTH_PORT` say what it serves, how often it re-reads, and how a
restart policy reaches it. The web tier needs no secret of its own: it acts as
the agent by impersonating it from an administrator's session.

**What it does.** An **automation** is a document in the group's own account:
when it reacts (an email arriving, a chat message, a file, a time), which
messages it looks at (the JMAP filter grammar), and what it then does — from the
capability catalogue: label, move, file attachments into the group's visible
Files, prepare a draft, send, write a text document. Each carries a **tier**: T0
is deterministic and calls no model, T1 asks a small model for one of the rule's
own categories, T2 gives the rule's instruction to a model that decides and acts.
A group also keeps one **standing instruction** — the shape of an `AGENTS.md` —
which the model is handed first on every call.

**What holds it back.** The automation's **capability allowlist** bounds every
answer, checked in code rather than asked for in a prompt, so neither the model
nor the group's instruction can widen it. A **review policy** can pause every
run, or any run below a confidence threshold; the approval happens **in the
group's chat**, by any member, in words. Nothing that leaves the group is ever
sent on a guessed approval.

**What it leaves behind.** Every run is recorded in the group's **audit** — one
document per month, kept twelve months, one line written before any effect so
that an effect never exists without a record — and an administrator can download
the whole retained trail as JSON before the oldest month is pruned. A failure
lands the message in `G-needattention` and tells the group's chat which automation
could not finish. Work is claimed per area with a lease, so a crashed worker's
work is taken up by the next one, and a run whose rule changed under it is
refused rather than executed.

**Every member sees it.** The group's chat carries an AI panel showing what the
agent is told and what it has done — the standing instruction, each automation,
and the recent audit — read through the member's own session, and editable by
nobody but an administrator of that group.

## Requires Stalwart 0.16 or newer

Sign-in refuses anything older, by name. 0.16 replaced the REST management API
with JMAP registry objects, changed the shape of `FileNode`, split its rights up
and moved configuration into the store; supporting both generations meant a
wrong guess had somewhere to fall back to, so it failed *quietly* — and that
reached production. With one supported generation a wrong guess is a loud error
on the first call.

**Validated against 0.16.21**, released 6 September 2026: the app was run
against a real instance of it and the mail, calendar and contacts paths were
exercised by hand. Four of that release's JMAP changes are visible to a client
— an occurrence of a recurring event is now identified by its recurrence id
rather than by its position in the series, so an id held across a write no
longer silently names a different date; `Calendar/get` and `AddressBook/get`
return every property when none are named; EventSource advertises its ping
interval in seconds rather than milliseconds; and a calendar write that asks
for scheduling messages is refused when the account may not send them. The mock
reproduces all four.

- Still on 0.15? The last release that runs on it is tagged [`stalwart-0.15-support`](https://github.com/Coffey-Labs/ihasmail/releases/tag/stalwart-0.15-support).
- Upgrading? [stalwart-migrator](https://github.com/Coffey-Labs/stalwart-migrator) does it in place, checkpointing every phase and validating afterwards. The live instance moved 0.15.5 → 0.16.19 with eight seconds of downtime and nothing lost.

## Quick start (Docker)

```bash
cp .env.example .env
# edit: STALWART_URL=https://mail.example.com  and  APP_SECRET=$(openssl rand -base64 48)
docker compose up --build -d
# → http://localhost:8080  (put Caddy/nginx in front for TLS; see Caddyfile.example / nginx.example.conf)
```

Users sign in with their Stalwart mailbox credentials. **An account with
two-factor authentication needs an app password**, created in Stalwart's own
settings — Stalwart accepts a TOTP code only through an OAuth flow and offers no
password grant, so no client holding a username and password can exchange them
plus a code for a token.

Full instructions, TLS, and every environment variable — upstream's docs,
still the reference for the underlying client:
[Installing](https://docs.ihasmail.org/install/) ·
[Configuring](https://docs.ihasmail.org/configure/).

### Container images

Gilbert images are published to GHCR on every release (cut by hand), for
`linux/amd64` and `linux/arm64`:

```bash
docker pull ghcr.io/sequico/gilbert:latest
```

The checked-in `docker-compose.yml` builds the checkout itself (no image to
pull); to run a published release instead of a local build, point the service
at `ghcr.io/sequico/gilbert`.

| Tag | What it is |
| --- | --- |
| `latest` | The newest release. Prereleases never move it |
| `v2026.9.6-g8ae88bb` | One specific build — the [version](#version-numbers) with `+` written as `-`, because a Docker tag may not contain `+` |

Pin the dated tag in anything you care about. `latest` is a moving target by
definition, and rolling back to a named tag is a `docker run` rather than a
rebuild.

Building it yourself stays fully supported and is what `docker compose up
--build` above does — the image is a convenience, not a new requirement. If you
build by hand, pass the version in, because `.dockerignore` excludes `.git` and
the build cannot work out what it is:

```bash
docker build --build-arg GILBERT_VERSION="$(node scripts/version.mjs)" -t gilbert:local .
```

### Running immutably

The server writes to exactly one path, the optional `SESSION_FILE`. Clear it
and there is nothing left to write, so the container can run with no writable
filesystem at all:

```bash
docker run --read-only --tmpfs /tmp -e IMMUTABLE=1 -e SESSION_FILE= ...
```

`IMMUTABLE=1` is an assertion the server checks at startup rather than a switch
that changes what it does: it refuses to start if `SESSION_FILE` is still set,
or if the filesystem it is installed on turns out to be writable after all.
Without it the same misconfiguration is silent — sessions are held in memory
and persisting them is best-effort, so a read-only `/data` costs one warning at
the first sign-in and nothing else until the instance is replaced and everyone
is signed out.

That sign-out is the standing cost of this mode today, since sessions have
nowhere to live across a restart. Removing it means moving the session upstream
into a token Stalwart itself issues and can revoke, which is what the OAuth work
in [ROADMAP.md](ROADMAP.md) is for.

### Several Stalwart servers

One Gilbert can front more than one Stalwart, choosing by the domain somebody
signs in with. **`STALWART_URL` stays required and stays the default**, so an
installation that sets nothing else behaves exactly as it always has.

```bash
-e STALWART_SERVERS_FILE=/etc/gilbert/servers.json \
-v /srv/gilbert/servers.json:/etc/gilbert/servers.json:ro
```

```json
{
  "example.com": "https://mail.example.com",
  "customer-b.test": "https://jmap.customer-b.test"
}
```

[`stalwart-servers.example.json`](stalwart-servers.example.json) is that file
with the rules written in it.

A domain nobody listed — and a bare username, which Stalwart accepts and which
has no domain at all — goes to `STALWART_URL`. **A listed domain never falls
back.** If its server is unreachable that sign-in fails rather than retrying
against the default, because falling back would authenticate somebody against a
server their domain was deliberately routed away from; if the same account name
existed there they would land in another tenant's mailbox.

Read once at startup, so editing it means restarting the container. Malformed
JSON, a duplicate domain once lower-cased, or a value that is not an `http(s)`
URL stops the server rather than failing quietly at somebody's sign-in. The
servers themselves are not contacted at boot — a mapping is a routing table,
not a health check, and one customer's outage must not stop Gilbert starting
for everybody else.

This is one server per *person*, chosen at sign-in. Several servers at once for
one person, with unified or cross-account views, is not supported: JMAP account
ids are only unique within a server, so it would mean namespacing ids through
the proxy. Reading somebody else's mail, calendars or files on the *same* server
already works through JMAP sharing.

### Settings the installation decides

A deployment can seed and lock user settings, which is what a school wanting
"warn about outside senders" on for three thousand pupils needs — asking three
thousand pupils is not a plan.

```bash
-e SETTINGS_DEFAULTS='{"externalSenderBanner":true}' \
-e SETTINGS_ENFORCED='{"externalRecipientConfirm":true}'
```

Three powers, and the differences between them matter:

| Section | Applies to | Reader can change it |
| --- | --- | --- |
| `defaults` | accounts that have never had settings of their own | yes, at any time |
| `enforced` | everyone, on every load | no — the control goes dead |
| `changes` | everyone, **once each**, including existing accounts | yes, afterwards, and it stays changed |

`changes` is the one that needs explaining. It turns something on for people who
are *already here* — the reason a plain default is not enough — while still
leaving them the last word. Each entry carries its own `version`, which every
account remembers once it has had it, so the change is applied exactly once per
person and a reader who turns it back off keeps it off. It is a schema migration
in shape, and that is deliberately whose idea it was ([#207]).

Nothing is configured by default: an installation that sets none of these
behaves exactly as Gilbert always has.

### Passing a policy to Docker

Where a file is easier to manage than JSON quoted in a unit file — and it
usually is once there are `changes` in it — mount one and name it:

```bash
docker run -d --name gilbert \
  -e STALWART_URL=https://mail.example.org \
  -e APP_SECRET="$(openssl rand -hex 32)" \
  -e SETTINGS_POLICY_FILE=/etc/gilbert/policy.json \
  -v /srv/gilbert/policy.json:/etc/gilbert/policy.json:ro \
  -p 8080:8080 ghcr.io/sequico/gilbert:latest
```

```json
{
  "defaults": { "externalSenderBanner": true },
  "enforced": { "externalRecipientConfirm": true },
  "changes": [
    { "version": "20260902084513", "settings": { "externalSenderBanner": true } },
    { "version": "20261014091500", "settings": { "externalLinkWarning": true } }
  ]
}
```

[`settings-policy.example.json`](settings-policy.example.json) in this repo is
that file with every section explained in it — copy it and delete what you do
not want.

Mount it read-only: the server only ever reads it, and `:ro` keeps that true
under `--read-only` as well.

Or without a file at all, which is what an immutable deployment with no volume
wants:

```bash
docker run -d --name gilbert --read-only --tmpfs /tmp \
  -e IMMUTABLE=1 -e SESSION_FILE= \
  -e STALWART_URL=https://mail.example.org \
  -e APP_SECRET="$(openssl rand -hex 32)" \
  -e SETTINGS_DEFAULTS='{"externalSenderBanner":true}' \
  -e SETTINGS_ENFORCED='{"externalRecipientConfirm":true}' \
  -e SETTINGS_CHANGES='[{"version":"20260902084513","settings":{"externalSenderBanner":true}}]' \
  -p 8080:8080 ghcr.io/sequico/gilbert:latest
```

In `docker-compose.yml`:

```yaml
services:
  gilbert:
    build: .
    image: gilbert:2
    environment:
      SETTINGS_POLICY_FILE: /etc/gilbert/policy.json
    volumes:
      - ./policy.json:/etc/gilbert/policy.json:ro
```

The file is read at startup, and **Administration → Policy** publishes a new one
without a restart: the running copy is swapped and every other session is signed
out, so the next sign-in applies it at boot (ADR 0004). Editing the file by hand
still means restarting the container.

### Writing a policy

Both sections take the same names and values a settings export uses, so
`Settings → General → Export` on one account you have configured by hand is the
quickest way to write one — copy the keys you care about out of the file.

Three checks worth knowing about, because they fail loudly rather than quietly:

- **Malformed JSON stops the server at startup.** A policy that silently did not
  apply is indistinguishable from the feature not working.
- **Every change needs a unique `version`.** Two changes sharing one, or a change
  with no `version` or no `settings`, is a startup error.
- **Keys this build does not have are dropped**, the same rule an imported
  settings file gets. A `changes` entry whose keys are *all* unknown is dropped
  whole rather than recorded as applied, so it still runs on a Gilbert that
  does have the setting.

Enforcement is applied in the settings store rather than only on the controls,
so an imported settings file, a settings file synced from a device that predates
the policy, and "reset to defaults" cannot get around it. Reset returns to your
defaults, not to Gilbert's.

[#207]: https://github.com/Coffey-Labs/ihasmail/issues/207

## Architecture

```
browser  ──(same-origin /api/*)──►  Gilbert server (Node + Hono)  ──(JMAP over HTTPS)──►  Stalwart
  React SPA                           • session cookie ⇄ Basic auth
  JMAP client + stores                • /api/jmap, /api/blob, /api/upload, /api/events (SSE), /api/image
```

- `web/` — Vite + React 19 + TypeScript SPA. `src/jmap` (client, push, types), `src/store` (zustand: session, mail, compose, contacts, calendar, files, sieve, settings), `src/views`, `src/lib` (sanitiser, search parser, Sieve codec, locale-aware dates, vCard, …).
- `server/` — Node/Hono backend: authenticates against Stalwart's JMAP session endpoint, seals the credentials with a key derived from the cookie secret, proxies JMAP/blob/SSE, serves the SPA under a strict CSP. `src/mock/` is an in-memory fake Stalwart for development and demos.

Capabilities used: `core`, `mail`, `submission`, `vacationresponse`, `sieve`,
`contacts`(+`parse`), `calendars`(+`parse`), `principals`(+`availability`),
`quota`, `blob`, `filenode`, EventSource push, plus Stalwart's own
`urn:stalwart:jmap` (read-only). Features degrade gracefully when one is
missing.

## Development

Requirements: Node ≥ 24 on the **latest LTS line** — 24 is what the image and CI
pin, and a Current release is not supported — npm ≥ 10.

```bash
npm install

npm run dev            # real Stalwart (STALWART_URL in .env) — server :8080, Vite :5173
npm run dev:mock       # built-in mock Stalwart (demo@example.com / demo), mock on :8788
npm run dev:mock:no-future-release   # mock that advertises FUTURERELEASE and drops every hold

npm run typecheck      # tsc for both packages
npm test               # vitest (web) + node:test (server)
npm run build          # web/dist + server/dist
npm start              # serve the production build
```

Open http://localhost:5173 in dev, or http://localhost:8080 for the production
build. Running it for real is covered in upstream's docs —
[Installing](https://docs.ihasmail.org/install/) and
[Configuring](https://docs.ihasmail.org/configure/).

### The mock

An in-memory fake Stalwart 0.16 — enough JMAP to develop and demo against
without a real mailbox. It reproduces the things a naive fake would get wrong,
because each cost a live debugging session: `urn:stalwart:jmap` advertised
**per-account** rather than session-level, identity signatures capped at 2047
**bytes**, and `CalendarEvent/set` speaking Stalwart's vocabulary rather than
RFC 8984's. Three switches: `MOCK_NO_FUTURE_RELEASE=1` advertises FUTURERELEASE
and then drops every hold; `MOCK_NO_REGISTRY=1` omits the Stalwart capability so
the sign-in refusal can be tested; and `MOCK_NO_SCHEDULING_SEND=1` refuses a
calendar write that asks for scheduling messages, the way an account without
that permission is refused.

It tracks the current release rather than 0.16 in general, and each behaviour
is confirmed against a real server before it is copied here — the comments say
which version and on what date. Where a release changes something a client can
see, the mock changes with it, and the test that pinned the old behaviour is
rewritten rather than deleted, so the reversal stays on the record.

### Version numbers

`Gilbert v2026.8.30+pr129` — the date of the commit this was built from, and
the pull request that commit arrived through. A commit that did not arrive
through one carries its short SHA instead: `2026.8.30+g1fa6578`. It all comes
from git at build time; nothing writes a version into the tree, and
`package.json` sits at `0.0.0` because it is no longer the source of anything.

The date is the commit's own rather than today's, so rebuilding an old commit
gives the version it had the first time.

```bash
node scripts/version.mjs        # the version for the current checkout
docker build --build-arg GILBERT_VERSION="$(node scripts/version.mjs)" -t gilbert:2026.8.30 .
```

`.dockerignore` excludes `.git` deliberately, so an image build cannot work this
out for itself — pass it in. Left out, the build reports `0.0.0`, which is meant
to look wrong: a version with no `+pr` or `+g` means whoever built the image did
not pass one.

The version says nothing about Stalwart, deliberately. It used to: `2.16.x` had
`16` for the 0.16 generation it targeted, which leaves nowhere to go once
Stalwart reaches 1.0 — `2.1` sorts *below* the `2.16` already deployed, so every
image and About screen would read as a downgrade. Which Stalwart a build needs is
stated where it can be precise, in the badge at the top of this file and in
[KNOWN-ISSUES.md](KNOWN-ISSUES.md), rather than compressed into one digit.

The pull request lives after the `+`, as build metadata, because it is
provenance rather than a rank: at the rate they merge here it climbs without
bound and says nothing about how new a build is. Everything after the `+` is
ignored when versions are compared, which is the right reading — two builds from
the same day differ in where they came from, not in age. Nothing here depends on
that comparison: images are pruned oldest-first by creation time, and a rollback
names a git ref.

### Deploying

[`deploy.example.sh`](deploy.example.sh) is a single-host Docker deploy: it
fetches, refuses anything held back by `.deploy-hold`, shows what is about to be
introduced and asks, rebuilds with the right version baked in, replaces the
container, waits for healthy, then prunes all but the newest
`GILBERT_KEEP_VERSIONS` images — never the one actually running.

```bash
./deploy.sh                 # origin/main, asks before shipping new commits
./deploy.sh --dry-run       # run the guards and stop
./deploy.sh v2026.8.30 --yes  # a named ref, no prompt (there is no tty over ssh)
```

`--yes` does not override a hold; clearing one means deleting its line.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) ·
[SECURITY.md](SECURITY.md) — please report vulnerabilities privately.

## License

Copyright (C) 2026 Sequi Company — AGPL-3.0-or-later. See [LICENSE](LICENSE).

The mail client Gilbert derives from is **ihasmail**, by **Coffey Labs**, used and
modified under the same licence: that attribution is in [NOTICE](NOTICE), and the
copyright in this build is Sequi Company's. The AGPL's section 13 is the point of
it — webmail is nearly always run as a network service rather than handed to
anyone as a binary, and that section closes the gap.

That offer has to point at *your* source, not this one. If you run a modified
Gilbert, set `SOURCE_URL` to your own repository — the sign-in page and
Settings › About both show it. See
[Rebranding](https://docs.ihasmail.org/rebranding/).
