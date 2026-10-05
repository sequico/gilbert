# Installing and running Gilbert

This is the whole of installing, configuring and operating Gilbert: with Docker
or straight on a host, the reverse proxy in front, the installation document,
the settings policy and the release routine.

What the application does is [FEATURES.md](FEATURES.md); the decisions behind it
are in [docs/adr](docs/adr/README.md); every environment name, with a note on
each, is [.env.example](.env.example); the host installer's own story is in
[`install/install.sh`](install/install.sh); the release procedure is
[docs/releasing.md](docs/releasing.md).

## Before you start

- **A Stalwart 0.16 server or newer**, and an account for the installation — the
  **Master** (`gilbert@…`) — with its own password, added to the groups it
  should work in. Creating it and turning the agents on is *Turning the agents
  on* below.
- **A TLS reverse proxy** in front of the app:
  [Caddyfile.example](Caddyfile.example) or
  [nginx.example.conf](nginx.example.conf).
- **Node 24 (the latest LTS line)** for a host install; the container image
  carries its own.

## The environment

A first install sets **three** names. The complete list, with a note on each, is
[.env.example](.env.example) — it is the reference, not repeated here.

| Name | What to put |
| --- | --- |
| `STALWART_URL` | `https://` base URL of your Stalwart (scheme + host, no path). |
| `GILBERT_AGENT_ADDRESS` | The Master's address (`gilbert@example.com`). |
| `GILBERT_AGENT_PASSWORD` | That account's own password — not an app password. |

The environment carries four classes of value: **the handshake** (the three
above, plus `STALWART_FOLLOW_ADVERTISED_URLS` for a proxy that rewrites the
host); **the container's own facts** (`HOST`, `PORT`, `IMMUTABLE`); **the
image's facts** (`STATIC_DIR`, `SOURCE_URL`, `GILBERT_ADMIN_PERMISSION`,
`GILBERT_VERSION`, `NODE_ENV`); and **the operator's own statement**
(`GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER`: whether this deployment may point the
installation's model at an address inside its own network — it is read from the
environment and nowhere else, because an installation must not grant itself that
right). A production process that states no `BASE_PATH` prefix refuses to serve.

