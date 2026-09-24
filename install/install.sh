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
# application: this script builds it from the pinned release and installs both
# as systemd services (`gilbert-janus.service` and `gilbert.service`). It is
# part of the release, not something an installer goes and gets by hand, and
# its version is ours to bump (`deploy/janus/VERSION`).
#
# [Janus]: https://github.com/meetecho/janus-gateway
#
# THE PORTS — READ THIS, IT IS THE ONE THING THAT NEEDS THE FIREWALL
#
# The bridge has two legs:
#
#   the page <-> Janus leg:  WebRTC media over UDP, plus the Janus API on
#                            loopback (127.0.0.1:8188) that only gilbertserver
#                            reaches. The API is never exposed.
#   the Janus <-> provider leg: SIP and RTP, OUTBOUND only. The provider answers
#                            on the connection the registration opened, so no
#                            SIP port (5060/5061) is ever opened.
#
# So the only thing to open inbound is the bridge's media range, UDP 10000-10200
# (it is the range in `server/src/shared/phone.ts`, shown in the administration
# too). On ufw:
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
# It does not install Node (Gilbert needs the LTS line, 24 today) and it does
# not put a reverse proxy in front: both are stated in the README
# ("Deploying"). It targets Debian and Ubuntu.
#
# Usage, as root (or with sudo):
#
#   sudo ./install/install.sh
#
# Set GILBERT_APP to the checkout if this script is run from elsewhere, and
# GILBERT_USER to the account the services run as (default: the user who
# invoked sudo, else `gilbert`).
set -euo pipefail

# --- what to install, and where ---------------------------------------------
APP="${GILBERT_APP:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}"
# The account the two services run as. It must be able to read the checkout.
USER_NAME="${GILBERT_USER:-${SUDO_USER:-gilbert}}"
# The environment file the application reads at boot: the handshake (the
# Stalwart URL, and the Master when this deployment runs an agent) and anything
# else this deployment states. See `.env.example`.
ENV_FILE="${GILBERT_ENV:-/etc/gilbert.env}"
# Where Janus is installed. `/usr/local` so the `janus` binary and its config
# land on the usual paths.
PREFIX="${GILBERT_JANUS_PREFIX:-/usr/local}"
# The bridge's config, beside Janus's own.
JANUS_ETC="$PREFIX/etc/janus"
UNIT_DIR="${GILBERT_UNIT_DIR:-/etc/systemd/system}"

say() { printf '==> %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (or with sudo)."
command -v apt-get >/dev/null || die "this installer targets Debian and Ubuntu (apt-get not found)."
command -v node >/dev/null || die "Node is not installed. Gilbert needs the LTS line (24); install it first (see the README)."
command -v npm >/dev/null || die "npm is not installed."
[ -f "$APP/package.json" ] || die "$APP is not a Gilbert checkout (no package.json)."

# --- the bridge's version ----------------------------------------------------
# One pin, in the tree, ours to bump. The build below reads it from there, so
# the version this installs and the version in the release notes are the same.
JANUS_VERSION="$(tr -d '[:space:]' < "$APP/deploy/janus/VERSION")"
[ -n "$JANUS_VERSION" ] || die "deploy/janus/VERSION is empty."

say "installing build dependencies"
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl autoconf automake libtool pkg-config \
  gcc g++ make cmake gengetopt \
  libglib2.0-dev libjansson-dev libconfig-dev libssl-dev libsrtp2-dev \
  libnice-dev libcurl4-openssl-dev libsofia-sip-ua-dev libopus-dev \
  libogg-dev libwebsockets-dev

# --- the application ---------------------------------------------------------
say "building Gilbert"
( cd "$APP" && npm ci --ignore-scripts && npm run build )

# --- the bridge --------------------------------------------------------------
# Built from the pinned upstream release, with only the two plugins the phone
# uses (sip and echotest) and only the WebSocket transport. `make install`
# puts the binary and the plugin/transport libraries under the prefix.
if [ ! -x "$PREFIX/bin/janus" ] || [ "${GILBERT_JANUS_REBUILD:-0}" = "1" ]; then
  say "building Janus $JANUS_VERSION"
  build_dir="$(mktemp -d)"
  trap 'rm -rf "$build_dir"' EXIT
  curl -fsSL "https://github.com/meetecho/janus-gateway/archive/refs/tags/${JANUS_VERSION}.tar.gz" \
    | tar xz -C "$build_dir"
  (
    cd "$build_dir"/janus-gateway-*
    ./autogen.sh
    ./configure --prefix="$PREFIX" \
      --disable-docs --disable-data-channels \
      --disable-all-plugins --enable-plugin-sip --enable-plugin-echotest \
      --disable-all-transports --enable-websockets \
      --disable-all-handlers --disable-all-loggers \
      --disable-all-js-modules
    make -j"$(nproc)"
    make install
    # The licence of the daemon we built, kept beside it (GPL-3.0).
    mkdir -p "$PREFIX/share/janus"
    cp COPYING "$PREFIX/share/janus/COPYING"
  )
else
  say "Janus $JANUS_VERSION already built (GILBERT_JANUS_REBUILD=1 to rebuild)"
fi

# --- the bridge's configuration ---------------------------------------------
say "writing $JANUS_ETC"
mkdir -p "$JANUS_ETC"
# The media range is generated from its one definition, so the ports an
# operator opens and the ports Janus binds cannot drift apart.
node "$APP/scripts/janusConfig.mjs" "$JANUS_ETC/janus.jcfg"
cp "$APP/deploy/janus/janus.transport.websockets.jcfg" \
   "$APP/deploy/janus/janus.plugin.sip.jcfg" \
   "$APP/deploy/janus/janus.plugin.echotest.jcfg" \
   "$JANUS_ETC/"

# --- the services ------------------------------------------------------------
say "installing systemd services ($UNIT_DIR)"
install -d "$UNIT_DIR"
for unit in gilbert-janus.service gilbert.service; do
  sed -e "s#@USER@#${USER_NAME}#g" \
      -e "s#@APP@#${APP}#g" \
      -e "s#@ENV@#${ENV_FILE}#g" \
      -e "s#@NODE@#$(command -v node)#g" \
      "$APP/install/$unit" > "$UNIT_DIR/$unit"
done
systemctl daemon-reload
systemctl enable --now gilbert-janus.service
systemctl enable --now gilbert.service

# --- what is left for the operator -------------------------------------------
cat <<EOF

==> installed.

  the application   systemctl status gilbert.service
  the bridge        systemctl status gilbert-janus.service
  the environment   $ENV_FILE   (start from .env.example)

Two things are the operator's, and the README covers both:

  1. a reverse proxy in front of the application (see Caddyfile.example /
     nginx.example.conf). The application listens on 127.0.0.1:8080 by default.

  2. THE PHONE'S MEDIA PORTS. Open the bridge's UDP range inbound, and open it
     in any cloud firewall too:

         ufw allow 10000:10200/udp

     Nothing else is opened: the Janus API is loopback-only, and the SIP leg to
     the provider is outbound, so 5060/5061 stay closed.

     If the range is closed, the phone does not appear at all — that is the
     design, not a failure: the client proves the media path before offering
     the phone, so a bridge whose ports are shut shows no phone.

EOF
