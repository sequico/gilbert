#!/bin/bash
# Install Gilbert on a host, without Docker: the application, and the phone's
# bridge beside it (ADR 0023).
#
# WHAT THIS INSTALLS, AND WHY THERE ARE TWO SERVICES
#
# Gilbert is a Node process. The phone cannot be one: a browser cannot speak
# SIP, so telephony runs through Janus — a separate daemon ([Janus], a WebRTC
# server, with its SIP plugin) that translates between the page's WebRTC and
# the provider's SIP. Janus is a second process, started and stopped with the
# application, and this script installs both as systemd services
# (`gilbert-janus.service` and `gilbert.service`). It is part of the release,
# not something an installer builds by hand.
#
# [Janus]: https://github.com/meetecho/janus-gateway
#
# THE BRIDGE IS FETCHED, NOT COMPILED. The release publishes a host tarball of
# the bridge, built once by CI from the pinned Janus (deploy/janus/VERSION), for
# amd64 and arm64. This script downloads the latest one, checks its checksum and
# unpacks it — no compiler, no build dependencies. It carries Janus alone, not
# the system libraries Janus links; those are installed here, as the image
# installs them, and the bridge is refused if any is still missing (that is the
# `ExecMainStatus=127` a bare tarball gives). If it cannot be fetched, the
# install does NOT stop: Gilbert is installed without the phone, with a loud
# warning here and a warning in the administration surface, both saying the
# phone is unavailable and why. The phone's absence is a degraded feature, not
# a broken installation. `GILBERT_BRIDGE=0` skips the attempt entirely: nothing
# is fetched, no `gilbert-janus.service` is installed, no port is opened —
# a deliberate choice, not a workaround.
#
# IT LAYERS OVER YOUR UNIT. If the host already runs its own `gilbert.service`,
# that unit stays: its ExecStart, its User, its paths. This script writes only
# the hardening drop-in beside it (`gilbert.service.d/10-hardening.conf`), so the
# posture is ours and the unit is yours. A host with no unit gets ours too.
#
# THE PORTS — THE ONE THING THE FIREWALL NEEDS
#
# When the bridge is installed, it has two legs:
#
#   the page <-> Janus leg:  WebRTC media over UDP, plus the Janus API on
#                            loopback (127.0.0.1:8188) that only gilbertserver
#                            reaches. The API is never exposed.
#   the Janus <-> provider leg: SIP and RTP, OUTBOUND only. The provider answers
#                            on the connection the registration opened, so no
#                            SIP port (5060/5061) is ever opened.
#
# So the only thing to open inbound is the bridge's media range, UDP 10000-10200
# (the range in `server/src/shared/phone.ts`, shown in the administration too).
# On ufw:
#
#   ufw allow 10000:10200/udp
#
# and, if the host sees the range through a cloud firewall or a security group,
# the same rule there.
#
# If those ports are not open, NOTHING BREAKS LOUDLY: the phone simply does not
# appear. The client proves the media path before it offers itself, so a
# deployment whose range is closed shows no phone at all rather than an entry
# that fails on the first call. That is the signal to go and open the range.
#
# WHAT THIS DOES NOT DO
#
# It does not install Node (Gilbert needs the LTS line, 24 today; the bridge
# tarball carries Janus and this script installs the libraries Janus links, so
# no compiler is needed) and it does not put a reverse proxy in front: both are
# stated in INSTALL.md. It targets Linux.
#
# Usage, as root (or with sudo):
#
#   sudo ./install/install.sh
#
# Set GILBERT_APP to the checkout if this script is run from elsewhere,
# GILBERT_USER to the account the services run as (default: the user who invoked
# sudo, else `gilbert`), and GILBERT_RELEASE_URL to fetch the bridge from a
# mirror. GILBERT_ENV, GILBERT_JANUS_PREFIX and GILBERT_UNIT_DIR move the
# environment file, the bridge prefix and the unit directory; the variables
# below say what each is for.
set -euo pipefail

# --- what to install, and where ---------------------------------------------
APP="${GILBERT_APP:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}"
# The account the services run as. Prefer the user who invoked sudo (they own
# the checkout); fall back to a system account this script creates if needed.
USER_NAME="${GILBERT_USER:-${SUDO_USER:-gilbert}}"
# The environment file the application reads at boot: the handshake (the
# Stalwart URL, and the Master when this deployment runs an agent) and anything
# else this deployment states. See `.env.example`.
ENV_FILE="${GILBERT_ENV:-/etc/gilbert.env}"
# Where the bridge is installed. `/usr/local` so the `janus` binary and its
# config land on the usual paths.
PREFIX="${GILBERT_JANUS_PREFIX:-/usr/local}"
# The bridge's config, beside Janus's own.
JANUS_ETC="$PREFIX/etc/janus"
UNIT_DIR="${GILBERT_UNIT_DIR:-/etc/systemd/system}"
# Where the bridge's host tarball is published. The latest release's assets are
# addressable by fixed name, so no API and no tag arithmetic are needed.
RELEASE="${GILBERT_RELEASE_URL:-https://github.com/sequico/gilbert/releases/latest/download}"

