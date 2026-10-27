<p align="center">
  <img src="docs/media/banner.png" alt="Gilbert — company mail and operations, with AI agents inside" width="880">
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: AGPL-3.0-or-later" src="https://img.shields.io/badge/licence-AGPL--3.0--or--later-2dd4bf?style=flat-square"></a>
  <a href="https://stalw.art" target="_blank" rel="noreferrer"><img alt="Requires Stalwart 1.0 or newer; followed against 1.0.0" src="https://img.shields.io/badge/Stalwart-1.0.0-6366f1?style=flat-square"></a>
  <a href="CONTRIBUTING.md"><img alt="Node 24 on the latest LTS line" src="https://img.shields.io/badge/Node-24-5fa04e?style=flat-square"></a>
  <a href="INSTALL.md"><img alt="Ships as a container image and a docker compose stack" src="https://img.shields.io/badge/Docker-image_%2B_compose-2496ed?style=flat-square"></a>
  <br>
  <a href="https://github.com/sequico/gilbert/actions/workflows/ci.yml"><img alt="CI: typecheck, Biome, the check scripts, i18n, the tests and the build" src="https://github.com/sequico/gilbert/actions/workflows/ci.yml/badge.svg"></a>
  <a href="docs/releasing.md"><img alt="Releases are cut by hand and gated by the same check" src="https://img.shields.io/badge/release-manual-1f6feb?style=flat-square"></a>
  <a href="https://github.com/sequico/gilbert/actions/workflows/codeql.yml"><img alt="CodeQL, run with the release and on demand" src="https://img.shields.io/badge/code_scanning-CodeQL-1f6feb?style=flat-square"></a>
  <a href="CONTRIBUTING.md"><img alt="Every contributed commit is signed off (DCO)" src="https://img.shields.io/badge/commits-DCO--signed-2dd4bf?style=flat-square"></a>
  <a href="https://github.com/sponsors/sequico"><img alt="Sponsor Gilbert on GitHub" src="https://img.shields.io/badge/sponsor-GitHub%20Sponsors-ea4aaa?style=flat-square"></a>
</p>

> **Try it live: <https://gilbertdemo.sequi.company>** — sign in with
> **`demo@example.com`** / **`demo`**. It is a **mock Stalwart held in memory**:
> no real mail and no real data, and it **restarts every night**, so nothing you
> leave there survives.

# Gilbert

**Company mail and operations, with AI agents inside.**

**G**eneral-purpose **I**ntelligent **L**ifecycle **B**utler for **E**nterprise
**R**esource **T**raceability.

Gilbert is **company mail and operations** — self-hosted mail, calendar, contacts
and files, a knowledge base and the procedures a job follows. Its **agent** does
the reversible work of a group's own account — reads inside documents, files and
labels mail, drafts the reply, settles workorder steps, proposes knowledge pages
and remembers facts — and stops wherever a person is answerable. The loop is part
of `gilbertserver`: the server starts it with itself and reads the Master's
groups on every pass, so a group added in Stalwart is worked without a restart.

