#!/bin/bash
# Install Gilbert on a host, without Docker.
#
# WHAT THIS INSTALLS
#
# Gilbert is a Node process served behind a reverse proxy. This script builds
# the checkout, installs it as a systemd service (`gilbert.service`) and writes
# the environment file the process reads at boot.
#
# IT LAYERS OVER YOUR UNIT. If the host already runs its own `gilbert.service`,
# that unit stays: its ExecStart, its User, its paths. This script writes only
# the hardening drop-in beside it (`gilbert.service.d/10-hardening.conf`), so
# the posture is ours and the unit is yours. A host with no unit gets ours too.
#
# WHAT THIS DOES NOT DO
#
# It does not install Node (Gilbert needs the LTS line, 24 today) and it does
# not put a reverse proxy in front: both are stated in INSTALL.md. It targets
# Linux.
#
# Usage, as root (or with sudo):
#
#   sudo ./install/install.sh
#
# Set GILBERT_APP to the checkout if this script is run from elsewhere,
# GILBERT_USER to the account the service runs as (default: the user who invoked
# sudo, else `gilbert`). GILBERT_ENV and GILBERT_UNIT_DIR move the environment
# file and the unit directory; the variables below say what each is for.
set -euo pipefail

# --- what to install, and where ---------------------------------------------
APP="${GILBERT_APP:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}"
# The account the service runs as. Prefer the user who invoked sudo (they own
# the checkout); fall back to a system account this script creates if needed.
USER_NAME="${GILBERT_USER:-${SUDO_USER:-gilbert}}"
# The environment file the application reads at boot: the handshake (the
# Stalwart URL, and the Master when this deployment runs an agent) and anything
# else this deployment states. See `.env.example`.
ENV_FILE="${GILBERT_ENV:-/etc/gilbert.env}"
UNIT_DIR="${GILBERT_UNIT_DIR:-/etc/systemd/system}"

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
    || warn "could not create $USER_NAME; the service may refuse to start"
fi
# The app only reads these; root's build outputs are world-readable anyway, but
# handing them over keeps a write from ever needing a privilege.
chown -R "$USER_NAME" "$APP/node_modules" "$APP/web/dist" "$APP/server/dist" \
  2>/dev/null || true

# --- the service -------------------------------------------------------------
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
systemctl daemon-reload

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

One thing is the operator's, and INSTALL.md covers it:

  1. a reverse proxy in front of the application (see Caddyfile.example /
     nginx.example.conf). The application listens on 127.0.0.1:8080 by default.

EOF
