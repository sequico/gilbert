# Installing Gilbert

Gilbert is the application; the phone's bridge comes with it. This is the whole
of installing it — both ways, with or without the phone.

What lives where: the application by feature is [FEATURES.md](FEATURES.md); the
decisions behind it are in [docs/adr](docs/adr/README.md); every environment
name, with a note on each, is [.env.example](.env.example); the bridge's own
story next to the code is in [`install/install.sh`](install/install.sh) (host)
and [`deploy/`](deploy/janus) (the image). This document is the walk-through; the
others are the reference.

"the bridge" below is **Janus** with its SIP plugin (ADR 0023): a second process
beside the application that turns the browser's WebRTC into the SIP your provider
speaks. It is part of the release, and you do not install it by hand.

## Before you start

- **A Stalwart 0.16 server**, and an account for the installation — the
  **Master** (`gilbert@…`) — with its own password, added to the groups it should
  work in. Creating it and turning the agents on is [README.md](README.md),
  *Turning the agents on*; it is not repeated here.
- **A TLS reverse proxy** in front of the app: [Caddyfile.example](Caddyfile.example)
  or [nginx.example.conf](nginx.example.conf).
- **Node 24 (the LTS line)** for the host install; the container image carries
  its own.
- For the **phone**, a SIP account per person — a server, a user name and a
  password — which an administrator sets inside the app. Without it, that person
  has no phone. See [FEATURES.md](FEATURES.md).

## The environment

A first install sets **three** names; everything else has a default or is
decided in Stalwart. The complete list, with a note on each, is
[.env.example](.env.example) — it is the reference, not repeated here.

| Name | What to put |
| --- | --- |
| `STALWART_URL` | `https://` base URL of your Stalwart (scheme + host, no path). |
| `GILBERT_AGENT_ADDRESS` | The Master's address (`gilbert@example.com`). |
| `GILBERT_AGENT_PASSWORD` | That account's own password — not an app password. |

Anything the *deployment* states beyond these — where it binds, its prefix,
whether it starts the bridge — is in `.env.example` too. The host installer's
own switches are documented in its header, and `deploy.example.sh`'s in its own.

Everything **the installation** decides (its name, proxy posture, rate limits,
push mode, the agent's timers) lives in Stalwart's installation document, edited
after the first boot at *Administration → Installation* — see [README.md](README.md).

## Docker

```bash
git clone https://github.com/sequico/gilbert && cd gilbert
cp .env.example .env      # set the three names above
docker compose up --build -d
# → http://localhost:8080  (Caddy/nginx in front for TLS)
```

The image builds the bridge into itself; the compose runs it with host
networking so the bridge is reachable at the host's public IP. To run a published
release instead of building, point the `gilbert` service at
`ghcr.io/sequico/gilbert`.

## Host (no Docker)

```bash
git clone https://github.com/sequico/gilbert && cd gilbert
sudo ./install/install.sh      # builds the app; fetches the bridge
sudoedit /etc/gilbert.env      # set the three names above
sudo systemctl restart gilbert # the script starts it if the URL was already set
```

The script builds the application, fetches the bridge from the release (it
unpacks Janus, and installs the shared libraries Janus links — the same ones the
container image installs), and installs `gilbert-janus.service` and
`gilbert.service`. A host that already runs its own `gilbert.service` keeps it:
the installer writes only the hardening drop-in beside it
(`gilbert.service.d/10-hardening.conf`), so the unit is yours and the posture is
Gilbert's. If the libraries cannot be satisfied, it refuses the bridge and
Gilbert runs without the phone, saying so. Its header has the whole of it.

`GILBERT_BRIDGE=0` installs Gilbert **without the phone**: nothing is fetched, no
bridge service, no port to open — a deliberate choice, not a workaround.

## The one port

The bridge has two legs: **page ↔ Janus** (WebRTC media over UDP, plus the Janus
API on loopback, never exposed) and **Janus ↔ provider** (SIP and RTP,
**outbound only** — no SIP port is ever opened). So the only thing to open
inbound is the bridge's media range, **UDP 10000-10200** (the value in
`server/src/shared/phone.ts`, also shown under *Identities and SIP Phone*):

```bash
ufw allow 10000:10200/udp     # and the same in any cloud firewall
```

## With or without the phone

- **With the phone.** Open the media range above and set each person's SIP
  account in *Identities and SIP Phone*. The bridge starts with the app.
- **Without it, on purpose.** Set `GILBERT_BRIDGE=0` (the agent worker container
  does), or simply leave the range closed. The app runs fully and offers no
  phone.
- **Without it, because it could not be had.** On a host install, if the bridge
  cannot be fetched — no release yet, no network, an architecture without a
  build — the script **warns, installs Gilbert without the phone**, and the
  administration says the same. Point `GILBERT_RELEASE_URL` at a mirror to fetch
  it from elsewhere.

**A closed range does not break loudly: the phone simply does not appear.** The
client proves the media path against the bridge before offering itself, so a
deployment whose range is shut shows no phone rather than an entry that fails on
the first call.

## When the phone is not there

- **The administration warns "the bridge is not running".** The host install
  could not fetch it (no release, or `GILBERT_RELEASE_URL` unreachable). Install
  it from a release, then `sudo systemctl restart gilbert-janus.service`.
- **The bridge runs, but no phone appears.** Almost always the media range: open
  UDP 10000-10200 inbound and in the cloud firewall, then reload. The client's
  probe is what decides.
- **`gilbert-janus.service` is `activating`/failed with `ExecMainStatus=127`.**
  The linker cannot find a library Janus links. Re-run the installer (it installs
  them), or install them by hand —
  `apt-get install libconfig9 libnice10 libsrtp2-1 libjansson4 libwebsockets17 libsofia-sip-ua0 libopus0 libogg0 libglib2.0-0 libssl3 libcurl4`
  — then `sudo systemctl restart gilbert-janus.service`.
- **No phone for one person only.** That identity has no SIP account yet.
- **It rings but there is no audio.** The leg to the provider: check the SIP
  account, and that the provider is reachable from the host over SIP (outbound).
- **`gilbert.service` is enabled but stopped.** `/etc/gilbert.env` has no
  `STALWART_URL`; set it and `sudo systemctl start gilbert.service`.

## Updating the bridge

Janus is ours to update, pinned in [`deploy/janus/VERSION`](deploy/janus/VERSION);
`node scripts/janusVersion.mjs` says whether we are behind. The rest of the
update routine is in [AGENTS.md](AGENTS.md).

## Licence

AGPL-3.0-or-later, with the mail core's and Janus's attribution and the source
offer, in [NOTICE](NOTICE).