Everything else the *installation* decides (its name, proxy posture, rate
limits, push mode, session lifetimes, the fleet's timers and bounds) is a field
of the installation document in Stalwart, edited after the first boot at
**Administration → Installation**.

## Docker

```bash
git clone https://github.com/sequico/gilbert && cd gilbert
cp .env.example .env      # set the three names above
docker compose up --build -d
# → http://localhost:8080  (Caddy/nginx in front for TLS)
```

The compose binds the app to loopback behind the host's reverse proxy.

## Host (no Docker)

```bash
git clone https://github.com/sequico/gilbert && cd gilbert
sudo ./install/install.sh      # builds the app and installs the service
sudoedit /etc/gilbert.env      # set the three names above
sudo systemctl restart gilbert # the script starts it if the URL was already set
```

The script builds the application and installs `gilbert.service`. A host that
already runs its own `gilbert.service` keeps it: the installer writes only the
hardening drop-in beside it (`gilbert.service.d/10-hardening.conf`), so the unit
is yours and the posture is Gilbert's. Its header has the whole of it.

## The reverse proxy

The application listens on `127.0.0.1:8080`; put a TLS reverse proxy in front
([Caddyfile.example](Caddyfile.example) or
[nginx.example.conf](nginx.example.conf)) and it is ready.

## Turning the agents on

> **Not functional yet.** The agent part is designed and present in the tree but
> does not work, and a refactor is planned — see
> [KNOWN-ISSUES.md](KNOWN-ISSUES.md). The steps below are how it is meant to be
> turned on.

An agent is a Stalwart account, and its grant is group membership — there is no
second switch in the product. The whole of it is:

1. In **Stalwart's own administration**, create an account for the agent
   (`gilbert@example.com`) and **add it to the groups it should work in**.
2. Give the deployment that account's **own password** — not an app password:
   the agent signs in as itself — in `GILBERT_AGENT_ADDRESS` and
   `GILBERT_AGENT_PASSWORD`.
3. Start Gilbert. The server runs an agent beside the web tier in its own
   process (ADR 0003); a deployment that wants the fleet apart runs
   `node server/dist/agent/agent.js` instead, with `agent.inProcess` false in the
   installation document.

**Administration → Master** then shows the groups the agent can see and holds the
rules that apply in every one of them; **Group Agents** is where each group's
automations are written, beside its standing instruction and review policy. A
group the agent belongs to that has never heard from it gets one message
(*"Hi all! Gilbert here, at your service."*) when the agent takes the group up,
which is the proof it is working there. Users sign in with their Stalwart
mailbox credentials; **an account with two-factor authentication needs an app
password**, because Stalwart accepts a TOTP code only through an OAuth flow and
offers no password grant.

## Container images

Gilbert images are published to GHCR on every release (cut by hand), for
`linux/amd64` and `linux/arm64`:

```bash
docker pull ghcr.io/sequico/gilbert:latest
```

The checked-in `docker-compose.yml` builds the checkout itself; to run a
published release instead, point the `gilbert` service at
`ghcr.io/sequico/gilbert`.

| Tag | What it is |
| --- | --- |
| `latest` | The newest release. Prereleases never move it |
| `v2026.9.6-g8ae88bb` | One specific build — the [version](#version-numbers) with `+` written as `-`, because a Docker tag may not contain `+` |

Pin the dated tag in anything you care about: `latest` is a moving target, and
rolling back to a named tag is a `docker run` rather than a rebuild. Building it
yourself stays supported (`docker compose up --build`); pass the version in,
because `.dockerignore` excludes `.git` and the build cannot work it out:

```bash
docker build --build-arg GILBERT_VERSION="$(node scripts/version.mjs)" -t gilbert:local .
```

## Running immutably

The server keeps **no writable state of its own**: sessions, settings, the
installation's configuration and every document a feature owns live in Stalwart,
in the accounts they belong to. There is no path to clear, so the container can
run with no writable filesystem at all:

```bash
docker run --read-only --tmpfs /tmp -e IMMUTABLE=1 ...
```

`IMMUTABLE=1` is an assertion the server checks at startup rather than a switch
that changes what it does: it probes the filesystem and refuses to boot when
that filesystem turns out to be writable — the flag without the fact. Sessions
are in that set like everything else, so a redeploy does not sign anybody out
and the mode costs nothing to keep on. The image ships no `VOLUME`; an anonymous
mount stays writable under `--read-only`, so both the container's
`ReadonlyRootfs` and its `.Mounts` are checked.

## The installation's own configuration

The installation's configuration is **one document in Stalwart**:
`installation.json` in the Master account's own `gilbert` app folder. A boot
signs in as the Master, reads that document whole and runs on it; the first boot
writes it — the defaults and a freshly generated app secret — and
**Administration → Installation** edits it from then on. Nothing about it is on
the container, so a redeploy reads back exactly what the last edit wrote, and a
publish is in force from the **next boot**: the running process keeps the
configuration it booted with.

**`BASE_PATH` is the image's fact, one value in two places.** The build argument
bakes the prefix into the web bundle's asset URLs, and `BASE_PATH` in the running
container tells the server which prefix to serve (`""` is the domain root). It is
deliberately **not** in the installation document: a document that could move it
could disagree with the bundle, and the symptom is a blank page. `assertServable`
refuses two configurations no production process may serve on — one that states
no prefix at all, and one whose app secret is ephemeral, minted because nothing
stated one.

The document's `secret` is the key every stored session is sealed with. It is
**generated on the first boot** and written into the document, because a secret
the container holds is a secret a redeploy loses. `APP_SECRET` is what a process
with no boot runs on (a test, a tool, a development server started without a
sign-in), and the document decides for a booted one, so rotating `APP_SECRET`
signs nobody out. `appSecretSource` travels with the configuration and says which
of the three it was.

### Several Stalwart servers

One Gilbert can front more than one Stalwart, choosing by the domain somebody
signs in with. The installation document says which: its `upstreams` section,
published from **Administration → Installation** like everything else.
**`STALWART_URL` stays the default**, so an installation that says nothing here
behaves as it always has.

```json
{
  "upstreams": {
    "example.com": "https://mail.example.com",
    "customer-b.test": "https://jmap.customer-b.test"
  }
}
```

A domain nobody listed — and a bare username, which has no domain at all — goes
to `STALWART_URL`. **A listed domain never falls back**: if its server is
unreachable that sign-in fails rather than retrying against the default, because
falling back would authenticate somebody against a server their domain was
deliberately routed away from. Read once at startup, so editing it means
restarting the container; malformed JSON, a duplicate domain once lower-cased, or
a value that is not an `http(s)` URL stops the server rather than failing quietly
at somebody's sign-in. The servers are not contacted at boot — a mapping is a
routing table, not a health check, and one customer's outage must not stop
Gilbert starting for everybody else.

This is one server per *person*, chosen at sign-in. Several servers at once for
one person, with unified or cross-account views, is not supported: JMAP account
ids are only unique within a server. Reading somebody else's mail, calendars or
files on the *same* server works through JMAP sharing.

## Settings the installation decides

An installation decides and locks user settings — what a school wanting "warn
about outside senders" on for three thousand pupils needs. It says so in a
document, published from **Administration → Installation policy**. Nothing about
it is passed in the environment and nothing is mounted: the policy lives in
Stalwart, in each account it applies to.

Three powers, and the differences between them matter:

| Section | Applies to | Reader can change it |
| --- | --- | --- |
| `defaults` | accounts that have never had settings of their own | yes, at any time |
| `enforced` | everyone, on every load | no — the control goes dead |
| `changes` | everyone, **once each**, including existing accounts | yes, afterwards, and it stays changed |

`changes` turns something on for people who are *already there* — the reason a
plain default is not enough — while still leaving them the last word. Each entry
carries its own `version`, which every account remembers once it has had it, so
the change is applied exactly once per person and a reader who turns it back off
keeps it off. It is a schema migration in shape (upstream's issue #207). Nothing
is configured by default: an installation that sets none of these behaves as
Gilbert always has.

### Publishing a policy (ADR 0001)

The live policy is not a file or a variable: **Administration → Installation
policy** publishes it into every individual account's own Stalwart storage, by
impersonation, the same way an administrator sets a person's default identity.
There is nothing to mount, publishing works identically under `IMMUTABLE=1`, and
a redeploy or a second replica reads exactly what the last publish wrote.

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

[`settings-policy.example.json`](settings-policy.example.json) is that document
with every section explained — paste it into the editor and delete what you do
not want.

Publishing applies at once: every account the directory lists gets the document
written into its own app folder (impersonated), the publishing administrator's
account included, and every other signed-in session is kicked so its next
sign-in reads the new policy (ADR 0001). One account's refusal — no impersonation
grant, an unreachable session, an account with no Files to hold it — does not
stop the rest.

**The publish is a job with an id** (ADR 0010). One id is minted before the first
copy goes out, and every copy written carries it as `published: { id, at }`
beside the policy, so any account an administrator opens says which publish
reached it. The job itself is one document, `gilbert/publish-job.json` in the
publishing administrator's own app folder, holding the id, when the publish
started, who published, the population the directory reported, the accounts the
policy reached, the ones it did not with a code for each
(`impersonation-refused`, `no-files-account`, `write-failed`, `policy-moved`,
`directory-denied`) and whether the installation can be said to carry the policy.
It lives in the account rather than the process, so the surface reads the same
answer back after a restart. A publish that could not store its own record says
`record: "failed"`.

**Every per-account write is conditional**, against the state of the account it
lands in, so a copy that would replace one somebody else just wrote is refused
(`policy-moved`). No publish claims more than it reached: it counts as complete
only when the directory it read *was* the whole directory and every account the
directory listed received the policy. An account no publish has reached reads the
built-in defaults. There is no environment variable for this: an installation
states its policy in the editor, or it states none.

### Writing a policy

Both sections take the same names and values a settings export uses, so
`Settings → General → Export` on one account configured by hand is the quickest
way to write one. Checks worth knowing, because they fail loudly rather than
quietly:

- **Malformed JSON is refused at publish time (400, nothing changes).**
- **Every change needs a unique `version`.** Two changes sharing one, or a change
  with no `version` or no `settings`, is refused.
- **Keys this build does not have are dropped**, the same rule an imported
  settings file gets. A `changes` entry whose keys are *all* unknown is dropped
  whole rather than recorded as applied.

Enforcement is applied in the settings store rather than only on the controls, so
an imported settings file, a settings file synced from a device that predates the
policy, and "reset to defaults" cannot get around it. Reset returns to your
defaults, not to Gilbert's.

## Rebranding

`branding.appName` (environment `APP_NAME`) sets the installation's name;
`SOURCE_URL` points at your source for the AGPL offer; the logo, icons and
palette are files (`web/public/img/logo.png`, `logo-inverse.png`, `mark.png`,
`mark-inverse.png`).

## Live updates

Live updates reach a tab by one of two transports, and both carry the same types,
so which one a deployment is on does not decide which parts of the app update.

By default Gilbert holds one Server-Sent Events stream per tab, upstream to
Stalwart and back — no configuration, and what a tab falls back to. It then
registers one subscription per account with Stalwart and fans its change
notifications out to that account's open tabs, holding **no upstream connection
per tab**, so a reconnect is local and a deployment's open-connection count stops
tracking its open tabs.

There is no address to configure: the origin Stalwart POSTs back to is taken from
the request itself, and only when that request is believable — it arrived over
https (RFC 8620 requires the scheme) from a proxy Gilbert runs, that is
`server.trustProxy` is on and the peer is inside `server.trustedProxies`. A
Gilbert reached directly, or over plain http, keeps the per-tab relay (nothing is
lost, reconnecting is simply not local). `GET /api/health` says what happened:
`push.accounts` counts the verified, pending and failed subscriptions, and
`push.tabs` splits the open tabs into `fanout` and `relay`. `push.mode` set to
`relay` in the installation document keeps the per-tab stream and never
subscribes.

## Version numbers

`Gilbert v2026.8.30+pr129` — the date of the commit this was built from, and the
pull request that commit arrived through. A commit that did not arrive through
one carries its short SHA instead: `2026.8.30+g1fa6578`. It all comes from git at
build time; nothing writes a version into the tree, and `package.json` sits at
`0.0.0` because nothing reads a version from it. The date is the commit's own, so
rebuilding an old commit gives the version it had the first time.

```bash
node scripts/version.mjs        # the version for the current checkout
docker build --build-arg GILBERT_VERSION="$(node scripts/version.mjs)" -t gilbert:2026.8.30 .
```

`.dockerignore` excludes `.git` deliberately, so an image build cannot work this
out for itself — pass it in. Left out, the build reports `0.0.0`, which is meant
to look wrong. The version says nothing about Stalwart, deliberately: which
Stalwart a build needs is stated in the badge at the top of the README and in
[KNOWN-ISSUES.md](KNOWN-ISSUES.md).

## Updating and deploying

Both ways carry the whole product:

- **Docker**: `docker compose up --build -d`, or
  [`deploy.example.sh`](deploy.example.sh), a single-host redeploy that refuses
  anything held back by `.deploy-hold`, asks before shipping new commits, and
  keeps the newest `GILBERT_KEEP_VERSIONS` images — never the one running.
- **Host, no Docker**: `sudo ./install/install.sh` on the new checkout.