say() { printf '==> %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (or with sudo)."
command -v node >/dev/null || die "Node is not installed. Gilbert needs the LTS line (24); install it first (see INSTALL.md)."
command -v npm >/dev/null || die "npm is not installed."
[ -f "$APP/package.json" ] || die "$APP is not a Gilbert checkout (no package.json)."

# --- the application ---------------------------------------------------------
# Built as root, the path the image builds by; `--ignore-scripts` keeps
# dependency install scripts out of it. The service runs unprivileged, and the
# outputs are handed to it below.
say "building Gilbert"
( cd "$APP" && npm ci --ignore-scripts && npm run build )

# --- the service account -----------------------------------------------------
if ! id "$USER_NAME" >/dev/null 2>&1; then
  say "creating the service account $USER_NAME"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME" \
    || warn "could not create $USER_NAME; the services may refuse to start"
fi
# The app only reads these; root's build outputs are world-readable anyway, but
# handing them over keeps a write from ever needing a privilege.
chown -R "$USER_NAME" "$APP/node_modules" "$APP/web/dist" "$APP/server/dist" \
  2>/dev/null || true

# --- the bridge (best effort, fetched from the release) ----------------------
BRIDGE_OK=0
BRIDGE_REASON="the bridge is not installed"
if [ "${GILBERT_BRIDGE:-1}" != "1" ]; then
  BRIDGE_REASON="the bridge is disabled (GILBERT_BRIDGE=0)"
else
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64 | amd64) ARCH=amd64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) ARCH="" ;;
  esac
  if [ -z "$ARCH" ]; then
    BRIDGE_REASON="this machine's architecture ($(uname -m)) has no bridge build"
  else
    asset="gilbert-janus-linux-$ARCH.tar.gz"
    say "fetching the phone's bridge ($asset)"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    if curl -fsSL "$RELEASE/$asset" -o "$tmp/$asset" \
      && curl -fsSL "$RELEASE/$asset.sha256" -o "$tmp/$asset.sha256" \
      && ( cd "$tmp" && sha256sum -c "$asset.sha256" >/dev/null 2>&1 ) \
      && tar xzf "$tmp/$asset" -C "$PREFIX"; then
      BRIDGE_OK=1
    else
      BRIDGE_REASON="the bridge could not be fetched from $RELEASE"
    fi
  fi
fi

# Verify what was unpacked: a binary with no plugins is not a working bridge.
if [ "$BRIDGE_OK" = "1" ] \
   && { [ ! -x "$PREFIX/bin/janus" ] \
        || [ ! -e "$PREFIX/lib/janus/plugins/libjanus_sip.so" ] \
        || [ ! -e "$PREFIX/lib/janus/plugins/libjanus_echotest.so" ] \
        || [ ! -e "$PREFIX/lib/janus/transports/libjanus_websockets.so" ]; }; then
  BRIDGE_OK=0
  BRIDGE_REASON="the downloaded bridge is missing its sip, echotest or websockets pieces"
fi