Everything Gilbert keeps — mail, files, the knowledge base, the group's
instruction, audit trail,
the sessions themselves — is a document in your own [Stalwart](https://stalw.art)
mail server, under the account it belongs to. There is no Gilbert database: no
index, no cache tier, nothing durable on a disk, nothing to back up twice, and a
redeploy that loses nothing. The only third parties the installation talks to are the
model it configures and the addresses a reader asks it to fetch — a message's
remote images, a calendar a group subscribes to — and those through a proxy that
refuses private addresses.

## Why teams pick it

- **One place for the work.** Mail, calendar, contacts, files, the procedures and
  the checklists of a job live in the same account, so the message that arrives
  and the work it starts are never in two products.
- **An agent with a paper trail.** It does the reversible work of the group's own
  account and leaves every decision to a person; every run is a document the
  group can read, written before the act.
- **Yours, and only yours.** Self-hosted, AGPL, no telemetry; the only third
  party the installation talks to on its own is the model you choose.

## Who it is for

Gilbert is **operations software**. It is built for the people who keep a
business running — administration, back office, service desk, accounting,
whoever answers the phone — not for the people who sell.

It is deliberately **not a CRM** and ships no sales functions (no pipeline,
deals, leads or quote engine), and it is not an ERP either. A company that sells
can use it, because mail is mail and a purchase order that arrives as a PDF can
be read, filed and answered, but the product takes no position on revenue. What
it supports is the operation underneath: the work between something arriving and
the matter being closed.

## What the agent does

The agent is not a chatbot beside the mailbox. It works a group's own account
from the mail server's change log, and it does the reversible work itself.

- **Reads inside the documents.** A PDF's text layer, Word, a spreadsheet, an
  OpenDocument or a text file in Files, and a message's attachments; a scan or an
  image is transcribed by the installation's own model.
- **Files and sorts the mail.** Moves a message into a folder, puts a keyword or
  one of the product's reserved `G-` labels on it, keeps the label catalog and
  the folder tree tidy.
- **Drafts the reply, and leaves sending to a person.** A reply to everyone into
  the group's own Drafts, the thread carried, the group's own addresses left out.
- **Settles workorder steps** signed as the agent with the evidence beside it,
  and **proposes knowledge pages** as drafts for a person to approve.
- **Writes, moves and renames documents** in Files, and **creates events** in the
  group's own calendar — reversible work it owns. Overwriting or deleting a
  document, or changing or removing an event, needs a person's word; no
  invitation is sent and nobody outside the group is written to.
- **Remembers what it learns** as facts with the provenance they came from, and
  **says what it did** in the group's conversation or asks a person a question —
  the answer, in that same conversation, picks the run up again.

## What it will never do on its own

The guard is not the model's judgement. It is what can be undone and who is
answerable — five authority classes (ADR 0028), and only the first is the
agent's:

- **It decides** the reversible work inside the group's account: filing, labels,
  folders, drafts, knowledge-base proposals, workorder steps, creating a calendar
  event, facts, a question. Every effect is in the trace and can be undone by hand.
- **A person decides** anything irreversible or destructive — destroying a
  message, a folder or a page, deleting or overwriting a document, changing or
  removing a calendar event. The product's preference is that nothing disappears.
- **A person's own words** licence anything outward, and a word for one message
  reaches no other: a send names the address and the words, and the guard
  compares the act exactly. An instruction may declare in its own text that
  it sends, where its owner reads it.
- **An installation administrator, and only one**, overrides the written policy
  — proved by the directory, never by the sentence — and the trace carries the
  policy page, the moment and the message.
- **The intent is never the agent's**: which policy is right, what a workorder
  should carry, whether a knowledge change is accepted. It proposes; a person
  approves.

## A receipt for every run

Every run is one document in the group's own account, under `runs/`, where every
member can read it: the change that woke it, the instruction that answered, the
plan with what each step waited on, the branch that was not taken,
what each step answered, every authorisation with the words it arrived in, what
it recalled, what it spent and where it parked. The plan and what each step is
about to do are written **before** the act. A run ends done, waiting on a person,
stopped by a person, stopped by the liveness valve or refused — and any member of
the group can read it and stop a
running one.

A run has **no budget of its own**: no step, call, time or token amount ends it. What
stops one is the work finishing, a person, or the liveness valve at a hundred turns.
**One claim per installation** keeps exactly one agent working it; a holder that died
on the same host is taken over at once, and one on another host waits the lease —
a restart never leaves a document to delete by hand.

## Security at a glance

| | |
| --- | --- |
| **No password in the browser** | Sign-in posts the password once; the server seals it (HKDF-SHA256 → AES-256-GCM) and the browser keeps only an `HttpOnly`, `SameSite=Lax` cookie. |
| **Strict CSP, sanitised HTML** | `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`; message HTML is sanitised and remote images are fetched through a proxy. |
| **Images cannot scan the network** | The proxy resolves every hostname and refuses private, loopback, link-local, CGNAT and IPv6 equivalents; one bad record fails the fetch. |
| **CSRF and flooding** | Every mutating API call carries `X-Requested-With: gilbert` and refuses a cross-site `Sec-Fetch-Site`; sign-in is flood-limited by IP before the body is read and rate-limited by IP+username after it. |
| **No telemetry, no third-party requests from the browser** | No analytics, no telemetry; the CSP refuses any origin but its own, and a message's remote images are fetched through the proxy. |
| **Nothing to leak on disk** | No database and, with `IMMUTABLE=1`, no writable filesystem; sessions live in Stalwart, so a redeploy loses nothing. |
| **No hidden third party** | Zero-retention opt-out on every model call; a provider whose address is not public is refused unless the operator explicitly allows it; remote images and subscribed calendars are fetched only on a reader's request, through a proxy that refuses private addresses. |

The detail, item by item, is [FEATURES.md › Security and
privacy](FEATURES.md#security-and-privacy).

## The four blocks

Gilbert is four blocks. They are areas of the product, not directories — one
code tree holds several of them — and every document names them this way and no
other:

- **gilbertmailer** — the mail suite: mail, calendars, contacts, files, sharing
  and the Sieve editor. This is the block that came from upstream.
- **gilbertserver** — the Node process beside the browser: sign-in, sealed
  sessions, JMAP forwarding, the settings policy, the image and calendar
  proxies.
- **gilbertagents** — the agent: designed by ADR 0038 (which replaced 0027 and
  0031) — the loop
  that works a run and the supervisor the server's own boot starts, which asks
  for a pass every ten seconds — thirty while the wake stream is connected — and
  reads the Master's groups from the mail server on each one, so a group added in
  Stalwart is worked without a restart; what it cannot resolve — no model chosen,
  no group to work — leaves it idle with a line rather than stopping the server.
- **gilbertstalwart** — what is set inside Stalwart itself: the server's own
  configuration and system scripts, written through its management API, and the
  objects it holds (an account's identities, for example), written through JMAP.

*Server* is the word worth pinning down: **Stalwart** is the mail server that
holds every durable byte, and **gilbertserver** is this product's own Node
process.

One block and part of another came from **ihasmail**, Coffey Labs' immutable
webmail for Stalwart; the attribution is in [NOTICE](NOTICE). Everything else is
Gilbert's own, written here and not contributed back. Why, and what happens at
the boundary, is [ADR 0002](docs/adr/0002-upstream-contribution-model.md).

## The rest of the product

- **Groups, chat and a shared directory.** A group mailbox is an account owned
  by the group; chat is one conversation per group in that account; **Global
  contacts** is one directory the installation owns and every account reads.
- **A knowledge base and workorders** (Gilbert's own modules): a company-wide KB
  and one per group, holding the company's policies and procedures, with a shared
  draft, an administrator's approval and every issued revision kept; checklist
  templates authored with a **checklist builder** — a choice that holds
  throughout, sections that differ by it, a section that loops per item and a
  section assigned to a group, not markup; and workorders that gather the
  folders, files and pages of one job with a checklist bound to a KB template.
- **A mail client you would keep anyway.** Three-pane and keyboard-driven, with
  conversations, labels, search grammar, undo send, scheduled send, read
  receipts, S/MIME signature checking, calendars with invitations and free/busy,
  contacts with vCard import, and a visual Sieve rule builder. This is the part
  that began as upstream's.

## How it works

```
browser  ──(same-origin /api/*)──►  Gilbert server (Node + Hono)  ──(JMAP over HTTPS)──►  Stalwart
  React SPA                           • session cookie ⇄ Basic auth
  JMAP client + stores                • /api/jmap, /api/blob, /api/upload, /api/events, /api/image
```

- `web/` — React 19 + TypeScript SPA (Vite): JMAP client, zustand stores, views.
- `server/` — Node + Hono: authenticates against Stalwart's JMAP session
  endpoint, seals the credentials, proxies JMAP/blob/SSE and serves the SPA under
  a strict CSP. `src/mock/` is an in-memory fake Stalwart for development.

JMAP only, to Stalwart; no own database; every durable byte lives in Stalwart.
Features degrade gracefully by JMAP capability. The architecture decisions are
one file each in [docs/adr](docs/adr/README.md).

**The FileNode transport.** Stalwart 1.0 names a node's kind `@type` (`File`,
`Directory`, `SymLink`) and its MIME `mediaType`; everything inside Gilbert —
the stores, the run documents, the tests — calls them `nodeType` and `type` in
lower case. The translation lives in one boundary both tiers share
(`server/src/shared/filenode.ts`), applied by the two JMAP clients on every
request and response, so no surface carries a second spelling of a FileNode.
Speaking the wire's names throughout is the native form and is owed
([ROADMAP.md](ROADMAP.md) and `ADR-0011 OWED: native-filenode-wire`): the
boundary stays until that port lands.

## Requirements

A [Stalwart](https://stalw.art) **1.0 or newer** server. Sign-in refuses an older
one by name: the check reads the FileNode shape 1.0 introduced, so a 0.16 server
is turned away before anything writes. Node 24 (the LTS line) for a host
install; the container carries its own. Upgrading from 0.16 is a one-way
migration — see [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for the version notes.

## Quick start

**With Docker** — the published image, against a Stalwart 1.0+ you already run.
Gilbert expects a TLS reverse proxy in front of it (see [INSTALL.md](INSTALL.md)):

```bash
cat > .env <<'EOF'
STALWART_URL=https://mail.example.com
GILBERT_AGENT_ADDRESS=gilbert@example.com
GILBERT_AGENT_PASSWORD=change-me
EOF
docker run -d --name gilbert --restart unless-stopped \
  --env-file .env -p 127.0.0.1:8080:8080 ghcr.io/sequico/gilbert:latest
```

**From source (development)** — the whole app against an in-memory mock:

```bash
npm install
npm run dev:mock        # complete Gilbert against an in-memory mock Stalwart
```

Then open http://localhost:5173 and sign in with `demo@example.com` / `demo`.
The full install and operation guide is [INSTALL.md](INSTALL.md).

## Where to read more

| | |
| --- | --- |
| 🚀 **[INSTALL.md](INSTALL.md)** | Installing, running, configuring and operating Gilbert |
| 📋 **[FEATURES.md](FEATURES.md)** | Everything Gilbert does, feature by feature |
| 🧪 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)** | Where Stalwart departs from a spec, the settings a feature needs, and what Gilbert deliberately does not do |
| 🛣 **[ROADMAP.md](ROADMAP.md)** | What Gilbert does not do yet, and why |
| 🧭 **[CONTRIBUTING.md](CONTRIBUTING.md)** | Building, the gates, the mock, and how to contribute |
| 🏛 **[docs/adr](docs/adr/README.md)** | The architecture decisions behind all of it |

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) ·
[SECURITY.md](SECURITY.md) — report vulnerabilities privately, not in a public
issue.

Gilbert is free software under the AGPL; if it is useful to you, you can
[sponsor its development](https://github.com/sponsors/sequico).

## License

Copyright (C) 2026 sequicompany — AGPL-3.0-or-later. See [LICENSE](LICENSE).
The mail client Gilbert derives from is covered by the attribution in
[NOTICE](NOTICE).

The AGPL's section 13 is the point of it: webmail is nearly always run as a
network service rather than handed to anyone as a binary, and that section
closes the gap. That offer points at *your* source, not this one: if you run a
modified Gilbert, set `SOURCE_URL` to your own repository — the sign-in page and
Settings › About both show it.
