*Gilbert was born on **19 September 2026, at 23:55:47 CEST** (Europe/Rome) — the push that turned a pile of opinions into a product. Everything below is what it has been arguing about since.*

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/public/img/logo-inverse.png">
    <img src="web/public/img/logo.png" alt="Gilbert" width="150">
  </picture>
</p>

<!-- Facts this file verifies further down, and states nowhere twice: the licence
     is LICENSE's, the Stalwart floor is the section of that name, Node 24 is what
     the Dockerfile, ci.yml, `engines` and @types/node all say, the container is
     the Quick start's, and the second row is what the Development and Code
     scanning sections describe as the gates. No badge here is GitHub-derived
     through shields: this repository is private, so `img.shields.io/github/...`
     answers "repo not found" for it. The CI badge is GitHub's own, which a
     signed-in reader with access gets. -->
<p align="center">
  <a href="LICENSE"><img alt="Licence: AGPL-3.0-or-later" src="https://img.shields.io/badge/licence-AGPL--3.0--or--later-2dd4bf?style=flat-square"></a>
  <a href="https://stalw.art" target="_blank" rel="noreferrer"><img alt="Requires Stalwart 0.16 or newer; followed against 0.16.22" src="https://img.shields.io/badge/Stalwart-0.16.22-6366f1?style=flat-square"></a>
  <a href="#development"><img alt="Node 24 on the latest LTS line" src="https://img.shields.io/badge/Node-24-5fa04e?style=flat-square"></a>
  <a href="#quick-start-docker"><img alt="Ships as a container image and a docker compose stack" src="https://img.shields.io/badge/Docker-image_%2B_compose-2496ed?style=flat-square"></a>
  <br>
  <a href="https://github.com/sequico/gilbert/actions/workflows/ci.yml"><img alt="CI: the release pre-check — typecheck, Biome, i18n, the tests, the build and a Docker smoke build" src="https://github.com/sequico/gilbert/actions/workflows/ci.yml/badge.svg"></a>
  <a href=".githooks/pre-push"><img alt="The pre-push hook runs the fast gate before every push: typecheck, Biome, the check scripts and the tests" src="https://img.shields.io/badge/gate-typecheck%20%C2%B7%20Biome%20%C2%B7%20tests-1f6feb?style=flat-square"></a>
  <a href="#code-scanning"><img alt="GitHub code scanning with the JavaScript/TypeScript suite, on every push and pull request" src="https://img.shields.io/badge/code_scanning-CodeQL-1f6feb?style=flat-square"></a>
</p>

# Gilbert

**G**eneral-purpose **I**ntelligent **L**ifecycle **B**utler for **E**nterprise
**R**esource **T**raceability.

**An enterprise butler that lives in your own mail server.** Gilbert is a
first-class mail suite — mail, calendars, contacts, files — with **agents
inside it**. They read what arrives, file the paperwork in the right folder,
read the document inside it, draft the answer, and say in the group's chat what
they have done. What they may do is a list an administrator writes; every
effect is written down before it happens; and anything that reaches outside the
group waits for a person to say yes, in words.