# The libraries Janus links are the host's, not the tarball's: install them the
# way the image does, then refuse a bridge the linker cannot resolve — that is
# the difference between a service that runs and `ExecMainStatus=127`.
if [ "$BRIDGE_OK" = "1" ]; then
  # One package at a time: a name this distribution does not have must not stop
  # the others from installing — apt installs nothing at all when one name is
  # unknown. Whatever is still missing after this is named by the ldd check.
  if command -v apt-get >/dev/null 2>&1; then
    for pkg in libglib2.0-0 libjansson4 libconfig9 libssl3 libsrtp2-1 libnice10 \
               libcurl4 libsofia-sip-ua0 libopus0 libogg0 libwebsockets17; do
      apt-get install -y --no-install-recommends "$pkg" >/dev/null 2>&1 || true
    done
  fi
  missing="$(
    {
      ldd "$PREFIX/bin/janus"
      for so in "$PREFIX"/lib/janus/plugins/*.so "$PREFIX"/lib/janus/transports/*.so; do
        [ -e "$so" ] && ldd "$so"
      done
    } 2>/dev/null | grep 'not found' | awk '{print $1}' | sort -u | tr '\n' ' '
  )"
  if [ -n "$missing" ]; then
    BRIDGE_OK=0
    BRIDGE_REASON="the bridge needs libraries this host does not have: $missing"
  fi
fi

# --- the bridge's configuration and service ----------------------------------
if [ "$BRIDGE_OK" = "1" ]; then
  say "writing $JANUS_ETC"
  mkdir -p "$JANUS_ETC"
  # The media range is generated from its one definition, so the ports an
  # operator opens and the ports Janus binds cannot drift apart; the prefix
  # keeps the plugin folders findable wherever the tarball unpacked.
  node "$APP/scripts/janusConfig.mjs" "$JANUS_ETC/janus.jcfg" "$PREFIX"
  cp "$APP/deploy/janus/janus.transport.websockets.jcfg" \
     "$APP/deploy/janus/janus.plugin.sip.jcfg" \
     "$APP/deploy/janus/janus.plugin.echotest.jcfg" \
     "$JANUS_ETC/"
fi

# --- the services ------------------------------------------------------------
say "installing systemd services ($UNIT_DIR)"
install -d "$UNIT_DIR"
sed_args=(-e "s#@USER@#${USER_NAME}#g" -e "s#@APP@#${APP}#g"
          -e "s#@ENV@#${ENV_FILE}#g" -e "s#@NODE@#$(command -v node)#g")
# The unit is the deployment's: one already there keeps its ExecStart, its User
# and its paths, and gets only the hardening drop-in. A host with none gets ours
# too, so a fresh install is one command.
if [ ! -f "$UNIT_DIR/gilbert.service" ]; then
  sed "${sed_args[@]}" "$APP/install/gilbert.service" > "$UNIT_DIR/gilbert.service"
fi
install -d "$UNIT_DIR/gilbert.service.d"
cp "$APP/install/gilbert-hardening.conf" \
  "$UNIT_DIR/gilbert.service.d/10-hardening.conf"
if [ "$BRIDGE_OK" = "1" ]; then
  sed "${sed_args[@]}" "$APP/install/gilbert-janus.service" \
    > "$UNIT_DIR/gilbert-janus.service"
fi
systemctl daemon-reload

if [ "$BRIDGE_OK" = "1" ]; then
  systemctl enable --now gilbert-janus.service
  say "the bridge is installed and running ($(cat "$PREFIX/share/janus/VERSION" 2>/dev/null || echo "unknown version"))"
else
  warn "the phone is NOT available on this host: $BRIDGE_REASON."
  warn "Gilbert is installed without it; the administration says the same."
fi

# --- the environment file, and starting the application ----------------------
if [ ! -f "$ENV_FILE" ]; then
  say "creating $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# Gilbert's environment: the handshake and this deployment's own facts.
# See the checkout's .env.example for what each name is for. Fill this in,
# then: systemctl restart gilbert
STALWART_URL=
GILBERT_AGENT_ADDRESS=
GILBERT_AGENT_PASSWORD=
EOF
  chmod 600 "$ENV_FILE"
fi
systemctl enable gilbert.service

if grep -qE '^[[:space:]]*STALWART_URL=.+' "$ENV_FILE"; then
  systemctl restart gilbert.service
else
  warn "$ENV_FILE has no STALWART_URL yet: gilbert.service is enabled but not"
  warn "started. Fill the file in, then: systemctl start gilbert.service"
fi

# --- what is left for the operator -------------------------------------------
cat <<EOF

==> installed.

  the application   systemctl status gilbert.service
  the environment   $ENV_FILE
$( [ "$BRIDGE_OK" = "1" ] && echo "  the bridge        systemctl status gilbert-janus.service" || echo "  the bridge        NOT installed ($BRIDGE_REASON)" )

Two things are the operator's, and INSTALL.md covers both:

  1. a reverse proxy in front of the application (see Caddyfile.example /
     nginx.example.conf). The application listens on 127.0.0.1:8080 by default.

  2. THE PHONE'S MEDIA PORTS, if the bridge was installed. Open its UDP range
     inbound, and open it in any cloud firewall too:

         ufw allow 10000:10200/udp

     Nothing else is opened: the Janus API is loopback-only, and the SIP leg to
     the provider is outbound, so 5060/5061 stay closed.

     If the range is closed, the phone does not appear at all — that is the
     design, not a failure: the client proves the media path before offering
     the phone.

EOF
