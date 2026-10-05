<p align="center">
  <img src="docs/media/banner.png" alt="Gilbert — the mail suite with AI agents inside" width="880">
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: AGPL-3.0-or-later" src="https://img.shields.io/badge/licence-AGPL--3.0--or--later-2dd4bf?style=flat-square"></a>
  <a href="https://stalw.art" target="_blank" rel="noreferrer"><img alt="Requires Stalwart 0.16 or newer; followed against 0.16.22" src="https://img.shields.io/badge/Stalwart-0.16.22-6366f1?style=flat-square"></a>
  <a href="CONTRIBUTING.md"><img alt="Node 24 on the latest LTS line" src="https://img.shields.io/badge/Node-24-5fa04e?style=flat-square"></a>
  <a href="INSTALL.md"><img alt="Ships as a container image and a docker compose stack" src="https://img.shields.io/badge/Docker-image_%2B_compose-2496ed?style=flat-square"></a>
  <br>
  <a href="https://github.com/sequico/gilbert/actions/workflows/ci.yml"><img alt="CI: typecheck, Biome, the check scripts, i18n, the tests and the build" src="https://github.com/sequico/gilbert/actions/workflows/ci.yml/badge.svg"></a>
  <a href="docs/releasing.md"><img alt="Releases are cut by hand and gated by the same check" src="https://img.shields.io/badge/release-manual-1f6feb?style=flat-square"></a>
  <a href="https://github.com/sequico/gilbert/actions/workflows/codeql.yml"><img alt="CodeQL, run with the release and on demand" src="https://img.shields.io/badge/code_scanning-CodeQL-1f6feb?style=flat-square"></a>
  <a href="CONTRIBUTING.md"><img alt="Every contributed commit is signed off (DCO)" src="https://img.shields.io/badge/commits-DCO--signed-2dd4bf?style=flat-square"></a>
</p>

# Gilbert

**G**eneral-purpose **I**ntelligent **L**ifecycle **B**utler for **E**nterprise
**R**esource **T**raceability.

Gilbert is **company mail and operations with AI agents inside** — self-hosted
mail, calendar, contacts and files, a knowledge base and the procedures a job
follows. Agents read incoming mail and files, file documents into the right
folder, read the document inside them, draft replies and report what they did in
the group's chat. What they may do is a capability list an administrator writes
and code enforces; every effect is recorded before it happens; and anything that
leaves the group waits for a person to approve it, in words.

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
  proxies. The agent fleet runs inside it.
- **gilbertagents** — the agents: the Master principal, the agent fleet, the
  automations, the approvals and the audit.
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

- **Agents that work mail and files.** An agent is a Stalwart account of its own
  (`gilbert@…`) granted on a group like any colleague. An **automation** is a
  trigger (mail, chat, a file, the clock), an instruction in prose and a
  **capability allowlist**. The allowlist is checked in code on every answer, so
  neither the model nor a cleverly worded instruction can widen it. A group's
  review policy can pause a run for a person; a send outside the group always
  asks first.
- **A receipt for everything.** Every run is recorded, one line written before
  the effect, in a monthly document per group kept twelve months and readable by
  every member.
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
  a strict CSP. `src/mock/` is an in-memory fake Stalwart for development;
  `src/agent/` is the fleet.

JMAP only, to Stalwart; no own database; every durable byte lives in Stalwart.
Features degrade gracefully by JMAP capability. The architecture decisions are
one file each in [docs/adr](docs/adr/README.md).

## Requirements

A [Stalwart](https://stalw.art) **0.16 or newer** server. Sign-in refuses older
versions by name. Node 24 (the LTS line) for a host install; the container
carries its own. Upgrading from 0.15 is a one-way migration — see
[KNOWN-ISSUES.md](KNOWN-ISSUES.md) for the version notes.

## Quick start

```bash
npm install
npm run dev:mock        # complete Gilbert against an in-memory mock Stalwart
```

Then open http://localhost:5173 and sign in with `demo@example.com` / `demo`.
`npm run dev:mock:agent` is the same stack with an agent process running. Running
Gilbert for real is [INSTALL.md](INSTALL.md).

## Where to read more

| | |
| --- | --- |
| 🚀 **[INSTALL.md](INSTALL.md)** | Installing, running, configuring and operating Gilbert |
| 📋 **[FEATURES.md](FEATURES.md)** | Everything Gilbert does today, feature by feature |
| 🧪 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)** | What was verified live, and where Stalwart departs from a spec |
| 🛣 **[ROADMAP.md](ROADMAP.md)** | What Gilbert does not do yet, and why |
| 🧭 **[CONTRIBUTING.md](CONTRIBUTING.md)** | Building, the gates, the mock, and how to contribute |
| 🏛 **[docs/adr](docs/adr/README.md)** | The architecture decisions behind all of it |

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) ·
[SECURITY.md](SECURITY.md) — report vulnerabilities privately, not in a public
issue.

## License

Copyright (C) 2026 Sequi Company — AGPL-3.0-or-later. See [LICENSE](LICENSE).
The mail client Gilbert derives from is covered by the attribution in
[NOTICE](NOTICE).

The AGPL's section 13 is the point of it: webmail is nearly always run as a
network service rather than handed to anyone as a binary, and that section
closes the gap. That offer points at *your* source, not this one: if you run a
modified Gilbert, set `SOURCE_URL` to your own repository — the sign-in page and
Settings › About both show it.
