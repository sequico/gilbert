<p align="center">
  <img src="docs/media/banner.png" alt="Gilbert — company mail and operations" width="880">
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: AGPL-3.0-or-later" src="https://img.shields.io/badge/licence-AGPL--3.0--or--later-2dd4bf?style=flat-square"></a>
  <a href="https://stalw.art" target="_blank" rel="noreferrer"><img alt="Requires Stalwart 0.16 or newer; followed against 0.16.23" src="https://img.shields.io/badge/Stalwart-0.16.23-6366f1?style=flat-square"></a>
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

**G**eneral-purpose **I**ntelligent **L**ifecycle **B**utler for **E**nterprise
**R**esource **T**raceability.

Gilbert is **company mail and operations** — self-hosted mail, calendar, contacts
and files, a knowledge base and the procedures a job follows. Its agent is partly
built: it reads incoming mail and files, files documents into the right folder,
reads the text a document holds and reports what it did in the group's chat —
inside the group's own account, everything recorded, and anything that leaves the
group waiting for a person to say so, in words. The loop that works it is part of
`gilbertserver`: the server starts it with itself, and it is there once the
installation has chosen a model; the groups it works are read on every pass, so
one the Master is added to is worked within ten seconds and nothing has to be
restarted.

> **The agent part (`gilbertagents`) is partly built.** Its decisions are
> ADR 0031–0037; the tree carries a run's durable state, the catalogue of tools
> — reading, and writing the group's own account — a group's rules in prose and
> the three levels every call is told, the installation's one model with its two
> turns of decision, the memory of facts in the Master's own account, the loop
> that works a run, the supervisor the server's own boot starts with itself
> (`server/src/agent/supervisor.ts`), and the administration that shows what it
> did and lets a person correct what it remembers.

Everything Gilbert keeps — mail, files, the knowledge base, rules, audit trail —
is a document in your own [Stalwart](https://stalw.art) mail server, under the
account it belongs to. There is no Gilbert database: no index, no cache tier, no
writable disk, nothing to back up twice, and a redeploy that loses nothing. The
only thing that leaves the installation is the model call the installation itself
configures.

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

## The four blocks

Gilbert is four blocks. They are areas of the product, not directories — one
code tree holds several of them — and every document names them this way and no
other:

- **gilbertmailer** — the mail suite: mail, calendars, contacts, files, sharing
  and the Sieve editor. This is the block that came from upstream.
- **gilbertserver** — the Node process beside the browser: sign-in, sealed
  sessions, JMAP forwarding, the settings policy, the image and calendar
  proxies.
- **gilbertagents** — the agent: designed by ADR 0031–0037 and built as far as
  the loop that works a run and the supervisor that runs it, started by the
  server's own boot; it asks for a pass every ten seconds and reads the Master's
  groups from the mail server on each one, so a group added in Stalwart is worked
  without a restart; what it cannot resolve — no model chosen, no group to work —
  leaves it idle with a line rather than stopping the server.
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

## What it does

The short version; [FEATURES.md](FEATURES.md) is the inventory.

- **Agents for mail and files.** The agent acts for a group, inside that group's
  own account, as the Master principal (`gilbert@…`). It reads the company's
  written policy and the group's own rules, does the reversible work of the
  account — filing, labelling, **drafting a reply to everyone** in Drafts to be
  sent by a person, **settling a step of a workorder**, **proposing a change to a
  knowledge page** as its draft — remembers what it learns as facts in the
  Master's own account, records what it did and why, and asks a person for
  anything that leaves the account — or for anything the policy forbids
  (ADR 0031–0037).
- **A receipt for everything.** Every run is one document in the group's own
  account, under `runs/`, where every member can read it: what woke it, the plan
  with what each step waited on, what each step answered, what it spent and where
  it parked. The plan and what each step is about to do are written **before** the
  act, so a container that dies in the middle leaves the account with a record of
  what the run was doing.
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
- **Nothing sensitive in the browser.** The sign-in password is sealed on the
  server; the browser gets an `HttpOnly` cookie. Strict CSP, sanitised HTML,
  remote images through an SSRF-safe proxy, every JMAP call on the same origin.
- **Nothing of its own to keep.** No database, no search index, no cache tier.
  Sessions included, so a redeploy does not sign anybody out.

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

## Requirements

A [Stalwart](https://stalw.art) **0.16 or newer** server. Sign-in refuses older
versions by name. Node 24 (the LTS line) for a host install; the container
carries its own. Upgrading from 0.15 is a one-way migration — see
[KNOWN-ISSUES.md](KNOWN-ISSUES.md) for the version notes.

## Quick start

**With Docker** — the published image, against a Stalwart 0.16+ you already run.
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
| 📋 **[FEATURES.md](FEATURES.md)** | Everything Gilbert does today, feature by feature |
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