Everything Gilbert keeps — the mail, the files, the rules, the audit trail —
is a document in your own [Stalwart](https://stalw.art) mail server, under the
account it belongs to. There is no Gilbert database: no index, no cache tier,
no writable disk, nothing to back up twice, and a redeploy that loses nothing.
The one thing that leaves the building is the *thinking*: an installation
names one model to reason with — a provider, a model and an address you choose,
which may be inside your own network.

**You already have the hard part.** Gilbert stores nothing of its own, so
getting it running means pointing it at the mail server you already operate.
What you get is a client good enough to move into, and a set of agents that do
the work around it.

> **Try it in a minute — no server needed.** `npm run dev:mock` runs a complete
> Gilbert against an in-memory mock Stalwart; open http://localhost:5173 and
> sign in with `demo@example.com` / `demo`. `npm run dev:mock:agent` is the same
> stack with an agent process running, so the agent surfaces — Master, Group
> Agents, Approvals — are there with a group already granted. The automations
> are yours to write, and a run needs a model configured in Master first.

## What you get today

Everything below ships. It is the order this project cares about, not the order
someone would build a mail client in: the agents are the reason Gilbert exists,
and the mail client is what they live in.

- **Agents that work the mail and the files.** An agent is a mailbox of its
  own on Stalwart — `gilbert@…` — granted on a group the way any colleague is.
  It watches four things: **mail** arriving, a **file** landing in the group's
  Files, a **chat** message, and the **clock**. For each of them an
  administrator writes an automation in a form, not in code — and the form asks
  for three things: *when* it reacts, *what it is asked to do* in prose, and
  *what it may do*, chosen as three areas (mail, chat, files and documents)
  plus sending, which no area can grant on its own. It can label and move a
  message, save its attachments into the right folder, read a PDF or a
  spreadsheet or a scan, split, merge and extract PDF pages, prepare a reply
  in Drafts, write a text document, post in the chat, and send.
- **A leash, not a promise.** What an automation may do is a short list of
  permissions checked in code on every answer, so neither the model nor a
  cleverly worded instruction can widen it. The group's own review policy can
  pause a run for a person; the pause becomes a question in the group's chat,
  answered in words by any member. Sending outside the group always asks first,
  whatever the policy says.
- **A receipt for everything.** Every run is recorded — one line written
  *before* the effect, so an effect never exists without a line that accounts
  for it — in a monthly document per group, kept twelve months, readable by
  every member and exportable as JSON by an administrator before the oldest
  month is pruned. What the thinking cost is recorded in tokens, run by run.
- **Agents that know the place.** What an agent is told has three levels: the
  **installation's own rules** — written once in Admin → Master and carried
  into every call of every group — a group's **standing instruction** (how it
  works, in what language, in what tone), and each automation's own
  instruction. Beside them a group keeps a **notebook** of facts nobody should
  have to repeat: its clients' names, how its mail is filed. Each of the three
  is a document — two in the group's own account, one in the Master's — so a
  replacement agent, a restart or a redeploy picks up exactly where the last
  one was.
- **Groups, as real accounts.** A group mailbox is an account of its own,
  owned by the group from creation: its mail, its calendars, its files, its
  label catalog, its agent's documents. Membership *is* the permission — set
  in Stalwart's own administration — and a member added later finds everything
  already there.
- **Chat, one conversation per group.** In the group's own account, so it
  survives people joining and leaving, with replies, `@` mentions of the whole
  roster, per-member read markers and search across the whole history. This is
  also where the agents talk and where approvals happen.
- **File management that holds up.** A folder tree that remembers how you left
  it, drag and drop from your desktop — a whole folder uploads with its
  structure, empty folders included — uploads you can **cancel** mid-flight,
  sorted columns that keep their order per folder, multi-select with download,
  move and delete, and sharing per file and folder with rights per person.
  Attach from Files without uploading again; save a message's attachments
  straight into a folder of your own **or a group's**, so the file becomes the
  group's.
