# Installing Gilbert

This is the whole of installing Gilbert, both ways: with Docker, or straight on a
host.

What lives where: what the application does is [FEATURES.md](FEATURES.md); the
decisions behind it are in [docs/adr](docs/adr/README.md); every environment
name, with a note on each, is [.env.example](.env.example); the host installer's
own story is in [`install/install.sh`](install/install.sh). This document is the
walk-through; the others are the reference.

## Before you start

- **A Stalwart 0.16 server**, and an account for the installation — the
  **Master** (`gilbert@…`) — with its own password, added to the groups it should
  work in. Creating it and turning the agents on is [README.md](README.md),
  *Turning the agents on*; it is not repeated here.
- **A TLS reverse proxy** in front of the app: [Caddyfile.example](Caddyfile.example)
  or [nginx.example.conf](nginx.example.conf).
- **Node 24 (the LTS line)** for the host install; the container image carries
  its own.

## The environment

A first install sets **three** names; everything else has a default or is
decided in Stalwart. The complete list, with a note on each, is
[.env.example](.env.example) — it is the reference, not repeated here.

| Name | What to put |
| --- | --- |
| `STALWART_URL` | `https://` base URL of your Stalwart (scheme + host, no path). |
| `GILBERT_AGENT_ADDRESS` | The Master's address (`gilbert@example.com`). |
| `GILBERT_AGENT_PASSWORD` | That account's own password — not an app password. |

Anything the *deployment* states beyond these — where it binds, its prefix — is
in `.env.example` too. The host installer's own switches are documented in its
header, and `deploy.example.sh`'s in its own.

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

The compose binds the app to loopback behind the host's reverse proxy. To run a
published release instead of building, point the `gilbert` service at
`ghcr.io/sequico/gilbert`.

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
([Caddyfile.example](Caddyfile.example) or [nginx.example.conf](nginx.example.conf))
and it is ready.

## Updating

The routine is in [AGENTS.md](AGENTS.md); a host install is re-running
`sudo ./install/install.sh` on the new checkout.

## Licence

AGPL-3.0-or-later, with the mail core's attribution and the source offer, in
[NOTICE](NOTICE).