- **A mail client you would keep anyway.** Three-pane, keyboard-driven, with
  conversations, labels, search grammar, cards inside messages, undo send,
  scheduled send, read receipts, S/MIME signature checking, and graceful
  degradation: if the server lacks a capability, the surface for it is not
  drawn rather than broken. Calendars with invitations and free/busy, contacts
  with vCard import, and a visual Sieve rule builder whose script is a real
  Sieve script. (This part began as upstream's — see
  [the line to upstream](#the-blocks-and-the-line-to-upstream).)
- **Administration, three surfaces and no more.** **Master** configures the
  installation once — the agent's identity, the one model and its bounds, the
  rules that hold in every group, and which groups it serves. **Group Agents**
  is one group's workspace: its automations, its standing instruction, who its
  runs stop for, its notebook, its audit, and a button that runs one now.
  **Approvals** is the cross-group view of what is waiting for a person and
  what the fleet has done.
- **Nothing sensitive in the browser.** The password somebody types at sign-in
  is sealed on the server and never kept in the page; the browser gets an
  `HttpOnly` cookie and nothing else. Strict CSP, sanitised HTML with remote
  images fetched through a proxy that refuses to be pointed at private network
  addresses, and every JMAP call on the same origin.
- **Every device, in your language.** Installable PWA with Web Push while
  Gilbert is closed, `mailto:` handler, eleven interface languages (ten still
  marked Beta, honestly), twelve themes, and a container that runs with no
  writable filesystem at all.
- **Nothing of its own to keep.** No database, no search index, no cache
  tier. Every durable byte is in Stalwart under the account's quota, sessions
  included — which is why a redeploy does not sign anybody out, and why
  keeping the mail server is the whole backup story.

**Not in it yet**, and said plainly: agents for individual mailboxes (group
agents only), more than one agent inside the same group at a time, two-factor
sign-in without an app password, snooze, and translations no native speaker
has read yet. The reasons, and the rest, are in [ROADMAP.md](ROADMAP.md).

## A day with the butler

Three examples, close to what the code actually does. None of it is a mock-up:
automations are documents, runs are audited, and the permissions below are the
ones in the catalogue.

**The invoice that files itself.** An invoice arrives at `accounts@`. The
group's standing instruction says clients are filed under the name on the
document and that the group is told what came in. The mail automation wakes,
hands the message and the instruction to the installation's model, which saves
the attachment into the group's Files — in the folder the automation named, or
the one the model chose, and into `Needs attention` when neither decided —
labels the message, and posts one line in the group's chat: *"Acme — invoice
2481, dated 12 March, filed under Acme."* If the group's review policy
asks for confirmation, the draft is prepared and the question appears in the
chat instead, and nothing goes out until a member answers.

**The contract nobody wants to retype.** Somebody drops a forty-page PDF into
the group's Files. A file automation reads it — the text layer where there is
one, and where a page is only a picture, that page is rendered and read as a
picture — and writes what it says back into the group's Files as a text
document, or answers in the chat. A reading carries a bounded number of pages
(eight, unless the installation says otherwise) and when a document is longer
than that, the run is *told* it read the beginning rather than being left to
pretend it saw the whole thing.

**The bundle that becomes four documents.** A scan of four contracts arrives as
one PDF. An automation splits it into one file per page, into the folder the
automation names, and the group is told in the chat that it happened. Sending
anything is a different permission entirely, and it is not on the list.

Work like that hands off to work like that: a file written into the group's
Files wakes the rule that watches files, and a question answered in the chat
closes the run that asked it. A chain runs five hops by default and then
refuses loudly, with a line in the chat naming the automation and the bound —
so two automations that wake each other end by themselves, with a reason a
person can read. The number is the installation's to set.

## Why it is different

- **It works where your mail already is.** No sync, no import, no second copy
  of anything. Gilbert is a client and an agent process; the server holds every
  durable byte.
- **The permissions are code, not a prompt.** An automation's capability list
  is checked on every answer the model gives. Asking nicely does not widen it.
- **A person can always stop it.** A group's review policy pauses runs, the
  approvals happen in the group's chat, and an external send always needs an
  explicit yes from a human.
- **It is auditable without a data warehouse.** The trail is a document per
  month per group in the group's own account: members can read it, and an
  administrator can export it as JSON before it ages out.
- **The model is yours to choose.** One model per installation, configured
  once — provider, model, base URL, write-only key — and a deployment may point
  it at a model on its own network, which the operator states in the
  environment rather than the installation granting itself the right.
- **It is a real mail client, not a chat window with an inbox.** The mail,
  calendar, contacts, files, filters and sharing surfaces are the ones people
  use all day; the agents are an addition to that, not a replacement for it.
- **Yours to run, and quiet by default.** Self-hosted on the server you already
  pay for, with no telemetry and no vendor cloud in the loop. What an
  automation needs to reason over goes to the model the installation names and
  nowhere else — and a deployment that runs that model inside its own network
  sends nothing out at all.
- **Open source, AGPL.** Run it, read it, change it. Modifications you serve to
  others come back as source, which is the point of the licence.

## Try it, then run it

```bash
npm install
npm run dev:mock        # complete Gilbert, mock Stalwart, demo@example.com / demo
```

Then http://localhost:5173. An agent-included stack, a real server, and the
scripts this repository is worked with are in [Development](#development) below,
where the commands are listed once.

---

*Below this line: everything for the people running Gilbert and the people
working on it.* The first part of this file is the product; `FEATURES.md` is
the feature-by-feature inventory; `docs/adr/` explains why the architecture is
shaped the way it is.

## Requires Stalwart 0.16 or newer

Sign-in refuses anything older, by name. 0.16 replaced the REST management API
with JMAP registry objects, changed the shape of `FileNode`, split its rights up
and moved configuration into the store; supporting both generations meant a
wrong guess had somewhere to fall back to, so it failed *quietly* — and that
reached production. With one supported generation a wrong guess is a loud error
on the first call.

**Followed against 0.16.22**, released 13 September 2026. Its four
client-visible JMAP changes are all in what `CalendarEvent/get` and
`ContactCard/get` return, and the mock reproduces all four:
`baseEventId` is the master's id on a synthetic id and `null` on anything else,
where it used to report the event's own id; `recurrenceRule` and
`recurrenceOverrides` named on a synthetic id come back `null` rather than
absent; `useDefaultAlerts` is the reader's own and reads `false` until it is
set; and an empty `properties` list returns `id` alone, where it used to mean
"everything".

**Validated by hand against 0.16.21**, released 6 September 2026: the app was run
against a real instance of it and the mail, calendar and contacts paths were
exercised by hand. Four of that release's JMAP changes are visible to a client
— an occurrence of a recurring event is now identified by its recurrence id
rather than by its position in the series, so an id held across a write no
longer silently names a different date; `Calendar/get` and `AddressBook/get`
return every property when none are named; EventSource advertises its ping
interval in seconds rather than milliseconds; and a calendar write that asks
for scheduling messages is refused when the account may not send them. The mock
reproduces those four as well.

- Upgrading? [stalwart-migrator](https://git.coffeylabs.org/coffey-labs/stalwart-migrator) does it in place, checkpointing every phase and validating afterwards. The live instance moved 0.15.5 → 0.16.19 with eight seconds of downtime and nothing lost.

## Quick start (Docker)

```bash
cp .env.example .env
# edit: STALWART_URL=https://mail.example.com, and the Master's own account in
# GILBERT_AGENT_ADDRESS / GILBERT_AGENT_PASSWORD (.env.example says what for)
docker compose up --build -d
# → http://localhost:8080  (put Caddy/nginx in front for TLS; see Caddyfile.example / nginx.example.conf)
```

That command is a complete installation: the web client, and an agent beside it
that serves the groups you have granted it. Users sign in with their Stalwart
mailbox credentials. **An account with two-factor authentication needs an app
password**, created in Stalwart's own settings — Stalwart accepts a TOTP code
only through an OAuth flow and offers no password grant, so no client holding a
username and password can exchange them plus a code for a token.

The variables *this* build reads, and what each one is for, are in
[`.env.example`](.env.example); `Caddyfile.example` and `nginx.example.conf` in
this repository are the drop-in configuration for a TLS front.

### Turning the agents on

An agent is a Stalwart account, and its grant is membership — there is no
second switch in the product. So the whole of it is:

1. In **Stalwart's own administration**, create an account for the agent
   (`gilbert@example.com`) and **add it to the groups it should work in**.
2. Give the deployment that account's **own password** — not an app password:
   the agent signs in as itself — in `GILBERT_AGENT_ADDRESS` and
   `GILBERT_AGENT_PASSWORD`.
3. Start Gilbert. The server runs an agent beside the web tier in its own
   process (ADR 0003); a deployment that wants the fleet apart runs
   `node server/dist/agent/agent.js` instead, with `agent.inProcess` false in
   the installation document.

Then **Administration → Master** shows the groups the agent can see and holds
the rules that apply in every one of them, and **Group Agents** is where each
group's automations are written, beside its own standing instruction and the
policy its runs are held to. A group the agent belongs to that has never heard
from it gets one message — *"Hi all! Gilbert here, at your service."* — posted
when the agent takes the group up,
which is the proof it is working there, readable through any member's own
session.

## Container images

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

The server keeps **no writable state of its own**: sessions, settings, the
installation's configuration and every document a feature owns live in Stalwart,
in the accounts they belong to. There is no path to clear, so the container can
run with no writable filesystem at all:

```bash
docker run --read-only --tmpfs /tmp -e IMMUTABLE=1 ...
```

`IMMUTABLE=1` is an assertion the server checks at startup rather than a switch
that changes what it does: it probes the filesystem it is installed on and
refuses to boot when that filesystem turns out to be writable after all — the
flag without the fact. Without the flag the same misconfiguration is silent,
and the first thing that tries to write is the one that notices.

Sessions are in that set like everything else, so a redeploy does not sign
anybody out and the mode costs nothing to keep on.

### Live updates

Live updates reach a tab by one of two transports, and both carry the same
types, so which one a deployment is on does not decide which parts of the app
update.

By default Gilbert holds one Server-Sent Events stream per tab, upstream to
Stalwart and back. It needs no configuration, and it is what a tab falls back
to.

Gilbert then registers one subscription per account with Stalwart and fans its
change notifications out to that account's open tabs, holding **no upstream
connection per tab**. A reconnect is then local, between the browser and
Gilbert, rather than a fresh dial to Stalwart -- and a deployment's
open-connection count stops tracking its open tabs.

There is no address to configure. The origin Stalwart POSTs back to is taken
from the request itself, and only when that request is believable: it arrived
over https -- RFC 8620 requires the scheme -- from a proxy Gilbert runs, that is
the installation's `server.trustProxy` is on and the peer is inside
`server.trustedProxies`. A Gilbert reached
directly, or over plain http, keeps the per-tab relay for every account: nothing
is lost, reconnecting is simply not local. An account that never verifies stays
on the relay for its whole life. The fan-out covers every surface -- mail, files
and chat, calendars, contacts, filters and the storage quota -- for
every account.

`GET /api/health` says what actually happened: `push.accounts` counts the
verified, pending and failed subscriptions, and `push.tabs` splits the open tabs
into `fanout` and `relay`. `push.mode` set to `relay` in the installation's own
document keeps the per-tab stream and never subscribes.

### The installation's own configuration

The installation's configuration is **one document in Stalwart**:
`installation.json` in the Master account's own `gilbert` app folder. A boot
signs in as the Master, reads that document whole, and runs on it; the first
boot writes it — the defaults and a freshly generated app secret — and
**Administration → Installation** edits it from then on. Nothing about it is on
the container, so a redeploy reads back exactly what the last edit wrote, and a
publish is in force from the **next boot**: the running process keeps the
configuration it booted with.

The environment carries four classes of value:

- **The handshake** — `STALWART_URL`, `GILBERT_AGENT_ADDRESS`,
  `GILBERT_AGENT_PASSWORD`, and `STALWART_FOLLOW_ADVERTISED_URLS` for a
  deployment whose proxy rewrites the host: how Stalwart is reached, and which
  account holds the document. The three have no defaults, and a boot that finds
  one missing stops and names it. They cannot come from the document, because
  the document lives in Stalwart.
- **The container's own facts** — `HOST`, `PORT`, `IMMUTABLE`: which interface
  and port this process was given, and whether its root filesystem is read-only.
  A container that states `HOST`/`PORT` overrides the document's; one that
  states neither takes the document's.
- **The image's facts** — `STATIC_DIR`, `SOURCE_URL`, `GILBERT_ADMIN_PERMISSION`,
  the version the build calls itself (`GILBERT_VERSION`), and `NODE_ENV`, which
  is what the two refusals below read.
- **The operator's own statement** — `GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER`:
  whether this deployment may point the installation's model at an address
  inside its own network. It is read from the environment and nowhere else,
  because an installation must not grant itself that right.

**`BASE_PATH` is the image's fact, one value in two places.** The build argument
bakes the prefix into the web bundle's asset URLs, and `BASE_PATH` in the
running container tells the server which prefix to serve (`""` is the domain
root). It is deliberately **not** in the installation's document: a document
that could move it could disagree with the bundle, and the symptom is a blank
page. `assertServable` refuses two
configurations no production process may serve on — one that states no prefix at
all, and one whose app secret is ephemeral, minted because nothing stated one.

The document's `secret` is the key every stored session is sealed with, and it
is **generated on the first boot** and written into the document, because a
secret the container holds is a secret a redeploy loses. `APP_SECRET` is what a
process with no boot runs on — a test, a tool, a development
server started without a sign-in — and the document decides for a booted one, so
rotating `APP_SECRET` signs nobody out. `appSecretSource` travels with the
configuration and says which of the three it was.

Every other knob — the session lifetimes, the upload ceiling, the routing table,
whether a proxy is trusted, the cookie's name, the fleet's timers and bounds —
is a field of that document, with the `TRUST_PROXY`, `SESSION_TTL`,
`GILBERT_AGENT_*` and other names of the same settings being what a process with
no boot runs on. The sections, and what each one holds, are listed in
[`.env.example`](.env.example) and in
[FEATURES.md](FEATURES.md#configuration).

### Several Stalwart servers

One Gilbert can front more than one Stalwart, choosing by the domain somebody
signs in with. The installation's own document says which: its `upstreams`
section, published from **Administration → Installation** like everything else
the installation decides. **`STALWART_URL` stays the default**, so an
installation that says nothing here behaves exactly as it always has.

```json
{
  "upstreams": {
    "example.com": "https://mail.example.com",
    "customer-b.test": "https://jmap.customer-b.test"
  }
}
```

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

An installation decides and locks user settings, which is what a school wanting
"warn about outside senders" on for three thousand pupils needs — asking three
thousand pupils is not a plan.

It says so in a document, published from **Administration → Installation
policy**. Nothing about it is passed in the environment and nothing is mounted:
the policy lives in Stalwart, in each account it applies to.

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
in shape, and that is deliberately whose idea it was (upstream's issue #207).

Nothing is configured by default: an installation that sets none of these
behaves exactly as Gilbert always has.

### Publishing a policy (ADR 0001)

The live policy is not a file or a variable: **Administration → Installation
policy** publishes it into every individual account's own Stalwart storage, by
impersonation, the same way an administrator sets a person's default identity.
There is nothing to mount and nothing that needs a volume — publishing works
identically under `IMMUTABLE=1`, and a redeploy or a second replica reads
exactly what the last publish wrote, because that is where it lives.

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
that document with every section explained in it — paste it into the editor and
delete what you do not want.

Publishing applies at once: every account the directory lists gets the document
written into its own app folder (impersonated), the publishing administrator's
account included, and every other signed-in session is kicked so its next
sign-in reads the new policy (ADR 0001). One account's refusal — no
impersonation grant, an unreachable session, an account with no Files to hold it
— does not stop the rest.

**The publish is a job with an id** (ADR 0010). One id is minted before the
first copy goes out, and every copy written carries it as
`published: { id, at }` beside the policy, so any account an administrator opens
says which publish reached it. The job itself is one document,
`gilbert/publish-job.json` in the publishing administrator's own app folder,
holding the id, when the publish started, who published, the population the
directory reported (the accounts it listed, whether that listing was the whole
directory, and the total when the server stated one), the accounts the policy
reached, the ones it did not with a code for each — `impersonation-refused`,
`no-files-account`, `write-failed`, `policy-moved`, `directory-denied` — and
whether the installation can be said to carry the policy. It lives in the
account rather than in the process, so **Administration → Installation policy**
reads the same answer back after a restart and names the publish it is showing.
A publish that could not store its own record says `record: "failed"` rather
than answering a job no later read can find.

**Every per-account write is conditional**, against the state of the account it
lands in, so a copy that would replace one somebody else just wrote is refused
instead (`policy-moved`) and the account keeps the copy it had. And no publish
claims more than it reached: it counts as complete only when the directory it
read *was* the whole directory and every account the directory listed received
the policy. A count of successes is not that claim, so the surface does not make
it.

An account no publish has reached reads the built-in defaults, and an account the
last publish did not list falls back to them until the next publish reaches it.
There is no environment variable for this: an installation states its policy in
the editor, or it states none.

### Writing a policy

Both sections take the same names and values a settings export uses, so
`Settings → General → Export` on one account you have configured by hand is the
quickest way to write one — copy the keys you care about out of the file.

Checks worth knowing about, because they fail loudly rather than quietly:

- **Malformed JSON is refused at publish time (400, nothing changes).** A
  policy that silently did not apply would be indistinguishable from the
  feature not working.
- **Every change needs a unique `version`.** Two changes sharing one, or a
  change with no `version` or no `settings`, is refused.
- **Keys this build does not have are dropped**, the same rule an imported
  settings file gets. A `changes` entry whose keys are *all* unknown is dropped
  whole rather than recorded as applied, so it still runs on a Gilbert that
  does have the setting.

Enforcement is applied in the settings store rather than only on the controls,
so an imported settings file, a settings file synced from a device that predates
the policy, and "reset to defaults" cannot get around it. Reset returns to your
defaults, not to Gilbert's.

## Agents, in detail

The installation's **Master** is an ordinary account on the server that
Gilbert acts as; its **agents** — the fleet — are the processes that act as it,
and they are the largest thing this project owns. This is the technical
version; [FEATURES.md](FEATURES.md#agents) is the long one. (A *worker* is only
ever the browser's service worker, which is a different animal with a
confusingly similar name.)

**Admin → Master** shows the groups the agent is in, read from the Master's own
session in Stalwart, and holds the rules that are true in all of them;
**Admin → Group Agents** narrows what it does inside one, a group at a time: the
automations it runs there, its standing instruction, who its runs stop for, what
is waiting on a person, and the agents carrying them out. The pair of
environment variables is what a boot cannot do without: a deployment that
states neither, or whose pair Stalwart refuses, does not come up, and the boot
names what is missing rather than serving an installation whose document nobody
can read. An agent process
started on its own is the other half of that sentence — with nothing named it
warns once, keeps running and serves nothing rather than failing to come up.

**What it does.** An **automation** is a document in the group's own account,
and it is three things: when it reacts (an email arriving, a chat message, a
file, a time), an **instruction** in prose, and a **capability allowlist** —
what it may do, chosen as three areas plus sending. Every run hands the
instruction to the installation's model, which decides and acts inside what the
automation was granted: label, move, file attachments into the group's visible
Files, prepare a draft, send, write a text document, read a document, split and
merge PDFs. One enabled automation per trigger is the rule — an automation
carries no filter, so two on one trigger would answer the same arrival twice —
and the branching between one kind of mail and another belongs in the prose. A
group also keeps a **notebook** of durable facts about it, and the prose an
agent works by has three levels: the **installation's own rules** (Admin →
Master, carried into every call of every group), the group's **standing
instruction** — the shape of an `AGENTS.md` — and the automation's own. One can
also be **run now**, on the newest message in the group's inbox: that is how you
see one work without waiting for mail to arrive, and the ask is recorded as an
ask.

**What holds it back.** The automation's **capability allowlist** bounds every
answer, checked in code rather than asked for in a prompt, so neither the model
nor any of those instructions can widen it. How cautious a run is *asked* to be
is a fact about the group rather than about one automation: the group's own
**review policy** — one document for all of them, two choices and no number —
can pause every run, or any run below a confidence threshold, and the approval
happens **in the group's chat**, by any member, in words. Nothing that leaves
the group is ever sent on a guessed approval.

**What it leaves behind.** Every run is recorded in the group's **audit** — one
document per month, kept twelve months, one line written before any effect so
that an effect never exists without a record — and an administrator can download
the whole retained trail as JSON before the oldest month is pruned. A failure
lands the message in `G-needattention` and tells the group's chat which automation
could not finish. Work is claimed per account with a lease, so a crashed agent's
work is taken up by the next one, and a run whose rule changed under it is
refused rather than executed.

**Every member sees it.** The group's chat carries an AI panel showing what the
agent is told and what it has done — the standing instruction, the policy its
runs are held to, each automation, and the recent audit — read through the
member's own session, and editable by nobody but an administrator of that
group.

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
- **gilbertagents** — the agents: the principal, the agent fleet, the
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

**The line.** One block and part of another came from **ihasmail**, Coffey Labs'
immutable webmail for Stalwart — the attribution, with its address, is in
[NOTICE](NOTICE). Everything else is Gilbert's, written here. That is the
whole of the upstream relationship, stated so a reader can tell which is which
without reading the tree:

- **From upstream**: the mail client — `gilbertmailer` — and inside
  `gilbertserver` the parts that serve it: sign-in and sessions, the JMAP
  forwarding, the image and calendar proxies, the rate limiting. Renamed for
  this build and changed here.
- **Gilbert's own**: the groups, the chat, the agent fleet, the administration,
  the settings policy, the app folder, and every Stalwart configuration
  surface. None of it exists upstream, and none of it is contributed back
  (ADR 0002). What this build adds on top of the client: the themes and the
  interface languages the top of this file lists, signature checking, the
  file-management work — cancelling an upload, remembering a sort per folder,
  dropping a folder with its structure — and a container that can run read-only.

Where this matters: an upstream release is a delta to the first list only, and
the merge that takes one in renames it before it lands. Everywhere else there
is nothing to merge.

## Architecture

```
browser  ──(same-origin /api/*)──►  Gilbert server (Node + Hono)  ──(JMAP over HTTPS)──►  Stalwart
  React SPA                           • session cookie ⇄ Basic auth
  JMAP client + stores                • /api/jmap, /api/blob, /api/upload, /api/events (SSE), /api/image
```

- `web/` — Vite + React 19 + TypeScript SPA. `src/jmap` (client, push, types), `src/store` (zustand: session, mail, compose, contacts, calendar, files, sieve, settings), `src/views`, `src/lib` (sanitiser, search parser, Sieve codec, locale-aware dates, vCard, …).
- `server/` — Node/Hono backend: authenticates against Stalwart's JMAP session endpoint, seals the credentials with a key derived from the cookie secret, proxies JMAP/blob/SSE, serves the SPA under a strict CSP. `src/mock/` is an in-memory fake Stalwart for development and demos. `src/agent/` is the fleet: the claim documents, the capability catalogue, the executor, the model client and the admin surfaces behind it.

Capabilities used: `core`, `mail`, `submission`, `vacationresponse`, `sieve`,
`contacts`(+`parse`), `calendars`(+`parse`), `principals`(+`availability`),
`quota`, `blob`, `filenode`, `webpush-vapid` and `emailpush` (Web Push),
EventSource push, plus Stalwart's own `urn:stalwart:jmap` (read-only). Features
degrade gracefully when one is missing.

## Development

Requirements: Node ≥ 24 on the **latest LTS line** — 24 is what the image and CI
pin, and a Current release is not supported — npm ≥ 10.

```bash
npm install

npm run dev            # real Stalwart (STALWART_URL in .env) — server :8080, Vite :5173
npm run dev:mock       # built-in mock Stalwart (demo@example.com / demo), mock on :8788
npm run dev:mock:agent # the same plus an agent process
npm run dev:mock:no-future-release   # mock that advertises FUTURERELEASE and drops every hold

npm run typecheck      # tsc for both packages
npm test               # vitest (web) + node:test (server)
npm run build          # web/dist + server/dist
npm start              # serve the production build

npm run prepush        # the fast gate: typecheck + Biome + the check scripts + tests
npm run codeql         # the code scanning analysis GitHub runs, on demand
npm run prepush:full   # the fast gate, then `codeql`
```

Open http://localhost:5173 in dev, or http://localhost:8080 for the production
build. Running it for real is [Quick start (Docker)](#quick-start-docker) above.

### Code scanning

Every push and pull request is analysed by GitHub's **code scanning**, on its
default setup — configured in the repository's settings, not by a workflow here
— with the JavaScript/TypeScript code-scanning suite. `npm run codeql` runs the
same analysis on this checkout, so a finding shows up before it is pushed:

```bash
npm run codeql
# → CodeQL: 0 result(s).
```

Its toolchain is a 686 MB bundle, which is why the fast gate does not carry it
(`npm run prepush:full` is the two together). Install it once, or point
`CODEQL_CLI` at an existing binary:

```bash
mkdir -p ~/.cache/gilbert/codeql
curl -L https://github.com/github/codeql-action/releases/latest/download/codeql-bundle-linux64.tar.gz \
  | tar xz -C ~/.cache/gilbert/codeql --strip-components=1
```

Run without a toolchain it **fails with those instructions** rather than
reporting a clean tree, and it analyses the files a push would carry —
`node_modules` and a built `web/dist` are not among them, because GitHub
analyses a checkout and not a working tree.

### The mock

An in-memory fake Stalwart 0.16 — enough JMAP to develop and demo against
without a real mailbox. It reproduces the things a naive fake would get wrong,
because each cost a live debugging session: `urn:stalwart:jmap` advertised
**per-account** rather than session-level, identity signatures capped at 2047
**bytes**, and `CalendarEvent/set` speaking Stalwart's vocabulary rather than
RFC 8984's. Four switches: `MOCK_NO_FUTURE_RELEASE=1` advertises FUTURERELEASE
and then drops every hold; `MOCK_NO_REGISTRY=1` omits the Stalwart capability so
the sign-in refusal can be tested; `MOCK_NO_SCHEDULING_SEND=1` refuses a
calendar write that asks for scheduling messages, the way an account without
that permission is refused; and `MOCK_NO_KEYWORD_SORT=1` serves a server that
does not implement sorting on keywords, so the fallback can be developed
against.

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
`package.json` sits at `0.0.0` because nothing reads a version from it.

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

The version says nothing about Stalwart, deliberately. A version that carried
the generation it targeted would have nowhere to go once Stalwart reaches 1.0:
`2.16.x` put `16` there for the 0.16 generation, and `2.1` sorts *below* the
`2.16` already deployed, so every image and About screen would read as a
downgrade. Which Stalwart a build needs is
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

## Where to read more

| | |
| --- | --- |
| 📋 **[FEATURES.md](FEATURES.md)** | Everything Gilbert does today, feature by feature, with the capability each one needs |
| 🧪 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)** | What was verified live, and where Stalwart departs from a spec |
| 🛣 **[ROADMAP.md](ROADMAP.md)** | What Gilbert does not do yet, and why |
| 🏛 **[docs/adr](docs/adr/README.md)** | The architecture decisions behind all of it, one file each |

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
Settings › About both show it.
